import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { buildConversationContext, server } from "../src/opencode/server.js";
import { effectivePrompt, graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, renderStructuredEvent, tui, usageLine, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, listAllRuns, listProjectRuns, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readStoredRun, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { flattenSchemaLines, renderSchemaInput, renderSchemaOutput, renderSchemaText } from "../src/opencode/schema-view.js";
import { commandModel, loadConnectorDefinition, typedConfigFile, withSolutionRoleModelAssignments, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { AgentUsage, ConnectorDefinition } from "../src/core/types.js";
import { applyBatchRecords, completeVerification, ensureRunnableWork, initialNetwork, mergeRefinementOutput, mergeSolutionDelta, nextQueuedActivation, propagateNetwork, reopenRegion, selectActivationBatch, validateRefinementOutput, validateSolutionDelta } from "../src/core/solution-lod/reducer.js";
import { projectActivationContext, solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { SOLUTION_ROLE_CONTRACTS } from "../src/core/solution-lod/roles.js";
import type { ActivationTaskResult, RefinementOutput, SolutionLodState } from "../src/core/solution-lod/types.js";
import { DurableFileSaver } from "../src/core/durable-checkpointer.js";
import { acquireWorktree } from "../src/opencode/worktree-lock.js";
import { prepareVerifierWorkspace, releaseVerifierWorkspace } from "../src/opencode/verifier-workspace.js";

const temporaryDirectories = new Set<string>();
function temp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function graph(terminates = true) {
  const State = Annotation.Root({ result: Annotation<string> });
  const builder = new StateGraph(State).addNode("work", () => ({ result: "ok" })).addEdge(START, "work");
  if (terminates) builder.addEdge("work", END);
  return builder.compile({ checkpointer: new MemorySaver() });
}

describe("typed graph validation", () => {
  it("publishes separate server and TUI plugin targets with a path-compatible server entry", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { main?: string; exports?: Record<string, string> };
    expect(manifest.main).toBe("./dist/src/opencode/server.js");
    expect(manifest.exports?.["./server"]).toBe("./dist/src/opencode/server.js");
    expect(manifest.exports?.["./tui"]).toBe("./dist/src/opencode/tui.js");
  });

  it("accepts a compiled terminating graph with valid references", async () => {
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false } } },
      graphs: { default: { graph: graph(), initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect(await validateConnector(definition)).toEqual([]);
  });

  it("reports model references and missing checkpoint persistence", async () => {
    const State = Annotation.Root({ result: Annotation<string> });
    const compiled = new StateGraph(State).addNode("work", () => ({ result: "ok" })).addEdge(START, "work").addEdge("work", END).compile();
    const definition: ConnectorDefinition = {
      version: 1,
      models: {},
      agents: { worker: { model: "missing", systemPrompt: "work" } },
      graphs: { default: { graph: compiled, initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect((await validateConnector(definition)).map((item) => item.code)).toEqual(expect.arrayContaining(["REFERENCE", "GRAPH"]));
  });

  it("rejects non-positive agent timeout settings", async () => {
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 0, maxRuntimeMs: -1 } },
      graphs: { default: { graph: graph(), initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect((await validateConnector(definition)).map((item) => item.path)).toEqual(expect.arrayContaining(["agents.worker.inactivityTimeoutMs", "agents.worker.maxRuntimeMs"]));
  });

  it("uses the production solution-LOD workflow as the zero-config preset", async () => {
    const project = temp("opencode-langgraph-config-");
    const definition = await loadConnectorDefinition(project);
    expect(definition.defaultGraph).toBe("solution-lod");
    for (const role of ["inspect", "synthesize", "refine", "implement", "verify", "present"]) {
      expect(definition.models[`${role}-model`]).toEqual({ backend: "opencode", model: "inherit" });
    }
    expect(definition.agents.inspect).toMatchObject({ model: "inspect-model", maxSteps: 32, tools: { read: true, bash: false, edit: false, task: false } });
    expect(definition.agents.synthesize).toMatchObject({ model: "synthesize-model", maxSteps: 8, tools: { read: false, bash: false } });
    expect(definition.agents.refine).toMatchObject({ model: "refine-model", maxSteps: 8, tools: { read: false, bash: false } });
    expect(definition.agents.verify).toMatchObject({ model: "verify-model", maxSteps: 16, tools: { bash: true, edit: false } });
    expect(definition.agents.implement).toMatchObject({ model: "implement-model", maxSteps: 32, tools: { task: false } });
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "solution-lod"');
    expect((await loadConnectorDefinition(project)).graphs["solution-lod"]).toBeDefined();
  });

  it("applies preset model and activation-quantum overrides", async () => {
    const project = temp("opencode-langgraph-options-");
    const file = writeConnectorConfig(project);
    fs.writeFileSync(file, `import { defineOpenCodeLangGraph } from "opencode-langgraph";\nexport default defineOpenCodeLangGraph({ version: 1, preset: "solution-lod", options: { models: { inspect: "provider/cheap", implement: "provider/strong" }, roleLimits: { inspect: { maxTurns: 3 } } } });\n`);
    const definition = await loadConnectorDefinition(project);
    expect(definition.models["inspect-model"]).toEqual({ backend: "opencode", model: "provider/cheap" });
    expect(definition.models["implement-model"]).toEqual({ backend: "opencode", model: "provider/strong" });
    expect(definition.agents.inspect.maxSteps).toBe(3);
    const initial = definition.graphs["solution-lod"].initial({ task: "x", directory: project, worktree: project, runId: "x" }) as SolutionLodState;
    expect(initial.stateVersion).toBe(5);
  });

  it("applies per-session role assignments without changing the configured definition", async () => {
    const project = temp("solution-lod-model-proxy-");
    const definition = await loadConnectorDefinition(project);
    const assigned = withSolutionRoleModelAssignments(definition, {
      inspect: { backend: "opencode", model: "provider/fast" },
      implement: commandModel({ command: "codex", args: ["exec"] }),
    });
    expect(assigned.models["inspect-model"]).toEqual({ backend: "opencode", model: "provider/fast" });
    expect(assigned.models["implement-model"]).toEqual({ backend: "command", command: "codex", args: ["exec"] });
    expect(definition.models["inspect-model"]).toEqual({ backend: "opencode", model: "inherit" });
  });
});

describe("OpenCode child-session runtime", () => {
  it("maps inherited model and agent settings into an isolated child session", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const events: unknown[] = [];
    let messagePolls = 0;
    const client = { session: {
      create: async (value: unknown) => { calls.push({ name: "create", value }); return { data: { id: "child-1" } }; },
      promptAsync: async (value: unknown) => { calls.push({ name: "prompt", value }); return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: messagePolls++ ? [{ info: { role: "assistant" }, parts: [{ type: "text", text: "actual answer" }] }] : [] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { planner: { model: "current", opencodeAgent: "plan", systemPrompt: "system", tools: { edit: false, question: false } } },
      graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({
      plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" },
      directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event),
    });
    expect(await runtime.call({ agent: "planner", node: "plan", prompt: "prompt", state: {} })).toEqual({ text: "actual answer", sessionId: "child-1" });
    expect(calls[0].value).toMatchObject({ body: { parentID: "root" } });
    expect(calls[1].value).toMatchObject({ body: { agent: "plan", model: { providerID: "p", modelID: "m" }, system: "system", tools: { edit: false, question: false } } });
    expect(messagePolls).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: "plan", status: "active", state: {}, prompt: { system: "system", input: "prompt" } }),
      expect.objectContaining({ node: "plan", status: "completed", text: "actual answer", state: {} }),
    ]));
  });

  it("streams a live token estimate only while the assistant answer is unfinished", async () => {
    const events: Array<{ status: string; usage?: AgentUsage; streaming?: { inputEstimated: number; outputEstimated: number } }> = [];
    let polls = 0;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: polls < 4 ? { child: { type: "busy" } } : {} }),
      messages: async () => {
        polls++;
        if (polls <= 3) return { data: [{ info: { id: "a1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "x".repeat(400 * polls) }] }] };
        return { data: [{ info: { id: "a1", role: "assistant", finish: "stop", tokens: { input: 900, output: 100, cache: { read: 3_000 } } }, parts: [{ id: "p1", type: "text", text: "final answer" }] }] };
      },
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = {
      version: 1, models: { current: { backend: "opencode", model: "inherit" } },
      agents: { planner: { model: "current", systemPrompt: "system" } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({
      plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" },
      directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event),
    });
    const result = await runtime.call({ agent: "planner", node: "plan", prompt: "prompt", state: {} });
    expect(result.text).toBe("final answer");
    expect(result.usage).toEqual({ turns: 1, input: 900, output: 100, reasoning: 0, cacheRead: 3_000, cacheWrite: 0, cost: 0 });
    expect("streaming" in result).toBe(false);
    expect(events[0]).toMatchObject({ status: "active", streaming: { inputEstimated: 3, outputEstimated: 0 } });
    const withEstimate = events.filter((event) => event.streaming);
    expect(withEstimate).toHaveLength(2);
    expect(withEstimate[1]).toMatchObject({ status: "active", usage: { turns: 0 }, streaming: { inputEstimated: 3, outputEstimated: 100 } });
    const completed = events.at(-1);
    expect(completed).toMatchObject({ status: "completed", usage: { turns: 1, input: 900, cacheRead: 3_000 } });
    expect(completed?.streaming).toBeUndefined();
    const afterFinish = events.filter((event) => event.usage?.turns === 1);
    expect(afterFinish.every((event) => event.streaming === undefined)).toBe(true);
  });

  it("runs command models through stdin", async () => {
    const dir = temp("opencode-langgraph-command-");
    const executable = path.join(dir, "agent");
    fs.writeFileSync(executable, "#!/bin/sh\nread value\nprintf 'seen: %s' \"$value\"\n", { mode: 0o755 });
    const definition: ConnectorDefinition = {
      version: 1, models: { cli: { backend: "command", command: executable } },
      agents: { worker: { model: "cli", systemPrompt: "system" } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({ plugin: {} as never, definition, parentSessionId: "root", directory: dir, worktree: dir, signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "work", prompt: "task", state: {} })).resolves.toMatchObject({ text: "seen: system" });
  });

  it("passes JSON Schema as a portable OpenCode prompt contract and accepts structured data", async () => {
    let prompt: any;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async (value: unknown) => { prompt = value; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant", structured: { decision: "go" } }, parts: [] }] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: { question: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(prompt.body.format).toBeUndefined();
    expect(prompt.body.parts[0].text).toContain("Return only a JSON value matching this JSON Schema");
  });

  it("retries truncated structured JSON in the same child session", async () => {
    const prompts: any[] = [];
    const malformed = { info: { id: "bad", role: "assistant" }, parts: [{ id: "bad-text", type: "text", text: '{"decision":"go"' }] };
    const repaired = { info: { id: "good", role: "assistant" }, parts: [{ id: "good-text", type: "text", text: '{"decision":"go"}' }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async (value: unknown) => { prompts.push(value); },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: prompts.length < 2 ? [malformed] : [malformed, repaired] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: {}, maxSteps: 2 } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" }, sessionId: "child" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.parts[0].text).toContain("Your previous JSON failed validation");
    expect(prompts[1].body.parts[0].text).toContain("ORIGINAL INPUT\ngo?");
  });

  it("retries valid JSON that fails the typed output contract", async () => {
    const prompts: any[] = [];
    const wrong = { info: { id: "wrong", role: "assistant" }, parts: [{ id: "wrong-text", type: "text", text: '{"decision":"stop"}' }] };
    const repaired = { info: { id: "good", role: "assistant" }, parts: [{ id: "good-text", type: "text", text: '{"decision":"go"}' }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }), promptAsync: async (value: unknown) => { prompts.push(value); }, status: async () => ({ data: {} }),
      messages: async () => ({ data: prompts.length < 2 ? [wrong] : [wrong, repaired] }), abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: {}, maxSteps: 2 } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    const validateStructured = (value: unknown) => {
      if ((value as { decision?: string }).decision !== "go") throw new Error("decision must be go");
      return value;
    };
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" }, validateStructured })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.parts[0].text).toContain("ORIGINAL INPUT\ngo?");
    expect(prompts[1].body.parts[0].text).toContain("VALIDATION ERROR\ndecision must be go");
    expect(prompts[1].body.parts[0].text).toContain('PREVIOUS INVALID OUTPUT\n{"decision":"stop"}');
  });

  it("keeps a child session alive while tool activity advances", async () => {
    let polls = 0;
    let aborted = false;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: polls < 4 ? { child: { type: "busy" } } : {} }),
      messages: async () => ({ data: polls++ < 4
        ? [{ info: { id: `assistant-${polls}`, role: "assistant" }, parts: [{ id: `reasoning-${polls}`, type: "reasoning", text: `step ${polls}` }] }]
        : [{ info: { id: "assistant-final", role: "assistant" }, parts: [{ id: "text-final", type: "text", text: "done" }] }] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };
    const definition: ConnectorDefinition = {
      version: 1, models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 25, maxRuntimeMs: 500 } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} })).resolves.toMatchObject({ text: "done" });
    expect(polls).toBeGreaterThan(4);
    expect(aborted).toBe(false);
  });

  it("aborts a child session only after genuine inactivity", async () => {
    let aborted = false;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }), promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: { child: { type: "busy" } } }),
      messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant" }, parts: [{ id: "reasoning", type: "reasoning", text: "unchanged" }] }] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };
    const definition: ConnectorDefinition = {
      version: 1, models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 25, maxRuntimeMs: 500 } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} })).rejects.toThrow("was inactive for 25ms");
    expect(aborted).toBe(true);
  });

  it("accounts completed model steps and enforces the configured ceiling only while busy", async () => {
    const run = async (busy: boolean) => {
      let aborted = false;
      const client = { session: {
        create: async () => ({ data: { id: "child" } }), promptAsync: async () => ({ data: undefined }),
        status: async () => ({ data: busy ? { child: { type: "busy" } } : {} }),
        messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant", finish: "stop", cost: .01, tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 40, write: 1 } } }, parts: [{ type: "text", text: "done" }] }] }),
        abort: async () => { aborted = true; return { data: true }; },
      } };
      const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, maxSteps: 1 } }, graphs: {}, defaultGraph: "default" };
      const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
      return { result: runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} }), aborted: () => aborted };
    };
    const idle = await run(false);
    await expect(idle.result).resolves.toMatchObject({ text: "done", usage: { turns: 1, input: 12, output: 3, reasoning: 2, cacheRead: 40, cacheWrite: 1, cost: .01 } });
    expect(idle.aborted()).toBe(false);
    const busy = await run(true);
    await expect(busy.result).resolves.toMatchObject({ budgetStop: { metric: "turns", used: 1, limit: 1 } });
    expect(busy.aborted()).toBe(true);
  });

  it("forks explicit branch context and reports only delta usage and tools", async () => {
    const old = { info: { id: "old", role: "assistant", finish: "stop", cost: .1, tokens: { input: 100, cache: { read: 500 } } }, parts: [{ id: "old-tool", type: "tool", tool: "read", state: { status: "completed", title: "old", input: {} } }] };
    const fresh = { info: { id: "new", role: "assistant", finish: "stop", cost: .01, tokens: { input: 12, output: 3, cache: { read: 40 } } }, parts: [{ id: "new-tool", type: "tool", tool: "grep", state: { status: "completed", title: "new", input: { pattern: "x" } } }, { id: "new-text", type: "text", text: "done" }] };
    let forkBody: { messageID?: string } | undefined;
    let forkedMessageCalls = 0;
    const client = { session: {
      fork: async (input: { body?: { messageID?: string } }) => { forkBody = input.body; return { data: { id: "forked" } }; }, promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }),
      messages: async (input: { path: { id: string } }) => ({ data: input.path.id === "parent" ? [old] : forkedMessageCalls++ === 0 ? [old] : [old, fresh] }), abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { scout: { model: "current", systemPrompt: "scout", tools: { edit: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    const result = await runtime.call({ agent: "scout", node: "scout:p2", prompt: "inspect", state: {}, session: { strategy: "fork", sessionId: "parent" } });
    expect(result).toMatchObject({ sessionId: "forked", usage: { turns: 1, input: 12, output: 3, cacheRead: 40 }, tools: [{ tool: "grep", title: "new" }] });
    expect(forkBody).toBeUndefined();
    expect(result.usage?.cost).toBeCloseTo(.01);
  });

  it("forks before an aborted turn and ignores inherited answers while the new prompt starts", async () => {
    const user = { info: { id: "user", role: "user" }, parts: [{ id: "user-part", type: "text", text: "start" }] };
    const completed = { info: { id: "completed", role: "assistant", finish: "tool-calls" }, parts: [{ id: "completed-part", type: "text", text: "partial" }] };
    const aborted = { info: { id: "aborted", role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] };
    const answer = { info: { id: "answer", role: "assistant", finish: "stop" }, parts: [{ id: "answer-part", type: "text", text: "resumed" }] };
    let forkBody: { messageID?: string } | undefined;
    let forkedMessageCalls = 0;
    const client = { session: {
      fork: async (input: { body?: { messageID?: string } }) => { forkBody = input.body; return { data: { id: "forked" } }; },
      promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }), abort: async () => ({ data: true }),
      messages: async (input: { path: { id: string } }) => {
        if (input.path.id === "parent") return { data: [user, completed, aborted] };
        return { data: forkedMessageCalls++ < 2 ? [user, completed] : [user, completed, answer] };
      },
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { scout: { model: "current", systemPrompt: "scout", tools: {} } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "scout", node: "scout:p1", prompt: "continue", state: {}, session: { strategy: "fork", sessionId: "parent" } })).resolves.toMatchObject({ text: "resumed", sessionId: "forked" });
    expect(forkBody).toEqual({ messageID: "aborted" });
  });
});

describe("solution LOD reducer", () => {
  const state = (): SolutionLodState => ({
    stateVersion: 5, runId: "run", originalTask: "change", conversationContext: "prior decision", directory: "/repo", worktree: "/repo", phase: "forming-root-domain", activeBatch: [], results: [],
    network: initialNetwork("change"), usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, worktreeAcquired: false, result: "",
  });
  const candidate = (key: string, proposition: string, outcome: "possible" | "eliminated" | "selected" | "equivalent" = "possible") => ({ key, proposition, outcome, reasons: [], evidenceRefs: [] });
  const contract = (acceptanceCriteria: string[], coveredCriteria = acceptanceCriteria.map((_, index) => index)) => ({ delivery: "change" as const, allowedVariables: [], acceptanceCriteria, coveredCriteria });
  const terminal = (acceptanceCriteria: string[]): RefinementOutput => ({ evidence: [], children: [], activations: [] });
  const selectDelta = (network: SolutionLodState["network"], activationId: string, ...keys: string[]) => {
    const merged = mergeSolutionDelta({ stateVersion: 5, runId: "run", originalTask: "change", conversationContext: "", directory: "/repo", worktree: "/repo", phase: "", network, usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, worktreeAcquired: false, result: "" } as SolutionLodState, activationId, {
      region: {}, evidence: [], constraints: [], activations: [], select: keys,
      candidates: keys.map((key) => candidate(key, `${key} approach`, "selected")),
    });
    const activation = merged.activations.find((item) => item.id === activationId);
    if (activation) activation.status = "completed";
    return merged;
  };
  const pushActivation = (network: SolutionLodState["network"], capability: "synthesize" | "refine" | "inspect", regionId: string, id: string) => {
    network.activations.push({ id, capability, regionId, request: capability, expectedDelta: `${capability}:${regionId}:${id}`, contextRefs: [regionId], status: "running", basisRevision: network.revision });
    network.regions.find((region) => region.id === regionId)?.activationIds.push(id);
  };

  it("keeps a criterion-less selection unrefined until refinement splits it", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], activations: [],
      candidates: [candidate("adapter", "Use an adapter", "selected"), candidate("rewrite", "Rewrite the subsystem")],
      select: ["adapter"],
    });
    merged.activations[0].status = "completed";
    expect(merged.regions.find((region) => region.id === "r1")?.status).toBe("unrefined");
    expect(merged.regions.filter((region) => region.parentId === "r1")).toHaveLength(0);
    expect(nextQueuedActivation(ensureRunnableWork(merged).network)).toMatchObject({ capability: "refine", regionId: "r1" });
  });

  it("declares a single-criterion selection actionable without refinement, and a multi-criterion one not", () => {
    const current = state();
    current.network.activations[0].status = "completed";
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["target updated"] }, evidence: [], constraints: [], activations: [],
      candidates: [candidate("direct", "Direct change", "selected")], select: ["direct"],
    });
    expect(merged.regions[0]).toMatchObject({ status: "actionable" });
    expect(nextQueuedActivation(ensureRunnableWork(merged).network)).toMatchObject({ capability: "implement", regionId: "r1" });
    merged.regions[0].acceptanceCriteria = ["target updated", "docs updated"];
    const rescheduled = ensureRunnableWork(merged);
    expect(rescheduled.network.regions[0].status).toBe("unrefined");
    expect(nextQueuedActivation(rescheduled.network)).toMatchObject({ capability: "refine" });
  });

  it("materializes refined children, collapses the parent, and inspects each child before synthesis", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "direct");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [
        { key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: ["mapping contract"], acceptanceCriteria: ["mapping is explicit"], coveredCriteria: [0] },
        { key: "docs", objective: "Update docs", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["docs mention mapping"], coveredCriteria: [0] },
      ],
    });
    expect(current.network.regions.find((region) => region.id === "r1")?.status).toBe("collapsed");
    const children = current.network.regions.filter((region) => region.parentId === "r1");
    expect(children.map((region) => region.key)).toEqual(["mapping", "docs"]);
    expect(children.every((region) => region.status === "unformed" && region.lod === 1)).toBe(true);
    const scheduled = ensureRunnableWork(current.network);
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "inspect", regionId: children[0].id });
  });

  it("promotes an inspected child to synthesis only after its facts land", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "direct");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [{ key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }],
    });
    const child = current.network.regions.find((region) => region.parentId === "r1")!;
    pushActivation(current.network, "inspect", child.id, "a3");
    current.network = mergeSolutionDelta(current, "a3", { region: {}, evidence: [{ text: "mapping lives in config", source: "config.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] });
    expect(current.network.regions.find((region) => region.id === child.id)?.status).toBe("superposed");
    expect(nextQueuedActivation(ensureRunnableWork(current.network).network)).toMatchObject({ capability: "synthesize", regionId: child.id });
  });

  it("drops stale refinement children and the contract when synthesis chooses anew", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "adapter");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [{ key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }],
    });
    current.network = selectDelta(current.network, "a1", "rewrite");
    expect(current.network.regions.filter((region) => region.parentId === "r1")).toHaveLength(0);
    expect(current.network.regions[0]).toMatchObject({ status: "unrefined" });
    expect(current.network.regions[0].selectedCandidateIds).toEqual(["r1:rewrite"]);
  });

  it("rejects refinements that do not split into covering, self-carrying children", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "direct");
    current.network.regions[0].acceptanceCriteria = ["works", "documented"];
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [], activations: [] })).toThrow(/split the work into its next steps/);
    const child = (key: string, coveredCriteria: number[], acceptanceCriteria: string[] = ["child done"]) => ({ key, objective: `${key} work`, edge: "partOf" as const, allowedVariables: [], acceptanceCriteria, coveredCriteria });
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [])], activations: [] })).toThrow(/does not address any known success criterion/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0])], activations: [] })).toThrow(/collectively cover/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0]), child("left", [1])], activations: [] })).toThrow(/distinct stable name/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0], []), child("right", [0, 1])], activations: [] })).toThrow(/carries no success criterion/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0]), child("right", [0, 1])], activations: [] })).not.toThrow();
  });

    it("collapses a repository-backed read-only answer without synthesis or a child LOD, then verifies it", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" },
      evidence: [{ text: "The marker says ready", source: "SMOKE.md:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "ready", acceptanceCriteria: ["Report the marker exactly"], evidenceRefs: ["SMOKE.md:1"] },
    });
    expect(network.regions).toHaveLength(1);
    expect(network.regions[0]).toMatchObject({ delivery: "answer", status: "implemented", answer: "ready", selectedCandidateIds: ["r1:resolved-answer"] });
    expect(network.candidates[0]).toMatchObject({ status: "selected", evidenceIds: ["e1"] });
    network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "verify", status: "queued" });
    const verified = completeVerification(scheduled.network, scheduled.network.activations.at(-1)!.id, { verdict: "pass", summary: "", findings: [], checks: [], activations: [] });
    expect(verified.regions[0].status).toBe("verified");
    expect(ensureRunnableWork(verified).done).toBe(true);
  });

  it("rejects a resolved answer that cites no real fact", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", {
      region: { delivery: "answer" },
      evidence: [], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Trust me.", acceptanceCriteria: ["answered"], evidenceRefs: [] },
    })).toThrow(/cite at least one real fact/);
    expect(() => validateSolutionDelta(current, "r1", {
      region: { delivery: "answer" },
      evidence: [{ text: "fact", source: "a.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Grounded.", acceptanceCriteria: ["answered"], evidenceRefs: ["a.ts:1"] },
    })).not.toThrow();
  });

  it("queues verification for a directly-resolved answer", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" },
      evidence: [{ text: "The section is already fully implemented", source: "TODO.md:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Already complete.", acceptanceCriteria: ["confirmed implemented"], evidenceRefs: ["TODO.md:1"] },
    });
    expect(network.regions[0]).toMatchObject({ delivery: "answer", status: "implemented", answer: "Already complete." });
    network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "verify", status: "queued" });
  });

  it("allows independent regions to remain at different LODs", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "composed");
    current.network.regions.push(
      { ...current.network.regions[0], id: "r2", key: "api", parentId: "r1", edge: "partOf" as const, lod: 1, status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], artifactIds: [] },
      { ...current.network.regions[0], id: "r3", key: "storage", parentId: "r1", edge: "partOf" as const, lod: 1, status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], artifactIds: [] },
    );
    const api = current.network.regions.find((region) => region.key === "api")!;
    pushActivation(current.network, "synthesize", api.id, "a99");
    current.network = selectDelta(current.network, "a99", "direct");
    expect(current.network.regions.find((region) => region.key === "api")?.status).toBe("unrefined");
    pushActivation(current.network, "refine", api.id, "a100");
    current.network = mergeRefinementOutput(current.network, "a100", { evidence: [], activations: [], children: [{ key: "ship", objective: "Ship the API work", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["API works"], coveredCriteria: [0] }] });
    expect(current.network.regions.find((region) => region.key === "api")?.status).toBe("collapsed");
    expect(current.network.regions.find((region) => region.key === "ship")?.status).toBe("unformed");
    expect(current.network.regions.find((region) => region.key === "storage")?.status).toBe("unformed");
  });

  it("propagates requires and refutes constraints to collapse", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [{ text: "rewrite is incompatible", source: "src/a.ts:1", kind: "repository" }], activations: [],
      candidates: [
        candidate("adapter", "Adapter"),
        candidate("rewrite", "Rewrite"),
      ], constraints: [{ kind: "refutes", subject: "e1", target: "rewrite", reason: "incompatible contract" }], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "rewrite")?.status).toBe("eliminated");
    expect(merged.candidates.find((candidate) => candidate.key === "adapter")?.status).toBe("selected");
    expect(merged.regions[0].status).toBe("actionable");
  });

  it("does not eliminate a refutes target when the refuting candidate is itself rejected", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        candidate("good", "Good"),
        { ...candidate("bad-a", "Bad A"), outcome: "eliminated" as const, reasons: ["violates contract"] },
        { ...candidate("bad-b", "Bad B"), outcome: "eliminated" as const, reasons: ["legacy path"] },
      ], constraints: [
        { kind: "refutes", subject: "bad-a", target: "good", reason: "bad-a disagrees" },
        { kind: "refutes", subject: "bad-b", target: "good", reason: "bad-b disagrees" },
      ], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "good")?.status).toBe("selected");
    expect(merged.regions[0].status).toBe("actionable");
  });

  it("still fires a refutes constraint from a non-candidate subject like task or evidence", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        candidate("kept", "Kept"),
        candidate("ruled-out", "Ruled out"),
      ], constraints: [{ kind: "refutes", subject: "task", target: "ruled-out", reason: "the request itself rules this out" }], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "ruled-out")?.status).toBe("eliminated");
    expect(merged.candidates.find((candidate) => candidate.key === "kept")?.status).toBe("selected");
  });

  it("demotes previously selected candidates when a resolved answer lands", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "inspect-then-split");
    const merged = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" }, evidence: [{ text: "Already covered", source: "src/x.spec.ts:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Already covered.", acceptanceCriteria: ["confirmed"], evidenceRefs: ["src/x.spec.ts:1"] },
    });
    const region = merged.regions[0];
    const selected = merged.candidates.filter((candidate) => candidate.regionId === region.id && candidate.status === "selected");
    expect(selected.map((candidate) => candidate.key)).toEqual(["resolved-answer"]);
    expect(merged.candidates.find((candidate) => candidate.key === "inspect-then-split")?.status).not.toBe("selected");
    expect(region.status).toBe("implemented");
  });

  it("rejects a delta that eliminates every candidate without a selection", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], select: [],
    });
    expect(() => validateSolutionDelta(current, current.network.regions[0].id, {
      evidence: [], constraints: [], activations: [], select: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["supporting evidence misread as defeater"], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "eliminated", reasons: ["supporting evidence misread as defeater"], evidenceRefs: [] },
      ],
    })).toThrow(/Every alternative/);
    expect(() => validateSolutionDelta(current, current.network.regions[0].id, {
      evidence: [], constraints: [], activations: [], select: ["alpha"],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "eliminated", reasons: ["genuine defeater"], evidenceRefs: [] },
      ],
    })).not.toThrow();
  });

  it("rejects an all-eliminating delta even when it selects an unknown candidate key", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [], constraints: [], select: [],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] }],
    });
    expect(() => validateSolutionDelta(current, "r1", {
      evidence: [], constraints: [], activations: [], select: ["ghost"],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["misread defeater"], evidenceRefs: [] }],
    })).toThrow(/Every alternative/);
    expect(() => validateSolutionDelta(current, "r1", {
      evidence: [], constraints: [], activations: [], select: ["alpha"],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["misread defeater"], evidenceRefs: [] }],
    })).not.toThrow();
  });

  it("resynthesizes a pruned region even when its completed synthesis activation survives", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], constraints: [], activations: [], select: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "possible", reasons: [], evidenceRefs: [] },
      ],
    });
    // Legacy end-state: the region's synthesis completed, then every candidate was eliminated.
    current.network.activations.push({ id: "a9", capability: "synthesize", regionId: "r1", request: "form domain", expectedDelta: "synthesis:r1", contextRefs: ["r1"], status: "completed", basisRevision: current.network.revision });
    for (const candidate of current.network.candidates) candidate.status = "eliminated";
    // Simulate pruneRun: reopen the region, keep only its completed activations, clear its activation list.
    const reopened = reopenRegion(current.network, "r1", "pruned for resynthesis");
    const pruned = {
      ...reopened,
      activations: reopened.activations.filter((item) => item.regionId !== "r1" || item.status === "completed"),
      regions: reopened.regions.map((item) => item.id === "r1" ? { ...item, activationIds: [] } : item),
    };
    const scheduled = ensureRunnableWork(pruned);
    expect(scheduled.blocked).toBeUndefined();
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "synthesize", regionId: "r1" });
  });

  it("canonicalizes region-prefixed candidate keys and drops dangling constraints", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "r1:direct", proposition: "Direct extension", outcome: "selected", reasons: [], evidenceRefs: [] }],
      constraints: [{ kind: "requires", subject: "imaginary-subject", target: "imaginary-target", reason: "decorative prose" }],
      select: ["r1:direct"],
    });
    expect(network.candidates.map((candidate) => candidate.id)).toEqual(["r1:direct"]);
    expect(network.regions[0].selectedCandidateIds).toEqual(["r1:direct"]);
    expect(network.constraints).toEqual([]);
  });

  it("never makes a bare selection actionable without a certified refinement", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], activations: [], select: ["direct"],
      candidates: [{ key: "direct", proposition: "Implement the selected family", outcome: "selected", reasons: [], evidenceRefs: [] }],
    });
    network.activations[0].status = "completed";
    expect(network.regions[0]).toMatchObject({ status: "unrefined" });
    expect(nextQueuedActivation(ensureRunnableWork(network).network)).toMatchObject({ capability: "refine" });
  });

  it("ignores resolvedAnswer injected into a change-delivery synthesis delta", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "change", acceptanceCriteria: ["files change"] }, evidence: [], constraints: [], activations: [], select: ["direct"],
      candidates: [{ key: "direct", proposition: "Implement it", outcome: "selected", reasons: [], evidenceRefs: [] }],
      resolvedAnswer: { answer: "Here is a plan", acceptanceCriteria: ["describe it"], evidenceRefs: [] },
    });
    expect(network.regions[0]).toMatchObject({ delivery: "change", status: "actionable", selectedCandidateIds: ["r1:direct"] });
    expect(network.regions[0].answer).toBeUndefined();
  });

  it("reopens one implicated region while preserving sibling verification and artifacts", () => {
    const network = initialNetwork("change");
    network.regions.push(
      { ...network.regions[0], id: "r2", key: "left", parentId: "r1", edge: "partOf", lod: 1, status: "verified", artifactIds: ["x1"], activationIds: [], candidateIds: [], selectedCandidateIds: [] },
      { ...network.regions[0], id: "r3", key: "right", parentId: "r1", edge: "partOf", lod: 1, status: "verified", artifactIds: ["x2"], activationIds: [], candidateIds: ["r3:choice"], selectedCandidateIds: ["r3:choice"] },
    );
    network.candidates.push({ id: "r3:choice", regionId: "r3", key: "choice", proposition: "choice", status: "selected", evidenceIds: [], eliminationReasons: [] });
    network.artifacts.push({ id: "x1", regionId: "r2", kind: "file", path: "left.ts", summary: "left", activationId: "a1" }, { id: "x2", regionId: "r3", kind: "file", path: "right.ts", summary: "right", activationId: "a1" });
    const reopened = reopenRegion(network, "r3", "criterion failed");
    expect(reopened.regions.find((region) => region.id === "r2")?.status).toBe("verified");
    expect(reopened.regions.find((region) => region.id === "r3")?.status).toBe("superposed");
    expect(reopened.artifacts.map((artifact) => artifact.path)).toEqual(["left.ts", "right.ts"]);
  });

  it("projects only referenced context and the collapsed ancestry", () => {
    const current = state();
    current.network.evidence.push({ id: "e1", text: "relevant", source: "a.ts", kind: "repository", fingerprint: "1" }, { id: "e2", text: "unrelated", source: "b.ts", kind: "repository", fingerprint: "2" });
    current.network.regions[0].evidenceIds.push("e1");
    const projection = JSON.stringify(projectActivationContext(current, current.network.activations[0]));
    expect(projection).toContain("prior decision");
    expect(projection).toContain("relevant");
    expect(projection).not.toContain("unrelated");
    expect(projection).not.toContain("nextActivationId");
  });

  it("gives agents concise role-native instructions instead of controller vocabulary", () => {
    for (const contract of Object.values(SOLUTION_ROLE_CONTRACTS)) {
      expect(contract.systemPrompt).not.toMatch(/\b(?:LOD|ancestry|region|collapsed|domain|activation|allowedVariables)\b/i);
      expect(contract.systemPrompt.length).toBeLessThan(900);
    }
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["target behavior works"];
    current.network.candidates.push({ id: "r1:direct", regionId: "r1", key: "direct", proposition: "Extend the existing implementation", status: "selected", evidenceIds: [], eliminationReasons: [] });
    current.network.regions[0].candidateIds = ["r1:direct"];
    current.network.regions[0].selectedCandidateIds = ["r1:direct"];
    const implement = { ...current.network.activations[0], capability: "implement" as const, request: "Implement the selected behavior" };
    const projection = projectActivationContext(current, implement);
    expect(projection).toMatchObject({
      goal: "change",
      successCriteria: ["target behavior works"],
      chosenApproach: ["Extend the existing implementation"],
    });
    expect(projection).not.toHaveProperty("decisionsAlreadyMade");
    expect(projection).not.toHaveProperty("region");
    expect(projection).not.toHaveProperty("collapsedAncestry");
    expect(projection).not.toHaveProperty("domain");
    expect(projection).not.toHaveProperty("availableCapabilities");
  });

  it("forms an unformed region by inspection before synthesis, then reports convergence instead of looping", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    network.regions[0].status = "superposed";
    const first = ensureRunnableWork(network);
    expect(first.network.activations.at(-1)).toMatchObject({ capability: "synthesize", status: "queued" });
    first.network.activations.at(-1)!.status = "completed";
    const second = ensureRunnableWork(first.network);
    expect(second.blocked).toContain("No activation can make a novel state delta");
    expect(second.network.activations).toHaveLength(2);
  });

  it("schedules inspection for an unformed region before any synthesis", () => {
    const current = state();
    current.network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(current.network);
    expect(scheduled.done).toBe(false);
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "inspect", regionId: "r1" });
  });

  it("reschedules a failed implement activation instead of dead-ending", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    network.regions[0].delivery = "change";
    network.regions[0].candidateIds = ["r1:direct"];
    network.regions[0].selectedCandidateIds = ["r1:direct"];
    network.regions[0].acceptanceCriteria = ["works"];
    network.candidates.push({ id: "r1:direct", regionId: "r1", key: "direct", proposition: "implement it", status: "selected", evidenceIds: [], eliminationReasons: [] });
    network.activations.push({ id: "a2", capability: "implement", regionId: "r1", request: "implement", expectedDelta: `implement:r1:${network.revision}`, contextRefs: ["r1"], status: "failed", basisRevision: network.revision });
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.regions[0].status).toBe("actionable");
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "implement", status: "queued" });
  });

  it("collapses an equivalent surviving set as one implementer-local choice", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["behavior is equivalent"] }, evidence: [], activations: [],
      candidates: [
        { key: "a", proposition: "Equivalent implementation A", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "b", proposition: "Equivalent implementation B", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [{ kind: "equivalent", subject: "a", target: "b", reason: "same external contract" }], select: ["a"],
    });
    expect(network.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:a", "r1:b"] });
  });

  it("rejects multiple selected non-equivalent alternatives in one region", () => {
    const current = state();
    const invalid = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["one coherent design"] }, evidence: [], constraints: [], activations: [],
      candidates: [
        { key: "event-shape", proposition: "Choose an event shape", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "duplicate-policy", proposition: "Choose a duplicate policy", outcome: "selected", reasons: [], evidenceRefs: [] },
      ], select: ["event-shape", "duplicate-policy"],
    });
    expect(invalid.regions[0]).toMatchObject({ status: "contradiction", selectedCandidateIds: [] });
    expect(invalid.regions[0].contradiction).toContain("Multiple incompatible alternatives");

    const correcting = { ...current, network: invalid };
    correcting.network.activations.push({ id: "a2", capability: "synthesize", regionId: "r1", request: "correct", expectedDelta: "coherent-domain", contextRefs: ["r1"], status: "running", basisRevision: invalid.revision });
    const corrected = mergeSolutionDelta(correcting, "a2", {
      region: {}, evidence: [], constraints: [], activations: [],
      candidates: [{ key: "coherent", proposition: "One complete event-store design", outcome: "selected", reasons: [], evidenceRefs: [] }], select: ["coherent"],
    });
    expect(corrected.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:coherent"] });
  });

  it("wakes a waiting activation only after its state predicate revision", () => {
    const network = initialNetwork("change");
    network.activations.push({ id: "a2", capability: "inspect", regionId: "r1", request: "wait", expectedDelta: "later fact", contextRefs: ["r1"], wakeCondition: { ref: "r1", revisionAfter: 1 }, status: "waiting", basisRevision: 0 });
    expect(propagateNetwork(network).activations.find((item) => item.id === "a2")?.status).toBe("waiting");
    network.revision = 2;
    expect(propagateNetwork(network).activations.find((item) => item.id === "a2")?.status).toBe("queued");
  });

  it("reopens the implicated region on a failed verification instead of dead-ending", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    network.regions[0].status = "implemented";
    network.regions[0].candidateIds = ["r1:choice", "r1:alt"];
    network.regions[0].selectedCandidateIds = ["r1:choice"];
    network.candidates.push(
      { id: "r1:choice", regionId: "r1", key: "choice", proposition: "chosen approach", status: "selected", evidenceIds: [], eliminationReasons: [] },
      { id: "r1:alt", regionId: "r1", key: "alt", proposition: "alternative approach", status: "possible", evidenceIds: [], eliminationReasons: [] },
    );
    network.activations.push({ id: "a2", capability: "verify", regionId: "r1", request: "verify", expectedDelta: "verification:r1", contextRefs: ["r1"], status: "running", basisRevision: 0 });
    const verified = completeVerification(network, "a2", { verdict: "fail", summary: "evidence contradicts the design", findings: [], checks: [], activations: [] });
    expect(verified.regions[0].status).toBe("superposed");
    expect(verified.regions[0].contradiction).toContain("evidence contradicts");
    const scheduled = ensureRunnableWork(verified);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "synthesize", status: "queued" });
  });

  it("treats transitively chained equivalence as one interchangeable set", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["one behavior"] }, evidence: [], activations: [],
      candidates: [
        { key: "a", proposition: "A", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "b", proposition: "B", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "c", proposition: "C", outcome: "selected", reasons: [], evidenceRefs: [] },
      ],
      constraints: [{ kind: "equivalent", subject: "a", target: "b", reason: "same" }, { kind: "equivalent", subject: "b", target: "c", reason: "same" }],
      select: ["a", "b", "c"],
    });
    expect(network.regions[0].status).not.toBe("contradiction");
    expect(network.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:a", "r1:b", "r1:c"] });
  });

  it("merges candidates whose keys normalize to the same slug instead of duplicating them", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        { key: "auth service", proposition: "Auth service", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "auth-service", proposition: "Auth service, refined", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], select: [],
    });
    expect(network.candidates).toHaveLength(1);
    expect(network.candidates[0]).toMatchObject({ id: "r1:auth-service", proposition: "Auth service, refined" });
  });

  it("batches queued read-only activations on pairwise distinct regions and keeps mutating work singleton", () => {
    const network = initialNetwork("task");
    for (const id of ["r2", "r3"]) network.regions.push({ id, key: id, parentId: "r1", edge: "partOf", lod: 1, objective: id, delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    const queued = (id: string, capability: Activation["capability"], regionId: string, basisRevision = 0) => network.activations.push({ id, capability, regionId, request: id, expectedDelta: id, contextRefs: [regionId], status: "queued", basisRevision });
    queued("a2", "inspect", "r2"); queued("a3", "inspect", "r3"); queued("a4", "synthesize", "r1"); queued("a5", "implement", "r3", 1);
    expect(selectActivationBatch(network, 4).map((item) => item.id)).toEqual(["a1", "a2", "a3"]);
    expect(selectActivationBatch(network, 2).map((item) => item.id)).toEqual(["a1", "a2"]);
    for (const item of network.activations) item.status = "completed";
    queued("a9", "implement", "r1", 5); queued("a10", "inspect", "r2", 5);
    expect(selectActivationBatch(network, 4).map((item) => item.id)).toEqual(["a9"]);
  });

  it("applies batch records in (basisRevision, activationId) order regardless of completion order", () => {
    const network = initialNetwork("task");
    network.activations.push({ id: "a2", capability: "inspect", regionId: "r1", request: "a2", expectedDelta: "a2", contextRefs: ["r1"], status: "running", basisRevision: 1 });
    const record = (activationId: string, basisRevision: number, text: string): ActivationTaskResult => ({
      activationId, regionId: "r1", capability: "inspect", basisRevision, startedAt: 0, finishedAt: 0,
      usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "applied", networkDelta: { kind: "delta", delta: { evidence: [{ text, source: text, kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] } },
    });
    const application = applyBatchRecords(network, [record("a2", 1, "second"), record("a1", 0, "first")]);
    expect(application.applied).toEqual(["a1", "a2"]);
    expect(application.network.evidence.map((item) => item.text)).toEqual(["first", "second"]);
    expect(application.network.activations.filter((item) => ["a1", "a2"].includes(item.id)).map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  it("marks a record superseded when its region disappeared from the current solution", () => {
    const network = mergeSolutionDelta(state(), "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "only", proposition: "Only path", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["only"],
    });
    network.activations[0].status = "completed";
    network.activations.push({ id: "a9", capability: "refine", regionId: "r1", request: "split", expectedDelta: "refine:r1", contextRefs: ["r1"], status: "running", basisRevision: network.revision });
    const split = mergeRefinementOutput(network, "a9", { evidence: [], activations: [], children: [{ key: "child", objective: "Child work", edge: "partOf", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }] });
    const child = split.regions.find((item) => item.key === "child")!;
    split.activations.push({ id: "a2", capability: "inspect", regionId: child.id, request: "a2", expectedDelta: "a2", contextRefs: [child.id], status: "running", basisRevision: split.revision });
    const reopened = reopenRegion(split, split.regions[0].id, "contradiction");
    const record: ActivationTaskResult = {
      activationId: "a2", regionId: child.id, capability: "inspect", basisRevision: 1, startedAt: 0, finishedAt: 0,
      usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "applied", networkDelta: { kind: "delta", delta: { evidence: [{ text: "late", source: "late", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] } },
    };
    const application = applyBatchRecords(reopened, [record]);
    expect(application.superseded).toEqual(["a2"]);
    expect(application.applied).toEqual([]);
    expect(application.network.activations.find((item) => item.id === "a2")?.status).toBe("superseded");
    expect(application.network.evidence.some((item) => item.text === "late")).toBe(false);
  });

  it("retains the workspace mutation of a failed implement record and blocks its region", () => {
    const network = mergeSolutionDelta(state(), "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "direct", proposition: "Direct", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"],
    });
    network.activations.push({ id: "a2", capability: "implement", regionId: "r1", request: "a2", expectedDelta: "a2", contextRefs: ["r1"], status: "running", basisRevision: network.revision });
    network.regions[0].status = "implementing";
    const record: ActivationTaskResult = {
      activationId: "a2", regionId: "r1", capability: "implement", basisRevision: network.revision, startedAt: 0, finishedAt: 0,
      usage: { turns: 1, input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "error", error: "invalid structured output", changedFiles: ["target.txt"], networkDelta: null,
    };
    const application = applyBatchRecords(network, [record]);
    expect(application.failed).toEqual(["a2"]);
    expect(application.network.activations.find((item) => item.id === "a2")?.status).toBe("failed");
    expect(application.network.artifacts.some((item) => item.kind === "file" && item.path === "target.txt")).toBe(true);
  });
});

describe("solution LOD graph", () => {
  it("executes a collapsed region and verifies it without a fixed role pipeline", async () => {
    const directory = temp("solution-lod-graph-");
    fs.writeFileSync(path.join(directory, "target.txt"), "before");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const calls: string[] = [];
    const runtime = { call: async (input: { node: string }) => {
      calls.push(input.node);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: ["e1"] }] } };
      if (input.node === "synthesize:r1") return { text: "", structured: { region: {}, evidence: [], candidates: [{ key: "direct", proposition: "Update target", outcome: "selected", reasons: [], evidenceRefs: ["e1"] }], constraints: [], select: ["direct"], answer: "stale pre-implementation design", activations: [] } };
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: ["target.txt"], checks: [], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target", passed: true, evidence: "after" }], activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "update", directory, worktree: directory, runId: "run" }), { recursionLimit: 64, configurable: { thread_id: "run", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} } });
    expect(calls).toEqual(["inspect:r1", "synthesize:r1", "implement:r1", "verify:r1"]);
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", semantic: { kind: "solution-lod-v1" } });
    expect(configured.result?.(result)).toContain("Implemented and verified");
    expect(configured.result?.(result)).not.toContain("stale pre-implementation design");
  });

  it("isolates malformed activation output and terminates with retained state", async () => {
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async () => { throw new Error("invalid structured output"); } };
    const result = await configured.graph.invoke(configured.initial({ task: "x", directory: "/repo", worktree: "/repo", runId: "bad" }), { recursionLimit: 32, configurable: { thread_id: "bad", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result)?.phase).toBe("blocked");
    expect((result as SolutionLodState).network.activations.some((activation) => activation.status === "failed")).toBe(true);
    expect(configured.result?.(result)).toContain("blocked");
  });

  it("reconciles actual files changed during implementation without claiming pre-existing dirt", async () => {
    const directory = temp("solution-lod-artifacts-");
    fs.writeFileSync(path.join(directory, "target.txt"), "base"); fs.writeFileSync(path.join(directory, "untouched.txt"), "base");
    fs.writeFileSync(path.join(directory, "untouched.txt"), "user dirt");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async (input: { node: string }) => {
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["files updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "change files", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] } };
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "agent change"); fs.writeFileSync(path.join(directory, "new.txt"), "new"); return { text: "", structured: { status: "completed", summary: "done", changedFiles: [], checks: [], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [], activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["untouched.txt", "M:user"], ["target.txt", "clean:base"]]) : new Map([["untouched.txt", "M:user"], ["target.txt", "M:agent"], ["new.txt", "?:new"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "change", directory, worktree: directory, runId: "artifacts" }), { recursionLimit: 32, configurable: { thread_id: "artifacts", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {}, langgraphSnapshotWorkspace: snapshot } });
    const files = (result as SolutionLodState).network.artifacts.filter((item) => item.kind === "file").map((item) => item.path).sort();
    expect(files).toEqual(["new.txt", "target.txt"]);
    expect(files).not.toContain("untouched.txt");
  });

  it("retains a workspace mutation when the implementer's final output is malformed", async () => {
    const directory = temp("solution-lod-malformed-mutation-");
    fs.writeFileSync(path.join(directory, "target.txt"), "base");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    let first = true;
    const runtime = { call: async (input: { node: string }) => {
      if (first && input.node === "inspect:r1") { first = false; return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "update target", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] } }; }
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "retained"); throw new Error("invalid structured output"); }
      throw new Error("recovery activation also malformed");
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["target.txt", "clean:base"]]) : new Map([["target.txt", "M:retained"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "change", directory, worktree: directory, runId: "malformed-mutation" }), { recursionLimit: 32, configurable: { thread_id: "malformed-mutation", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {}, langgraphSnapshotWorkspace: snapshot } });
    expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("retained");
    expect((result as SolutionLodState).network.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", path: "target.txt" })]));
    expect(configured.progress?.(result)?.phase).toBe("blocked");
  });

  it("fans a read-only batch out in parallel, merges deterministically, and clears the results log", async () => {
    const directory = temp("solution-lod-parallel-");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const events: string[] = [];
    let open = 0; let maxOpen = 0;
    const runtime = { call: async (input: { node: string }) => {
      events.push(`start:${input.node}`); open++; maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 25));
      open--; events.push(`end:${input.node}`);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { acceptanceCriteria: ["left answered", "right answered"] }, evidence: [], candidates: [{ key: "split", proposition: "Two independent answers", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["split"], activations: [] } };
      if (input.node === "refine:r1") return { text: "", structured: { evidence: [], activations: [], children: [
        { key: "left", objective: "Answer the left question", edge: "partOf", delivery: "answer", allowedVariables: [], acceptanceCriteria: ["left answered"], coveredCriteria: [0] },
        { key: "right", objective: "Answer the right question", edge: "partOf", delivery: "answer", allowedVariables: [], acceptanceCriteria: ["right answered"], coveredCriteria: [0] },
      ] } };
      if (input.node === "inspect:r2") return { text: "", structured: { region: {}, evidence: [{ text: "left context", source: "left:1", kind: "inference" }], candidates: [], constraints: [], select: [], activations: [] } };
      if (input.node === "inspect:r3") return { text: "", structured: { region: {}, evidence: [{ text: "right context", source: "right:1", kind: "inference" }], candidates: [], constraints: [], select: [], activations: [] } };
      if (input.node === "synthesize:r2" || input.node === "synthesize:r3") return { text: "", structured: { region: {}, evidence: [], candidates: [{ key: "direct", proposition: "Answer directly", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] } };
      if (input.node === "present:r2") return { text: "", structured: { answer: "left answer" } };
      if (input.node === "present:r3") return { text: "", structured: { answer: "right answer" } };
      if (input.node === "verify:r2" || input.node === "verify:r3") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [], activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "answer two questions", directory, worktree: directory, runId: "parallel" }), { recursionLimit: 128, configurable: { thread_id: "parallel", langgraphOpenCodeRuntime: runtime } });
    expect(maxOpen).toBe(2);
    expect(events.indexOf("start:synthesize:r2")).toBeGreaterThan(-1);
    expect(events.indexOf("start:synthesize:r3")).toBeGreaterThan(-1);
    expect(events.indexOf("start:synthesize:r3")).toBeLessThan(events.indexOf("end:synthesize:r2"));
    const final = result as SolutionLodState;
    expect(configured.progress?.(final)?.phase).toBe("completed");
    expect(configured.result?.(final)).toBe("left answer\n\nright answer");
    expect(final.results).toEqual([]);
    expect(final.activeBatch).toEqual([]);
    expect(final.network.activations.filter((item) => item.status !== "completed").map((item) => item.status)).toEqual([]);
  });

  it("routes the implement singleton through acquire before dispatching its activation task", async () => {
    const directory = temp("solution-lod-acquire-");
    fs.writeFileSync(path.join(directory, "target.txt"), "before");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const order: string[] = [];
    const runtime = { call: async (input: { node: string }) => {
      order.push(`node:${input.node}`);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "Update target", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] } };
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: [], checks: [], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [], activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["target.txt", "clean:before"]]) : new Map([["target.txt", "M:after"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "update", directory, worktree: directory, runId: "acquire" }), { recursionLimit: 64, configurable: { thread_id: "acquire", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { order.push("acquire"); }, langgraphSnapshotWorkspace: snapshot } });
    expect(order.filter((item) => item === "acquire")).toHaveLength(1);
    expect(order.indexOf("acquire")).toBeLessThan(order.indexOf("node:implement:r1"));
    expect(configured.progress?.(result)?.phase).toBe("completed");
    expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("after");
    const final = result as SolutionLodState;
    expect(final.results).toEqual([]);
    expect(final.network.artifacts.some((item) => item.kind === "file" && item.path === "target.txt")).toBe(true);
  });
});

describe("activation IO schema views", () => {
  const spans = (lines: NonNullable<ReturnType<typeof renderSchemaOutput>>, match: string) => lines.find((line) => line.spans.some((span) => span.text.includes(match)))!;

  it("renders a synthesis delta with outcome badges, constraint kinds, and selection", () => {
    const lines = renderSchemaOutput({
      region: { objective: "Add exports", acceptanceCriteria: ["exports exist"], allowedVariables: ["api shape"], delivery: "change" },
      evidence: [{ text: "core has 3 modules", source: "src/core/index.ts:1", kind: "repository" }],
      candidates: [
        { key: "barrel", proposition: "Barrel file", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "inline", proposition: "Inline exports", outcome: "eliminated", reasons: ["duplicates imports"], evidenceRefs: [] },
      ],
      constraints: [{ kind: "refutes", subject: "task", target: "inline", reason: "conflicts with the public api" }],
      select: ["barrel"],
      activations: [{ capability: "inspect", regionId: "r2", request: "check package exports", expectedDelta: "exports-fact", contextRefs: [] }],
    });
    expect(lines).toBeDefined();
    const flat = flattenSchemaLines(lines!);
    expect(flat).toContain("[SYNTHESIS DELTA]");
    expect(flat).toContain("GOAL Add exports");
    expect(flat).toContain("✓ exports exist");
    expect(flat).toContain("● core has 3 modules");
    expect(flat).toContain("◆ [CHOSEN] Barrel file");
    expect(flat).toContain("× [REJECTED] Inline exports");
    expect(flat).toContain("↳ duplicates imports");
    expect(flat).toContain("[REFUTES] task → inline");
    expect(flat).toContain("· conflicts with the public api");
    expect(flat).toContain("SELECTION barrel");
    expect(flat).toContain("→ inspect r2");
    expect(spans(lines!, "[CHOSEN]").spans.some((span) => span.tone === "success")).toBe(true);
    expect(spans(lines!, "[REFUTES]").spans.some((span) => span.tone === "error")).toBe(true);
    expect(spans(lines!, "↳ duplicates").spans[0].tone).toBe("error");
    expect(lines!.flatMap((line) => line.spans).find((span) => span.text.includes("src/core/index.ts:1"))?.tone).toBe("muted");
  });

  it("renders forced refinements as next steps with per-child criteria and coverage", () => {
    const split = renderSchemaOutput({
      evidence: [], activations: [],
      children: [
        { key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: ["mapping is explicit"], coveredCriteria: [0] },
        { key: "docs", objective: "Update docs", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["docs mention mapping"], coveredCriteria: [1] },
      ],
    })!;
    const flat = flattenSchemaLines(split);
    expect(flat).toContain("[REFINEMENT]");
    expect(flat).toContain("[2 NEXT STEPS]");
    expect(flat).toContain("⌇ [REFINES] Resolve mapping");
    expect(flat).toContain("· covers #0 · mapping");
    expect(flat).toContain("■ [PART OF] Update docs");
    expect(flat).toContain("✓ docs mention mapping");
  });

    it("renders implementation files and check outcomes plus blocked reasons", () => {
    const completed = renderSchemaOutput({ status: "completed", summary: "did the thing", changedFiles: ["src/a.ts"], checks: [{ name: "lint", passed: true, evidence: "clean" }, { name: "test", passed: false, evidence: "1 failing" }], activations: [] })!;
    const completedFlat = flattenSchemaLines(completed);
    expect(completedFlat).toContain("[IMPLEMENTATION]");
    expect(completedFlat).toContain("[COMPLETED]");
    expect(completedFlat).toContain("+ src/a.ts");
    expect(completedFlat).toContain("✓ lint");
    expect(completedFlat).toContain("— clean");
    expect(completedFlat).toContain("✗ test");
    expect(completedFlat).toContain("— 1 failing");
    expect(spans(completed, "✗ test").spans[0].tone).toBe("error");
    const blocked = renderSchemaOutput({ status: "blocked", changedFiles: [], blocker: "missing config key" })!;
    const blockedFlat = flattenSchemaLines(blocked);
    expect(blockedFlat).toContain("[BLOCKED]");
    expect(blockedFlat).toContain("BLOCKER missing config key");
    expect(blocked.flatMap((line) => line.spans).find((span) => span.text.includes("missing config key"))?.tone).toBe("error");
  });

  it("renders verification verdicts and criterion-mapped findings", () => {
    const reopened = renderSchemaOutput({ verdict: "reopen", summary: "earlier choice contradicted", findings: [{ criterion: "exports exist", regionId: "r2", problem: "chosen barrel breaks cjs consumers", evidence: "grep dist" }], activations: [] })!;
    const flat = flattenSchemaLines(reopened);
    expect(flat).toContain("[VERIFICATION]");
    expect(flat).toContain("[REOPEN]");
    expect(flat).toContain("! exports exist  r2");
    expect(flat).toContain("chosen barrel breaks cjs consumers");
    expect(flat).toContain("— grep dist");
    expect(spans(reopened, "[REOPEN]").spans.some((span) => span.tone === "accent")).toBe(true);
    expect(spans(reopened, "! exports exist").spans[0].tone).toBe("warning");
  });

  it("renders presentation answers and falls back for unknown payloads", () => {
    const answer = renderSchemaOutput({ answer: "The answer is 4." })!;
    expect(flattenSchemaLines(answer)).toContain("The answer is 4.");
    expect(renderSchemaOutput({ unrelated: true })).toBeUndefined();
    expect(renderSchemaOutput("text only")).toBeUndefined();
  });

  it("recovers schema views from raw JSON text for runs recorded without structured payloads", () => {
    const fromPlain = renderSchemaText('{"verdict":"pass","summary":"ok","findings":[],"checks":[{"name":"t","passed":true,"evidence":"e"}],"activations":[]}');
    expect(flattenSchemaLines(fromPlain!)).toContain("[VERIFICATION]");
    expect(flattenSchemaLines(fromPlain!)).toContain("[PASS]");
    const fromFenced = renderSchemaText(' preamble\n```json\n{"status":"completed","summary":"done","changedFiles":["a.ts"],"checks":[],"activations":[]}\n```\n');
    expect(flattenSchemaLines(fromFenced!)).toContain("+ a.ts");
    expect(renderSchemaText("plain prose output")).toBeUndefined();
    expect(renderSchemaText(undefined)).toBeUndefined();
  });

  it("renders activation input projections by semantics and rejects unknown shapes", () => {
    const input = renderSchemaInput(JSON.stringify({
      userRequest: "Add named exports",
      yourAssignment: "Choose the export approach",
      goal: "Pick an export strategy",
      successCriteria: ["imports keep working"],
      chooseOnly: ["api shape"],
      mustNotChooseSolution: false,
      facts: [{ referenceId: "e1", fact: "core has 3 modules", source: "src/core:1" }],
      relationships: [{ relationship: "requires", from: "barrel", to: "core", explanation: "re-exports everything" }],
      earlierChoices: ["Use an adapter"],
      alternativesAlreadyConsidered: [{ approach: "Inline exports", status: "rejected", reasonsRejected: ["no single entry"] }],
      nextStepsContract: { split: "split into covering children", leafNote: "leaves are computed" },
    }))!;
    const flat = flattenSchemaLines(input);
    expect(flat).toContain("[ACTIVATION INPUT]");
    expect(flat).toContain("REQUEST Add named exports");
    expect(flat).toContain("ASSIGNMENT Choose the export approach");
    expect(flat).toContain("GOAL Pick an export strategy");
    expect(flat).toContain("✓ imports keep working");
    expect(flat).toContain("CHOOSE ONLY api shape");
    expect(flat).toContain("● core has 3 modules");
    expect(flat).toContain("[REQUIRES] barrel → core");
    expect(flat).toContain("· re-exports everything");
    expect(flat).toContain("CHOSEN SO FAR Use an adapter");
    expect(flat).toContain("× Inline exports");
    expect(flat).toContain("SPLIT split into covering children");
    expect(flat).toContain("LEAVES leaves are computed");
    expect(spans(input, "[REQUIRES]").spans.some((span) => span.tone === "info")).toBe(true);
    expect(renderSchemaInput("not json")).toBeUndefined();
    expect(renderSchemaInput(undefined)).toBeUndefined();
    expect(renderSchemaInput(JSON.stringify({ userRequest: "x" }))).toBeUndefined();
  });

  it("emits the validated structured payload on completed runtime events", async () => {
    const events: Array<{ node: string; status: string; structured?: unknown }> = [];
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant", structured: { decision: "go" } }, parts: [] }] }),
      abort: async () => ({ data: true }),
    } };
    const definition = { version: 1 as const, models: { current: { backend: "opencode" as const, model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: { question: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event) });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(events.find((event) => event.status === "completed")?.structured).toEqual({ decision: "go" });
  });
});

describe("worktree queue", () => {
  it("runs verifier mutations in a disposable copy and removes it", async () => {
    const stateHome = temp("opencode-langgraph-verifier-state-");
    const project = temp("opencode-langgraph-verifier-project-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      fs.mkdirSync(path.join(project, ".git"));
      fs.writeFileSync(path.join(project, ".git", "config"), "private");
      fs.writeFileSync(path.join(project, "source.txt"), "original");
      const workspace = await prepareVerifierWorkspace("isolated-run", project);
      expect(fs.readFileSync(path.join(workspace, "source.txt"), "utf8")).toBe("original");
      expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
      fs.writeFileSync(path.join(workspace, "source.txt"), "verifier mutation");
      fs.writeFileSync(path.join(workspace, "generated.txt"), "test output");
      expect(fs.readFileSync(path.join(project, "source.txt"), "utf8")).toBe("original");
      expect(fs.existsSync(path.join(project, "generated.txt"))).toBe(false);
      await releaseVerifierWorkspace("isolated-run");
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });

  it("refuses to mirror filesystem root or the user home", async () => {
    await expect(prepareVerifierWorkspace("unsafe-root", path.parse(process.cwd()).root)).rejects.toThrow("unsafe verifier worktree");
    await expect(prepareVerifierWorkspace("unsafe-home", os.homedir())).rejects.toThrow("unsafe verifier worktree");
  });

  it("serializes leases in FIFO order", async () => {
    const stateHome = temp("opencode-langgraph-lock-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      const controller = new AbortController();
      const first = await acquireWorktree("/repo", controller.signal);
      let acquired = false;
      const secondPromise = acquireWorktree("/repo", controller.signal).then((lease) => { acquired = true; return lease; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(acquired).toBe(false);
      first.release();
      const second = await secondPromise;
      expect(acquired).toBe(true);
      second.release();
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });

  it("immediately recovers a lease whose owner process exited", async () => {
    const stateHome = temp("opencode-langgraph-dead-lock-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      const id = createHash("sha256").update(path.resolve("/repo")).digest("hex");
      const root = path.join(stateHome, "opencode-langgraph", "locks", id);
      fs.mkdirSync(path.join(root, "queue"), { recursive: true });
      fs.writeFileSync(path.join(root, "owner"), JSON.stringify({ ticket: "dead", pid: 2_147_483_647 }));
      const controller = new AbortController();
      const started = Date.now();
      const lease = await acquireWorktree("/repo", controller.signal);
      expect(Date.now() - started).toBeLessThan(1_000);
      lease.release();
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });
});

describe("durable checkpoints", () => {
  it("resumes an interrupt through a separately opened durable saver", async () => {
    const directory = temp("opencode-langgraph-checkpoints-");
    const State = Annotation.Root({ answer: Annotation<string> });
    const compile = (saver: DurableFileSaver) => new StateGraph(State)
      .addNode("ask", () => ({ answer: interrupt("question") as string }))
      .addEdge(START, "ask").addEdge("ask", END).compile({ checkpointer: saver });
    const firstSaver = new DurableFileSaver(directory);
    const first = await compile(firstSaver).invoke({ answer: "" }, { configurable: { thread_id: "durable" } });
    expect(isInterrupted(first)).toBe(true);
    const secondSaver = new DurableFileSaver(directory);
    const resumed = await compile(secondSaver).invoke(new Command({ resume: "yes" }), { configurable: { thread_id: "durable" } });
    expect(resumed.answer).toBe("yes");
  });
});

describe("OpenCode automatic graph routing", () => {
  it("passes a bounded semantic conversation frame without duplicating the current message", () => {
    const long = "x".repeat(2_000);
    const context = buildConversationContext([
      { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "Implement the requested fix" }] },
      { info: { id: "tool", role: "assistant" }, parts: [{ type: "reasoning", text: "private reasoning" }, { type: "tool", text: "tool output" }] },
      { info: { id: "old-assistant", role: "assistant" }, parts: [{ type: "text", text: long }, { type: "text", text: "hidden", synthetic: true }] },
      { info: { id: "current", role: "user" }, parts: [{ type: "text", text: "Fix that too" }] },
    ], "current", "Fix that too");
    expect(context).toContain("USER: Implement the requested fix");
    expect(context).toContain("ASSISTANT: ");
    expect(context).not.toContain("private reasoning");
    expect(context).not.toContain("tool output");
    expect(context).not.toContain("hidden");
    expect(context).not.toContain("Fix that too");
    expect(context.length).toBeLessThan(1_300);
  });

  it("drops an unpersisted current-message duplicate by content", () => {
    expect(buildConversationContext([
      { info: { id: "prior", role: "user" }, parts: [{ type: "text", text: "Earlier requirement" }] },
      { info: { id: "different-api-id", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
    ], "current", "Continue")).toBe("USER: Earlier requirement");
  });

  it("persists cross-process cancellation and emits a terminal event", async () => {
    const state = temp("opencode-langgraph-cancel-");
    const project = temp("opencode-langgraph-cancel-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(project, "file.txt"), "value");
      const verifierWorkspace = await prepareVerifierWorkspace("run", project);
      writeStoredRun({ checkpointVersion: 5, runId: "run", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project, status: "interrupted" });
      const hooks = await server({ client: {}, directory: "/repo", worktree: "/repo" } as never);
      await hooks["command.execute.before"]?.({ command: "graph-cancel", sessionID: "root", arguments: "" }, { parts: [] } as never);
      expect(readStoredRun("run").status).toBe("cancelled");
      expect(fs.existsSync(verifierWorkspace)).toBe(false);
      expect(readPluginEvents("root", state).at(-1)).toMatchObject({ runId: "run", node: "__end__", status: "interrupted", text: "Cancelled by user" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("runs the graph from a root chat message and records visible events", async () => {
    const state = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    let child = 0;
    const posted: unknown[] = [];
    const parents = new Map<string, string | undefined>([["root", undefined]]);
    const titles = new Map<string, string>();
    const client = { session: {
      get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
      create: async ({ body }: { body: { parentID: string; title: string } }) => {
        const id = `child-${++child}`;
        parents.set(id, body.parentID);
        titles.set(id, body.title);
        return { data: { id } };
      },
      promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async ({ path: requestPath }: { path: { id: string } }) => {
        if (requestPath.id === "root") return { data: ["message-1", "message-command"].map((parentID) => ({ info: { role: "assistant", parentID }, parts: [{ type: "text", text: "The answer is 4." }] })) };
        const title = titles.get(requestPath.id) ?? "";
        const structured = title.includes("inspect:r1")
          ? { region: { delivery: "answer", acceptanceCriteria: ["Answer the question"] }, evidence: [{ text: "2+2 is 4", source: "arithmetic", kind: "inference" }], candidates: [{ key: "answer", proposition: "Answer directly", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["answer"], activations: [] }
          : title.includes("present:r1") ? { answer: "The answer is 4." }
          : title.includes("verify:r1") ? { verdict: "pass", summary: "Answer matches the facts", findings: [], checks: [], activations: [] } : undefined;
        return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: "The answer is 4." }] }] };
      },
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown>; agent?: Record<string, { tools?: Record<string, boolean>; maxSteps?: number; permission?: Record<string, unknown> }> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph", "graph-resume", "graph-pause", "graph-cancel"]);
      expect(config.agent?.["langgraph-presenter"]).toMatchObject({ maxSteps: 8, tools: { read: false, bash: false, edit: false, task: false, skill: false } });
      expect(config.agent?.["langgraph-inspector"]).toMatchObject({ maxSteps: 32, tools: { read: true, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-synthesizer"]).toMatchObject({ maxSteps: 8, tools: { read: false, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-verifier"]).toMatchObject({ tools: { bash: true, edit: false, skill: false }, permission: { bash: "allow", edit: "deny", external_directory: "deny" } });
      expect(Object.keys(hooks.tool ?? {})).toEqual(["langgraph_start", "langgraph_inspect", "langgraph_prune", "langgraph_resume", "langgraph_cancel", "langgraph_pause"]);
      const output = {
        message: { id: "message-1", sessionID: "root", role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } },
        parts: [{ id: "part-1", messageID: "message-1", sessionID: "root", type: "text", text: "What is 2+2?" }],
      };
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-1" }, output as never);
      expect(output.parts).toHaveLength(1);
      await hooks["command.execute.before"]?.({ command: "run-graph", sessionID: "root", arguments: "What is 2+2?" }, { parts: output.parts } as never);
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-command", model: { providerID: "test", modelID: "model" } }, {
        ...output,
        message: { ...output.message, id: "message-command" },
        parts: [{ ...output.parts[0], id: "part-command", messageID: "message-command" }],
      } as never);
      let deadline = Date.now() + 2_000;
      while (readPluginEvents("root").at(-1)?.userMessageId !== "message-command" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readPluginEvents("root").at(-1)?.userMessageId).toBe("message-command");
      writeSessionGraphEnabled("root", true, state);
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-1" }, output as never);
      expect(output.parts.at(-1)).toMatchObject({ type: "text", synthetic: true });
      expect(output.parts.at(-1)?.id).toMatch(/^prt_/);
      expect(output.message.agent).toBe("langgraph-presenter");
      deadline = Date.now() + 4_000;
      while ((child < 6 || posted.length < 8) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child).toBe(6);
      expect(posted).toHaveLength(8);
      expect(posted.at(-1)).toMatchObject({ body: { agent: "langgraph-presenter" } });
      expect((posted.at(-1) as { body: Record<string, unknown> }).body.tools).toBeUndefined();
      const events = readPluginEvents("root");
      expect(events.map((event) => event.node)).toEqual(expect.arrayContaining(["__start__", "inspect:r1", "present:r1", "verify:r1", "__end__"]));
      expect(new Set(events.map((event) => event.userMessageId))).toEqual(new Set(["message-command", "message-1"]));
      expect(events.find((event) => event.userMessageId === "message-1" && event.node === "__start__")?.state).toMatchObject({
        originalTask: "What is 2+2?",
        conversationContext: "ASSISTANT: The answer is 4.\nASSISTANT: The answer is 4.",
      });
      const toolContext = { sessionID: "root", directory: project, worktree: project, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;
      const startOutput = await (hooks.tool?.langgraph_start.execute as (args: { task: string }, ctx: never) => Promise<string>)({ task: "What is 2+2?" }, toolContext);
      const started = JSON.parse(startOutput) as { runId: string; status: string };
      expect(started).toMatchObject({ status: "running" });
      deadline = Date.now() + 2_000;
      while (!(["completed", "failed"] as string[]).includes(readStoredRun(started.runId).status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(["completed", "failed"]).toContain(readStoredRun(started.runId).status);
      expect(JSON.parse(await (hooks.tool?.langgraph_inspect.execute as (args: { runId: string }, ctx: never) => Promise<string>)({ runId: started.runId }, toolContext)).runId).toBe(started.runId);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("prunes a blocked run via the langgraph_prune tool and resumes it from the checkpoint", async () => {
    const state = temp("opencode-langgraph-tool-state-");
    const directory = temp("opencode-langgraph-tool-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(directory, "target.txt"), "base");
      let child = 0;
      const posted: unknown[] = [];
      const parents = new Map<string, string | undefined>([["root", undefined]]);
      const titles = new Map<string, string>();
      const client = { session: {
        get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
        create: async ({ body }: { body: { parentID: string; title: string } }) => {
          const id = `child-${++child}`;
          parents.set(id, body.parentID);
          titles.set(id, body.title);
          return { data: { id } };
        },
        promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
        status: async () => ({ data: {} }),
        messages: async ({ path: requestPath }: { path: { id: string } }) => {
          if (requestPath.id === "root") return { data: [{ info: { role: "user", model: { providerID: "test", modelID: "model" } }, parts: [{ type: "text", text: "task" }] }] };
          const title = titles.get(requestPath.id) ?? "";
          let structured: unknown;
          if (title.includes("inspect:r1")) {
            structured = { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] };
          } else if (title.includes("synthesize:r1")) {
            structured = { region: { acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "Update target", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] };
          } else if (title.includes("implement:r1")) {
            fs.writeFileSync(path.join(directory, "target.txt"), "after");
            structured = { status: "completed", summary: "updated", changedFiles: [], checks: [], activations: [] };
          } else if (title.includes("verify:r1")) {
            structured = { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target", passed: true, evidence: "after" }], activations: [] };
          }
          return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: JSON.stringify(structured ?? {}) }] }] };
        },
        abort: async () => ({ data: true }),
      } };
      const hooks = await server({ client, directory, worktree: directory } as never);
      const runId = "tool-run";
      writeStoredRun({ checkpointVersion: 5, runId, rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory, worktree: directory, status: "failed" });

      const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new DurableFileSaver(path.join(state, "opencode-langgraph", "checkpoints")) });
      let recovering = false;
      const runtime = { call: async (input: { node: string }) => {
        if (!recovering) throw new Error("insufficient balance");
        if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] } };
        if (input.node === "synthesize:r1") return { text: "", structured: { region: {}, evidence: [], candidates: [{ key: "direct", proposition: "Update target", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"], activations: [] } };
          if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: ["target.txt"], checks: [], activations: [] } }; }
        if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target", passed: true, evidence: "after" }], activations: [] } };
        throw new Error(`unexpected node ${input.node}`);
      } };
      const failed = await configured.graph.invoke(configured.initial({ task: "task", directory, worktree: directory, runId }), { recursionLimit: 64, configurable: { thread_id: runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} } });
      expect(configured.progress?.(failed)?.phase).toBe("blocked");
      recovering = true;

      const toolContext = { sessionID: "root", directory, worktree: directory, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;

      const inspectOutput = await (hooks.tool?.langgraph_inspect.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const inspected = JSON.parse(inspectOutput);
      expect(inspected.storedStatus).toBe("failed");
      expect(inspected.phase).toBe("blocked");

      const pruneOutput = await (hooks.tool?.langgraph_prune.execute as (args: { runId?: string; regionId: string; reason?: string; objective?: string }, ctx: never) => Promise<string>)({ regionId: "r1", reason: "insufficient balance during inspection", objective: "Update target with a different approach" }, toolContext);
      expect(JSON.parse(pruneOutput).phase).toBe("pruned");
      expect(readStoredRun(runId).status).toBe("pruned");
      const prunedState = await configured.graph.getState({ configurable: { thread_id: runId } });
      expect((prunedState.values as { network: { regions: Array<{ id: string; objective: string }> } }).network.regions.find((item) => item.id === "r1")?.objective).toBe("Update target with a different approach");

      const resumeOutput = await (hooks.tool?.langgraph_resume.execute as (args: { runId?: string; answer?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const resumed = JSON.parse(resumeOutput);
      expect(resumed.failed).toBe(false);
      expect(resumed.interrupted).toBe(false);
      expect(readStoredRun(runId).status).toBe("completed");
      expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("after");
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("inspects a queued run without a checkpoint and refuses to prune an active one", async () => {
    const state = temp("opencode-langgraph-tool-state-");
    const directory = temp("opencode-langgraph-tool-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      const hooks = await server({ client: { session: { get: async () => ({ data: { id: "root", parentID: undefined } }) } }, directory, worktree: directory } as never);
      const runId = "fresh-run";
      writeStoredRun({ checkpointVersion: 5, runId, rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory, worktree: directory, status: "queued" });
      const toolContext = { sessionID: "root", directory, worktree: directory, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;

      const inspectOutput = await (hooks.tool?.langgraph_inspect.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const inspected = JSON.parse(inspectOutput);
      expect(inspected.storedStatus).toBe("queued");
      expect(inspected.phase).toBe("no-checkpoint-yet");

      await expect((hooks.tool?.langgraph_prune.execute as (args: { runId?: string; regionId: string }, ctx: never) => Promise<string>)({ regionId: "r1" }, toolContext)).rejects.toThrow(/Cannot prune queued run/);
      await expect((hooks.tool?.langgraph_resume.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext)).rejects.toThrow(/cannot be resumed/);
      await expect((hooks.tool?.langgraph_pause.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext)).rejects.toThrow(/queued and cannot be paused/);
      expect(JSON.parse(await (hooks.tool?.langgraph_cancel.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext))).toMatchObject({ runId, status: "cancelled" });
      expect(readStoredRun(runId).status).toBe("cancelled");
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("adopts the home-screen graph selection for the first session message", async () => {
    const state = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const configDirectory = path.join(project, ".opencode");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(project, "node_modules"), "dir");
    fs.writeFileSync(path.join(configDirectory, "langgraph.ts"), `
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { defineGraph, defineOpenCodeLangGraph } from "opencode-langgraph";
const State = Annotation.Root({ task: Annotation<string>, result: Annotation<string> });
const named = (result: string) => defineGraph({
  graph: new StateGraph(State).addNode("finish", () => ({ result })).addEdge(START, "finish").addEdge("finish", END).compile({ checkpointer: new MemorySaver() }),
  initial: ({ task }: { task: string }) => ({ task, result: "" }),
  result: (value: { result: string }) => value.result,
});
export default defineOpenCodeLangGraph({ version: 1, models: {}, agents: {}, graphs: { first: named("first"), second: named("second") }, defaultGraph: "first" });
`);
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    const posted: unknown[] = [];
    const client = { session: {
      get: async () => ({ data: { id: "root", parentID: undefined } }),
      messages: async () => ({ data: [{ info: { role: "assistant", parentID: "message" }, parts: [] }] }),
      promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
    } };
    try {
      writeHomeGraphState(project, { enabled: true, graph: "second" }, state);
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const output = {
        message: { id: "message", sessionID: "root", role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } },
        parts: [{ id: "part", messageID: "message", sessionID: "root", type: "text", text: "task" }],
      };
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message" }, output as never);
      const deadline = Date.now() + 2_000;
      while (readPluginEvents("root", state).at(-1)?.node !== "__end__" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const events = readPluginEvents("root", state);
      expect(events.every((event) => event.graph === "second")).toBe(true);
      expect(events.at(-1)).toMatchObject({ node: "__end__", text: "second" });
      expect(posted).toHaveLength(1);
      expect(readSessionGraphEnabled("root", state)).toBe(true);
      expect(readSessionGraphName("root", state)).toBe("second");
      expect(readHomeGraphState(project, state)).toBeUndefined();
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });
});

describe("OpenCode graph viewer", () => {
  it("shows the actual graph name in the prompt shortcut legend", () => {
    expect(graphToggleLabel(false, "review")).toBe("[F7] graph:off · [F8] view · [F9] help");
    expect(graphToggleLabel(true, "review")).toBe("[F7] graph:review · [F8] view · [F9] help");
  });

  it("keeps graph usage and design help available in the TUI", () => {
    expect(graphHelpText()).toContain("/graph-select");
    expect(graphHelpText()).toContain(".opencode/langgraph.ts");
    expect(graphHelpText()).toContain("defineGraph({ graph, initial, result, progress? })");
    expect(graphHelpText()).toContain("R runs");
    expect(graphHelpText()).toContain("P prompt");
    expect(effectivePrompt({ prompt: { system: "ROLE", input: '{"task":"x"}', schemaInstruction: "SCHEMA" } } as never)).toBe('SYSTEM\nROLE\n\nINPUT\n{"task":"x"}\n\nOUTPUT CONTRACT\nSCHEMA');
  });

  it("ships the TUI framework as runtime dependencies", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(["@opentui/core", "@opentui/solid", "solid-js"]));
    expect(manifest.exports["./tui"]).toBe("./dist/src/opencode/tui.js");
    expect(manifest.scripts.build).toContain("build-tui.mjs");
  });

  it("persists graph selection when graph mode is toggled", () => {
    const stateHome = temp("opencode-langgraph-state-");
    writeSessionGraphName("root", "review", stateHome);
    writeSessionGraphEnabled("root", true, stateHome);
    expect(readSessionGraphName("root", stateHome)).toBe("review");
    expect(readSessionGraphEnabled("root", stateHome)).toBe(true);
    writeSessionGraphEnabled("root", false, stateHome);
    expect(readSessionGraphName("root", stateHome)).toBe("review");
  });

  it("routes graph navigation through scoped keymap commands", () => {
    const calls: string[] = [];
    const controls = new Proxy({}, {
      get: (_target, name) => () => calls.push(String(name)),
    }) as GraphControls;
    const layer = graphNavigationLayer(controls);
    const commandByName = new Map(layer.commands.map((command) => [command.name, command]));

    for (const [key, expected] of [
      ["q", "back"], ["tab", "cycle"], ["1", "tree"], ["2", "detail"], ["r", "runs"], ["o", "output"],
      ["p", "prompt"], ["return", "inspect"], ["up", "up"], ["j", "down"], ["left", "left"],
      ["d", "right"], ["pageup", "pageUp"], ["pagedown", "pageDown"], ["home", "home"], ["end", "end"],
      ["n", "newRun"], ["space", "pause"], ["u", "resume"], ["e", "repair"], ["x", "cancel"],
    ] as const) {
      const binding = layer.bindings.find((candidate) => candidate.key === key);
      expect(binding).toBeDefined();
      commandByName.get(binding!.cmd)?.run();
      expect(calls.pop()).toBe(expected);
    }
  });

  it("renders the actual execution states and collapses both sides of the focus", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "default", status: "completed", agent: "analyst", model: "test/model" };
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...base,
      node: `step_${index}`,
      ...(index === 4 ? { status: "active", progress: { phase: "planning", scope: "subsystem", activeNodeId: "p2", nodes: [{ id: "p2", title: "Resolve controller state", level: "controller", depth: 1, status: "active" }] } } : {}),
    }));
    const layout = renderEventGraph(events, "▶", 4);
    expect(layout.canvas).toContain("2 executions collapsed");
    expect(layout.canvas).toContain("3 executions collapsed");
    expect(layout.canvas).toContain("▶  STEP 4  [ACTIVE]");
    expect(layout.canvas).toContain("planning · p2 Resolve controller state · analyst");
    expect(layout.canvas).not.toContain("STEP 0");
    expect(layout.canvas).not.toContain("STEP 9");
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("renders semantic solution progress as a mixed-LOD hierarchy", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "solution-lod", node: "activate", status: "active", agent: "inspector", model: "inherit" };
    const semantic = { kind: "solution-lod-v1" as const, revision: 2, candidates: [], constraints: [], evidence: [], activations: [], artifacts: [], regions: [
      { id: "r1", key: "root", edge: "root" as const, lod: 0, objective: "Requested behavior", status: "collapsed", viable: 1, total: 2, selectedCandidateIds: ["r1:adapter"], candidateIds: ["r1:adapter", "r1:rewrite"], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] },
      { id: "r2", key: "handoff", parentId: "r1", edge: "refines" as const, lod: 1, objective: "Session handoff", status: "superposed", viable: 2, total: 3, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: ["e1", "e2"], activationIds: [], artifactIds: [] },
    ] };
    const tree = renderPlanTree([{ ...base, progress: { phase: "inspect:r2", callsUsed: 3, activeNodeId: "r2", semantic, nodes: [
      { id: "r1", title: "Requested behavior", level: "L0", depth: 0, status: "collapsed", agents: ["synthesize"] },
      { id: "r2", parentId: "r1", title: "Session handoff", level: "L1", depth: 1, status: "superposed", evidence: 2, agents: ["inspect"] },
    ] } }]);
    expect(tree).toContain("SOLUTION LOD  inspect:r2");
    expect(tree).toContain("3 activations");
    expect(tree).toContain("└─ ◇ r2  Session handoff");
    expect(tree).toContain("superposed · L1 · 2/3 viable · refines · 2 evidence INSPECT");
  });

  it("keeps the most recently started execution visible when runs overlap", () => {
    const base = { at: "now", rootSessionId: "root", graph: "default", status: "active", agent: "langgraph", model: "langgraph" };
    const events = [
      { ...base, runId: "older", userMessageId: "message-1", node: "__start__", topology: { nodes: ["older"], edges: [] } },
      { ...base, runId: "newer", userMessageId: "message-2", node: "__start__", topology: { nodes: ["newer"], edges: [] } },
      { ...base, runId: "older", userMessageId: "message-1", node: "__end__", status: "completed" },
    ];
    const layout = renderEventGraph(events);
    expect(layout.canvas).toContain("newer");
    expect(layout.canvas).not.toContain("older");
  });

  it("reads the current project run before route lifecycle callbacks", async () => {
    const project = temp("opencode-langgraph-viewer-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      appendPluginEvent({
        at: new Date().toISOString(), runId: "visible-run", rootSessionId: "root", graph: "default",
        node: "answer", status: "completed", agent: "planner", model: "test/model", text: "visible output",
      });
      writeStoredRun({
        runId: "visible-run", rootSessionId: "root", userMessageId: "message", graph: "default", task: "test",
        directory: project, worktree: project, status: "completed",
      });
      expect(readVisibleEvents(undefined, project, stateHome)).toMatchObject([
        { runId: "visible-run", node: "answer", text: "visible output" },
      ]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("does not leak run state across projects or root sessions", () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const otherProject = temp("opencode-langgraph-other-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      appendPluginEvent({
        at: new Date().toISOString(), runId: "isolated-run", rootSessionId: "root-a", graph: "default",
        userMessageId: "message-a", node: "answer", status: "failed", agent: "planner", model: "test/model",
      });
      writeStoredRun({
        runId: "isolated-run", rootSessionId: "root-a", userMessageId: "message-a", graph: "default", task: "test",
        directory: project, worktree: project, status: "failed",
      });

      expect(readVisibleEvents(undefined, project, stateHome)).toHaveLength(1);
      expect(readVisibleEvents(undefined, otherProject, stateHome)).toEqual([]);
      expect(readVisibleEvents("root-b", project, stateHome)).toEqual([]);
      expect(readVisibleEvents("root-a", project, stateHome, "message-a")).toHaveLength(1);
      expect(readVisibleEvents("root-a", project, stateHome, "message-b")).toEqual([]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("lists project runs newest-first and filters visible events by a specific runId", async () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      for (const [runId, task, status] of [["run-old", "oldest task", "completed"], ["run-new", "newest task", "running"]] as const) {
        writeStoredRun({ runId, rootSessionId: "root-a", userMessageId: `message-${runId}`, graph: "solution-lod", task, directory: project, worktree: project, status });
        appendPluginEvent({ at: new Date().toISOString(), runId, rootSessionId: "root-a", graph: "solution-lod", node: "__start__", status: "active", agent: "langgraph", model: "langgraph" });
        appendPluginEvent({ at: new Date().toISOString(), runId, rootSessionId: "root-a", graph: "solution-lod", node: "answer", status: status === "completed" ? "completed" : "active", agent: "planner", model: "test/model", text: `${runId} output` });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const runs = listProjectRuns(project, stateHome);
      expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"]);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "run-old")).toHaveLength(2);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "run-old").every((event) => event.runId === "run-old")).toBe(true);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "missing-run")).toEqual([]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("resolves run events by runId even when the run belongs to another session or project", () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const otherProject = temp("opencode-langgraph-other-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      writeStoredRun({
        runId: "agent-run", rootSessionId: "agent-session", userMessageId: "message", graph: "solution-lod", task: "agent task",
        directory: project, worktree: project, status: "failed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "agent-run", rootSessionId: "agent-session", graph: "solution-lod",
        node: "__end__", status: "failed", agent: "langgraph", model: "langgraph", text: "contradiction",
      });
      writeStoredRun({
        runId: "foreign-run", rootSessionId: "foreign-session", userMessageId: "message", graph: "default", task: "elsewhere",
        directory: otherProject, worktree: otherProject, status: "completed",
      });

      // The active session has no events of its own, yet the run is inspectable by runId.
      expect(readVisibleEvents("current-session", project, stateHome)).toEqual([]);
      const events = readVisibleEvents("current-session", project, stateHome, undefined, "agent-run");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runId: "agent-run", node: "__end__", text: "contradiction" });

      // The run selector sees runs from every session and worktree.
      expect(listAllRuns(stateHome).map((run) => run.runId).sort()).toEqual(["agent-run", "foreign-run"]);
      expect(listProjectRuns(project, stateHome).map((run) => run.runId)).toEqual(["agent-run"]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("offers the run picker when the active session has no graph events", async () => {
    const project = temp("opencode-langgraph-project-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    let commands: Array<{ name: string; run: () => void }> = [];
    const events = new Map<string, (event: { properties: { sessionID: string } }) => void>();
    const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
    let selector: { title: string; options: Array<{ title: string; value: string; description?: string }>; onSelect: (option: { value: string }) => void } | undefined;
    const api = {
      route: {
        current: { name: "home" },
        register: () => () => undefined,
        navigate: (name: string, params?: Record<string, unknown>) => navigations.push({ name, params }),
      },
      state: { path: { worktree: project, directory: project, config: path.join(project, "config") } },
      event: { on: (type: string, handler: (event: { properties: { sessionID: string } }) => void) => { events.set(type, handler); return () => undefined; } },
      slots: { register: () => "opencode-langgraph" },
      renderer: { requestRender: () => undefined },
      keymap: {
        registerLayer: (layer: { commands: typeof commands }) => { commands.push(...layer.commands); return () => undefined; },
        createKeyMatcher: () => () => false,
        intercept: () => () => undefined,
      },
      ui: {
        dialog: { replace: (render: () => unknown) => { render(); }, clear: () => undefined },
        toast: () => undefined,
        DialogAlert: () => "alert",
        DialogSelect: (props: never) => { selector = props; return "select"; },
      },
      mode: { current: () => "base" },
    };
    try {
      writeStoredRun({
        runId: "agent-run", rootSessionId: "agent-session", userMessageId: "message", graph: "solution-lod", task: "launched by an agent",
        directory: project, worktree: project, status: "failed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "agent-run", rootSessionId: "agent-session", graph: "solution-lod",
        node: "__end__", status: "failed", agent: "langgraph", model: "langgraph",
      });
      await tui(api as never, undefined, {} as never);
      events.get("tui.session.select")?.({ properties: { sessionID: "current-session" } });
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations).toEqual([{ name: "langgraph.graph", params: { runs: true } }]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("renders a structured event summary instead of raw blobs", () => {
    const event = {
      runId: "run", rootSessionId: "root", graph: "solution-lod", node: "implement:r2", status: "failed", agent: "langgraph-implement", model: "inherit",
      text: "Implement the selected behavior",
      progress: { phase: "implement:r2", callsUsed: 3, activeNodeId: "r2", semantic: { kind: "solution-lod-v1" as const, revision: 1, candidates: [], constraints: [], evidence: [], activations: [{ id: "a14", capability: "implement", regionId: "r2", request: "", expectedDelta: "implement:r2:18", senderActivationId: undefined, status: "failed", error: "budget" }], artifacts: [], regions: [{ id: "r2", key: "r2", edge: "refines" as const, lod: 1, objective: "Settle emptiness", status: "actionable", viable: 1, total: 2, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] }] }, nodes: [] },
      state: { phase: "blocked", callsUsed: 3, network: { regions: [{ id: "r2", status: "actionable" }], candidates: [], activations: [{ id: "a14", capability: "implement", regionId: "r2", status: "failed", error: "budget" }] } },
      usage: { turns: 12, input: 1000, output: 200, reasoning: 0, cacheRead: 500, cacheWrite: 0, cost: 0.01 },
    } as never;
    const structured = renderStructuredEvent(event);
    expect(structured).toContain("IMPLEMENT:R2  [FAILED]  IMPLEMENT");
    expect(structured).toContain("OUTPUT");
    expect(structured).toContain("Implement the selected behavior");
    expect(structured).toContain("r2  [actionable]");
    expect(structured).toContain("a14:implement  [failed]  r2");
    expect(structured).toContain("budget");
    expect(structured).not.toContain("\"phase\"");
  });

  it("appends the live streaming estimate suffix only while an event carries it", () => {
    const base = { runId: "run", rootSessionId: "root", graph: "solution-lod", node: "synthesize:r6", status: "active", agent: "langgraph-synthesize", model: "inherit" };
    const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const streaming = renderStructuredEvent({ ...base, usage, streaming: { inputEstimated: 4_000, outputEstimated: 200 } } as never);
    expect(streaming).toContain("USAGE  0t · 0in · 0cache · ~4.2k live");
    const completed = renderStructuredEvent({ ...base, status: "completed", usage: { ...usage, turns: 2, input: 1_000, cacheRead: 500 } } as never);
    expect(completed).toContain("USAGE  2t · 1kin · 500cache");
    expect(completed).not.toContain("live");
    expect(usageLine(usage, { inputEstimated: 4_000, outputEstimated: 200 })).toBe("0t · 0in · 0cache · ~4.2k live");
    expect(usageLine({ ...usage, cost: 0.5 })).toBe("0t · 0in · 0cache · $0.500");
  });

  it("opens the project graph when no chat session exists yet", async () => {
    const project = temp("opencode-langgraph-project-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    let commands: Array<{ name: string; run: () => void }> = [];
    const bindings: Array<{ key: string; cmd: string }> = [];
    const events = new Map<string, (event: { properties: { sessionID: string } }) => void>();
    const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const dialogs: string[] = [];
    let renders = 0;
    const api = {
      route: {
        current: { name: "home" },
        register: () => () => undefined,
        navigate: (name: string, params?: Record<string, unknown>) => navigations.push({ name, params }),
      },
      state: { path: { worktree: project, directory: project, config: path.join(project, "config") } },
      event: { on: (type: string, handler: (event: { properties: { sessionID: string } }) => void) => { events.set(type, handler); return () => undefined; } },
      slots: { register: () => "opencode-langgraph" },
      renderer: { requestRender: () => { renders++; } },
      keymap: {
        registerLayer: (layer: { commands: typeof commands; bindings?: typeof bindings }) => { commands.push(...layer.commands); bindings.push(...(layer.bindings ?? [])); return () => undefined; },
        createKeyMatcher: () => () => false,
        intercept: () => () => undefined,
      },
      ui: {
        dialog: { replace: (render: () => unknown) => { dialogs.push(String(render())); }, clear: () => undefined },
        toast: () => undefined,
        DialogAlert: (props: { title: string }) => props.title,
        DialogSelect: (props: { title: string }) => props.title,
      },
      mode: { current: () => "base" },
    };
    try {
      await tui(api as never, undefined, {} as never);
      commands.find((command) => command.name === "langgraph.graph.toggle")?.run();
      expect(readHomeGraphState(project, stateHome)).toEqual({ enabled: true });
      expect(renders).toBe(1);
      events.get("session.created")?.({ properties: { sessionID: "root-session", info: { directory: project } } } as never);
      expect(readSessionGraphEnabled("root-session", stateHome)).toBe(true);
      expect(readHomeGraphState(project, stateHome)).toBeUndefined();
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations).toEqual([{ name: "langgraph.graph", params: { runs: true } }]);
      expect(dialogs).toEqual([]);
      writeStoredRun({
        runId: "run-root", rootSessionId: "root-session", userMessageId: "message", graph: "default", task: "test",
        directory: project, worktree: project, status: "completed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "run-root", rootSessionId: "root-session", graph: "default",
        node: "answer", status: "completed", agent: "planner", model: "test/model",
      });
      events.get("tui.session.select")?.({ properties: { sessionID: "root-session" } });
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations.at(-1)).toEqual({ name: "langgraph.graph", params: { sessionID: "root-session" } });
      expect(commands.map((command) => command.name)).toContain("langgraph.graph.select");
      expect(bindings).toContainEqual({ key: "f7", cmd: "langgraph.graph.toggle", desc: "Toggle LangGraph" });
      expect(bindings).toContainEqual({ key: "f9", cmd: "langgraph.graph.help", desc: "LangGraph help" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });
});
