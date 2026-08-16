import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { buildConversationContext, server } from "../src/opencode/server.js";
import { effectivePrompt, graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, tui, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readStoredRun, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { ConnectorDefinition } from "../src/core/types.js";
import { ensureRunnableWork, initialNetwork, mergeSolutionDelta, propagateNetwork, reopenRegion } from "../src/core/solution-lod/reducer.js";
import { projectActivationContext, solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { SOLUTION_ROLE_CONTRACTS } from "../src/core/solution-lod/roles.js";
import type { SolutionLodState } from "../src/core/solution-lod/types.js";
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
    expect(definition.models["inspect-model"]).toEqual({ backend: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(definition.models["synthesize-model"]).toEqual({ backend: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(definition.agents.inspect).toMatchObject({ model: "inspect-model", maxSteps: 32, tools: { read: true, bash: false, edit: false, task: false } });
    expect(definition.agents.synthesize).toMatchObject({ model: "synthesize-model", maxSteps: 8, tools: { read: false, bash: false } });
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
    expect(initial.stateVersion).toBe(3);
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
    stateVersion: 3, runId: "run", originalTask: "change", conversationContext: "prior decision", directory: "/repo", worktree: "/repo", phase: "forming-root-domain",
    network: initialNetwork("change"), usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, worktreeAcquired: false, result: "",
  });

  it("exposes only the selected candidate's conditional next LOD", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: [] }, evidence: [], constraints: [], activations: [], actionable: false, answer: undefined,
      candidates: [
        { key: "adapter", proposition: "Use an adapter", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [{ key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: ["mapping contract"], acceptanceCriteria: ["mapping is explicit"] }] },
        { key: "rewrite", proposition: "Rewrite the subsystem", outcome: "possible", reasons: [], evidenceRefs: [], nextLod: [{ key: "migration", objective: "Resolve migration", edge: "refines", allowedVariables: ["migration mechanics"], acceptanceCriteria: ["migration works"] }] },
      ], select: ["adapter"],
    });
    expect(merged.regions.find((region) => region.id === "r1")?.status).toBe("collapsed");
    expect(merged.regions.filter((region) => region.parentId === "r1").map((region) => region.key)).toEqual(["mapping"]);
    expect(merged.regions.some((region) => region.key === "migration")).toBe(false);
  });

  it("collapses a repository-backed read-only answer without synthesis or a child LOD", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" },
      evidence: [{ text: "The marker says ready", source: "SMOKE.md:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], actionable: false, activations: [],
      resolvedAnswer: { answer: "ready", acceptanceCriteria: ["Report the marker exactly"], evidenceRefs: ["SMOKE.md:1"] },
    });
    expect(network.regions).toHaveLength(1);
    expect(network.regions[0]).toMatchObject({ delivery: "answer", status: "verified", answer: "ready", selectedCandidateIds: ["r1:resolved-answer"] });
    expect(network.candidates[0]).toMatchObject({ status: "selected", evidenceIds: ["e1"], nextLod: [] });
    network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(true);
    expect(scheduled.network.activations).toHaveLength(1);
  });

  it("allows independent regions to remain at different LODs", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], activations: [], select: ["composed"], actionable: false,
      candidates: [{ key: "composed", proposition: "Resolve two parts", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [
        { key: "api", objective: "API region", edge: "partOf", allowedVariables: ["API family"], acceptanceCriteria: ["API works"] },
        { key: "storage", objective: "Storage region", edge: "partOf", allowedVariables: ["storage family"], acceptanceCriteria: ["storage works"] },
      ] }],
    });
    const api = current.network.regions.find((region) => region.key === "api")!;
    current.network.activations.push({ id: "a99", capability: "synthesize", regionId: api.id, request: "form", expectedDelta: "domain", contextRefs: [api.id], status: "completed", basisRevision: current.network.revision });
    api.activationIds.push("a99");
    current.network = mergeSolutionDelta(current, "a99", { region: {}, evidence: [], constraints: [], activations: [], select: ["direct"], actionable: true, candidates: [{ key: "direct", proposition: "Direct API", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }] });
    expect(current.network.regions.find((region) => region.key === "api")?.status).toBe("actionable");
    expect(current.network.regions.find((region) => region.key === "storage")?.status).toBe("unformed");
  });

  it("propagates requires and refutes constraints to collapse", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [{ text: "rewrite is incompatible", source: "src/a.ts:1", kind: "repository" }], activations: [], actionable: false,
      candidates: [
        { key: "adapter", proposition: "Adapter", outcome: "possible", reasons: [], evidenceRefs: [], nextLod: [] },
        { key: "rewrite", proposition: "Rewrite", outcome: "possible", reasons: [], evidenceRefs: [], nextLod: [] },
      ], constraints: [{ kind: "refutes", subject: "e1", target: "rewrite", reason: "incompatible contract" }], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "rewrite")?.status).toBe("eliminated");
    expect(merged.candidates.find((candidate) => candidate.key === "adapter")?.status).toBe("selected");
    expect(merged.regions[0].status).toBe("actionable");
  });

  it("canonicalizes region-prefixed candidate keys and drops dangling constraints", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [], actionable: true,
      candidates: [{ key: "r1:direct", proposition: "Direct extension", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }],
      constraints: [{ kind: "requires", subject: "imaginary-subject", target: "imaginary-target", reason: "decorative prose" }],
      select: ["r1:direct"],
    });
    expect(network.candidates.map((candidate) => candidate.id)).toEqual(["r1:direct"]);
    expect(network.regions[0].selectedCandidateIds).toEqual(["r1:direct"]);
    expect(network.constraints).toEqual([]);
  });

  it("makes a collapsed leaf actionable even when synthesis omits its optional flag", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], activations: [], select: ["direct"],
      candidates: [{ key: "direct", proposition: "Implement the selected family", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }],
    });
    expect(network.regions[0]).toMatchObject({ status: "actionable", acceptanceCriteria: ["change"] });
  });

  it("ignores resolvedAnswer injected into a change-delivery synthesis delta", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "change", acceptanceCriteria: ["files change"] }, evidence: [], constraints: [], activations: [], select: ["direct"],
      candidates: [{ key: "direct", proposition: "Implement it", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }],
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
    network.candidates.push({ id: "r3:choice", regionId: "r3", key: "choice", proposition: "choice", status: "selected", evidenceIds: [], eliminationReasons: [], nextLod: [] });
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
    current.network.candidates.push({ id: "r1:direct", regionId: "r1", key: "direct", proposition: "Extend the existing implementation", status: "selected", evidenceIds: [], eliminationReasons: [], nextLod: [] });
    current.network.regions[0].candidateIds = ["r1:direct"];
    current.network.regions[0].selectedCandidateIds = ["r1:direct"];
    const implement = { ...current.network.activations[0], capability: "implement" as const, request: "Implement the selected behavior" };
    const projection = projectActivationContext(current, implement);
    expect(projection).toMatchObject({
      currentTask: "change",
      successCriteria: ["target behavior works"],
      decisionsAlreadyMade: ["Extend the existing implementation"],
      selectedApproach: ["Extend the existing implementation"],
    });
    expect(projection).not.toHaveProperty("region");
    expect(projection).not.toHaveProperty("collapsedAncestry");
    expect(projection).not.toHaveProperty("domain");
    expect(projection).not.toHaveProperty("availableCapabilities");
  });

  it("deduplicates unchanged activations and reports convergence instead of looping", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    const first = ensureRunnableWork(network);
    expect(first.network.activations.at(-1)).toMatchObject({ capability: "synthesize", status: "queued" });
    first.network.activations.at(-1)!.status = "completed";
    const second = ensureRunnableWork(first.network);
    expect(second.blocked).toContain("No activation can make a novel state delta");
    expect(second.network.activations).toHaveLength(2);
  });

  it("collapses an equivalent surviving set as one implementer-local choice", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["behavior is equivalent"] }, evidence: [], activations: [], actionable: false,
      candidates: [
        { key: "a", proposition: "Equivalent implementation A", outcome: "possible", reasons: [], evidenceRefs: [], nextLod: [] },
        { key: "b", proposition: "Equivalent implementation B", outcome: "possible", reasons: [], evidenceRefs: [], nextLod: [] },
      ], constraints: [{ kind: "equivalent", subject: "a", target: "b", reason: "same external contract" }], select: ["a"],
    });
    expect(network.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:a", "r1:b"] });
  });

  it("rejects multiple selected non-equivalent alternatives in one region", () => {
    const current = state();
    const invalid = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["one coherent design"] }, evidence: [], constraints: [], activations: [], actionable: true,
      candidates: [
        { key: "event-shape", proposition: "Choose an event shape", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] },
        { key: "duplicate-policy", proposition: "Choose a duplicate policy", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] },
      ], select: ["event-shape", "duplicate-policy"],
    });
    expect(invalid.regions[0]).toMatchObject({ status: "contradiction", selectedCandidateIds: [] });
    expect(invalid.regions[0].contradiction).toContain("multiple non-equivalent alternatives");

    const correcting = { ...current, network: invalid };
    correcting.network.activations.push({ id: "a2", capability: "synthesize", regionId: "r1", request: "correct", expectedDelta: "coherent-domain", contextRefs: ["r1"], status: "running", basisRevision: invalid.revision });
    const corrected = mergeSolutionDelta(correcting, "a2", {
      region: {}, evidence: [], constraints: [], activations: [], actionable: true,
      candidates: [{ key: "coherent", proposition: "One complete event-store design", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }], select: ["coherent"],
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
});

describe("solution LOD graph", () => {
  it("executes a collapsed region and verifies it without a fixed role pipeline", async () => {
    const directory = temp("solution-lod-graph-");
    fs.writeFileSync(path.join(directory, "target.txt"), "before");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const calls: string[] = [];
    const runtime = { call: async (input: { node: string }) => {
      calls.push(input.node);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: ["e1"] }] } };
      if (input.node === "synthesize:r1") return { text: "", structured: { region: {}, evidence: [], candidates: [{ key: "direct", proposition: "Update target", outcome: "selected", reasons: [], evidenceRefs: ["e1"], nextLod: [] }], constraints: [], select: ["direct"], actionable: true, answer: "stale pre-implementation design", activations: [] } };
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
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
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
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async (input: { node: string }) => {
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["files updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "change files", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }], constraints: [], select: ["direct"], actionable: true, activations: [] } };
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
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    let first = true;
    const runtime = { call: async (input: { node: string }) => {
      if (first && input.node === "inspect:r1") { first = false; return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [{ key: "direct", proposition: "update target", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }], constraints: [], select: ["direct"], actionable: true, activations: [] } }; }
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
      writeStoredRun({ checkpointVersion: 3, runId: "run", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project, status: "interrupted" });
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
          ? { region: { delivery: "answer", acceptanceCriteria: ["Answer the question"] }, evidence: [{ text: "2+2 is 4", source: "arithmetic", kind: "inference" }], candidates: [{ key: "answer", proposition: "Answer directly", outcome: "selected", reasons: [], evidenceRefs: [], nextLod: [] }], constraints: [], select: ["answer"], actionable: true, activations: [] }
          : title.includes("present:r1") ? { answer: "The answer is 4." } : undefined;
        return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: "The answer is 4." }] }] };
      },
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown>; agent?: Record<string, { tools?: Record<string, boolean>; maxSteps?: number; permission?: Record<string, unknown> }> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph", "graph-resume", "graph-cancel"]);
      expect(config.agent?.["langgraph-presenter"]).toMatchObject({ maxSteps: 1, tools: { read: false, bash: false, edit: false, task: false, skill: false } });
      expect(config.agent?.["langgraph-inspector"]).toMatchObject({ maxSteps: 32, tools: { read: true, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-synthesizer"]).toMatchObject({ maxSteps: 8, tools: { read: false, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-verifier"]).toMatchObject({ tools: { bash: true, edit: false, skill: false }, permission: { bash: "allow", edit: "deny", external_directory: "deny" } });
      expect(hooks.tool).toBeUndefined();
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
      deadline = Date.now() + 2_000;
      while ((child < 4 || posted.length < 6) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child).toBe(4);
      expect(posted).toHaveLength(6);
      expect(posted.at(-1)).toMatchObject({ body: { agent: "langgraph-presenter", tools: { read: false, bash: false, edit: false, task: false } } });
      const events = readPluginEvents("root");
      expect(events.map((event) => event.node)).toEqual(expect.arrayContaining(["__start__", "inspect:r1", "present:r1", "__end__"]));
      expect(new Set(events.map((event) => event.userMessageId))).toEqual(new Set(["message-command", "message-1"]));
      expect(events.find((event) => event.userMessageId === "message-1" && event.node === "__start__")?.state).toMatchObject({
        originalTask: "What is 2+2?",
        conversationContext: "ASSISTANT: The answer is 4.\nASSISTANT: The answer is 4.",
      });
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
    expect(graphHelpText()).toContain("G topology");
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
      ["q", "back"], ["tab", "cycle"], ["1", "graph"], ["2", "nodes"], ["o", "output"],
      ["4", "prompt"], ["t", "state"], ["return", "inspect"], ["up", "up"], ["j", "down"], ["left", "left"],
      ["d", "right"], ["pageup", "pageUp"], ["pagedown", "pageDown"], ["home", "home"], ["end", "end"],
    ] as const) {
      const binding = layer.bindings.find((candidate) => candidate.key === key);
      expect(binding).toBeDefined();
      commandByName.get(binding!.cmd)?.run();
      expect(calls.pop()).toBe(key === "g" ? "topology" : expected);
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

  it("opens the project graph when no chat session exists yet", async () => {
    const project = temp("opencode-langgraph-project-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    let commands: Array<{ name: string; run: () => void }> = [];
    const bindings: Array<{ key: string; cmd: string }> = [];
    const events = new Map<string, (event: { properties: { sessionID: string } }) => void>();
    const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
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
      expect(navigations).toEqual([{ name: "langgraph.graph", params: undefined }]);
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
