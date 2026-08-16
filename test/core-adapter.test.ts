import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { server } from "../src/opencode/server.js";
import { effectivePrompt, graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, tui, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readStoredRun, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { ConnectorDefinition } from "../src/core/types.js";
import { applyDecision, applyVerification, implementationOrder, liveNodeCount, mergeResearch, nextImplementationLeaf, reopenFailedPlan } from "../src/core/progressive-lod/plan.js";
import { ClassificationSchema, DEFAULT_ROLE_LIMITS, DetailDecisionSchema, SCOPE_BUDGETS, type DetailDecision, type ProgressiveLodState } from "../src/core/progressive-lod/types.js";
import { branchProjection, progressiveLodGraph } from "../src/core/progressive-lod/graph.js";
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

  it("uses the production progressive-LOD workflow as the zero-config preset", async () => {
    const project = temp("opencode-langgraph-config-");
    const definition = await loadConnectorDefinition(project);
    expect(definition.defaultGraph).toBe("progressive-lod");
    expect(definition.models["scout-model"]).toEqual({ backend: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(definition.models["decider-model"]).toEqual({ backend: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(definition.agents.classifier).toMatchObject({ model: "classifier-model", maxSteps: 2, tools: { read: false, grep: false, glob: false, bash: false, skill: false, lsp: false, batch: false } });
    expect(definition.agents.classifier.opencodeAgent).toBe("langgraph-classifier");
    expect(definition.agents.answer.model).toBe("answer-model");
    expect(definition.agents.scout).toMatchObject({ model: "scout-model", maxSteps: 16, tools: { bash: false, edit: false, task: false, skill: false } });
    expect(definition.agents.decider).toMatchObject({ model: "decider-model", maxSteps: 2, tools: { read: false, bash: false } });
    expect(definition.agents.decider.opencodeAgent).toBe("langgraph-decider");
    expect(definition.agents.verifier).toMatchObject({ model: "verifier-model", maxSteps: 12, tools: { bash: true, edit: false } });
    expect(definition.agents.implementer).toMatchObject({ model: "implementer-model", maxSteps: 32, tools: { task: false } });
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "progressive-lod"');
    expect((await loadConnectorDefinition(project)).graphs["progressive-lod"]).toBeDefined();
  });

  it("applies preset model, role, and scope-budget overrides", async () => {
    const project = temp("opencode-langgraph-options-");
    const file = writeConnectorConfig(project);
    fs.writeFileSync(file, `import { defineOpenCodeLangGraph } from "opencode-langgraph";\nexport default defineOpenCodeLangGraph({ version: 1, preset: "progressive-lod", options: { models: { scout: "provider/cheap", implementer: "provider/strong" }, roleLimits: { scout: { maxTurns: 3 } }, budgets: { local: { calls: 7, maxCost: 0.02 } } } });\n`);
    const definition = await loadConnectorDefinition(project);
    expect(definition.models["scout-model"]).toEqual({ backend: "opencode", model: "provider/cheap" });
    expect(definition.models["implementer-model"]).toEqual({ backend: "opencode", model: "provider/strong" });
    expect(definition.agents.scout.maxSteps).toBe(3);
    const initial = definition.graphs["progressive-lod"].initial({ task: "x", directory: project, worktree: project, runId: "x" }) as ProgressiveLodState;
    expect(initial.roleLimits.scout.maxTurns).toBe(3);
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
    expect(prompts[1].body.parts[0].text).toContain("previous response was incomplete or failed its output contract");
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

describe("progressive planning reducer", () => {
  const state = (): ProgressiveLodState => ({
    stateVersion: 2, runId: "run", originalTask: "change", directory: "/repo", worktree: "/repo", phase: "planning",
    profile: { route: "planned_change", scope: "subsystem", goal: "change", questions: ["Which behavior must change?"] },
    budget: SCOPE_BUDGETS.subsystem, roleLimits: DEFAULT_ROLE_LIMITS,
    plan: [{ id: "p1", title: "root", description: "root", level: "behavioral outcome", depth: 0, status: "active", dependencies: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0, scoutSessionId: "scout-root", scoutSessionMode: "continue", scoutTurns: 2 }],
    activeNodeId: "p1", evidence: [], constraints: [], decisions: {}, usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 1, nextId: 2, startedAt: Date.now(), implementationSessions: {}, implementationResults: {}, repairAttempts: 0, budgetGrants: {}, humanQuestion: "", humanAnswer: "", result: "",
  });
  const leaf = { objective: "change behavior", targets: ["src/a.ts"], acceptanceCriteria: ["behavior is correct"], verification: ["npm test"] };
  it("uses compact route and disposition-specific contracts", () => {
    expect(ClassificationSchema.parse({ route: "direct_change", scope: "local", goal: "fix typo" }).route).toBe("direct_change");
    expect(() => ClassificationSchema.parse({ route: "planned_change", scope: "local", goal: "unclear change" })).toThrow();
    expect(DetailDecisionSchema.parse({ disposition: "refine", child: { key: "next", title: "Find owner", question: "Which module owns this behavior?", dependencies: [] } })).toMatchObject({ disposition: "refine" });
    expect(DetailDecisionSchema.parse({ disposition: "ready", ...leaf, children: [] })).toEqual({ disposition: "ready", ...leaf });
  });

  it("makes split children pending, resolves dependencies, and forks branch context", () => {
    const merged = applyDecision(state(), { disposition: "split", children: [
      { key: "base", title: "Base", question: "What is the base contract?", dependencies: [] },
      { key: "consumer", title: "Consumer", question: "How does the consumer integrate?", dependencies: ["base"] },
    ] }, "langgraph-decider");
    expect(liveNodeCount(merged.plan)).toBe(2);
    expect(merged.plan[0].status).toBe("expanded");
    expect(merged.plan.find((node) => node.title === "Base")).toMatchObject({ id: "p2", status: "active", scoutSessionMode: "fork", agents: ["langgraph-decider"] });
    expect(merged.plan.find((node) => node.title === "Consumer")).toMatchObject({ id: "p3", status: "pending", dependencies: ["p2"], scoutSessionMode: "fork" });
  });

  it("deduplicates evidence and omits unrelated branch descriptions", () => {
    const current = state();
    current.plan[0] = { ...current.plan[0], description: current.originalTask };
    const first = mergeResearch(current, { evidence: [{ claim: "entry", source: "src/a.ts:1", excerpt: "entry", kind: "repository", confidence: 1 }], constraints: [], unknowns: [] });
    const second = mergeResearch({ ...current, ...first }, { evidence: [{ claim: "entry", source: "src/a.ts:1", excerpt: "entry", kind: "repository", confidence: 1 }], constraints: [], unknowns: [] });
    expect(second.evidence).toHaveLength(1);
    current.plan.push({ ...current.plan[0], id: "p2", parentId: "p1", depth: 1, status: "active", description: "active description" }, { ...current.plan[0], id: "p3", parentId: "p1", depth: 1, status: "ready", description: "UNRELATED FULL DESCRIPTION" });
    current.activeNodeId = "p2";
    current.constraints = [
      { id: "c1", text: "global", source: "user" },
      { id: "c2", text: "active only", source: "src/a.ts", nodeId: "p2" },
      { id: "c3", text: "sibling only", source: "src/b.ts", nodeId: "p3" },
    ];
    const projection = JSON.stringify(branchProjection(current));
    expect(projection).toContain("active description");
    expect(projection).toContain('"title":"root"');
    expect(projection).not.toContain("UNRELATED FULL DESCRIPTION");
    expect(projection).toContain("active only");
    expect(projection).not.toContain("sibling only");
    expect(projection).not.toContain("contextCycles");
  });

  it("orders leaves and reopens only the failed branch parent", () => {
    const root = { ...state().plan[0], status: "expanded" as const };
    const leaves = [
      { ...root, id: "p2", parentId: "p1", title: "base", status: "ready" as const, leaf },
      { ...root, id: "p3", parentId: "p1", title: "consumer", status: "ready" as const, dependencies: ["p2"], leaf },
    ];
    expect(implementationOrder(leaves).map((node) => node.id)).toEqual(["p2", "p3"]);
    const implemented = leaves.map((node) => ({ ...node, status: "implemented" as const }));
    const verified = applyVerification([root, ...implemented], { passed: false, summary: "consumer mismatch", checks: [], failedNodeIds: ["p3"], repairable: false, architecturalMismatch: true });
    expect(verified.find((node) => node.id === "p2")?.status).toBe("verified");
    const reopened = reopenFailedPlan(verified, ["p3"], 2);
    expect(reopened).toMatchObject({ activeNodeId: "p1", reopenedNodeIds: ["p1"] });
    expect(reopened.plan.filter((node) => node.parentId === "p1").every((node) => node.status === "removed")).toBe(true);
  });

  it("waits for descendant leaves when a prerequisite concern was expanded", () => {
    const base = state().plan[0];
    const nodes = [
      { ...base, status: "expanded" as const },
      { ...base, id: "p2", parentId: "p1", status: "expanded" as const },
      { ...base, id: "p3", parentId: "p1", status: "ready" as const, dependencies: ["p2"], leaf },
      { ...base, id: "p4", parentId: "p2", status: "ready" as const, dependencies: [], leaf },
    ];
    expect(nextImplementationLeaf(nodes)?.id).toBe("p4");
    expect(implementationOrder(nodes).map((node) => node.id)).toEqual(["p4", "p3"]);
  });
});

describe("progressive planning graph", () => {
  const verifierWorkspace = { langgraphPrepareVerifierWorkspace: async () => "/repo", langgraphReleaseVerifierWorkspace: async () => {} };
  it("scouts branches, implements one cohesive leaf per session, and verifies once", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string; session?: { strategy: string; sessionId?: string } }> = [];
    const runtime = { call: async (input: { node: string; prompt: string; session?: { strategy: string; sessionId?: string } }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", sessionId: "classifier", structured: { route: "planned_change", scope: "local", goal: "align two seams", questions: ["Which seams must align?"] } };
      if (input.node.startsWith("scout:")) return { text: "", sessionId: `s-${input.node}`, tools: [{ tool: "read", status: "completed", title: "src/a.ts", input: { filePath: "src/a.ts" } }], structured: { facts: [{ text: "source exists", source: "src/a.ts:1" }], constraints: [], unknowns: [] } };
      if (input.node === "decide:p1") return { text: "", sessionId: "decider", structured: decisionValue("split", undefined, [
        { key: "base", title: "Base contract", question: "BASE FULL DESCRIPTION", dependencies: [] },
        { key: "consumer", title: "Consumer seam", question: "CONSUMER FULL DESCRIPTION", dependencies: ["base"] },
      ]) };
      if (input.node.startsWith("decide:")) return { text: "", sessionId: "decider", structured: decisionValue("ready", { objective: `Implement ${input.node}`, targets: [`src/${input.node.slice(-2)}.ts`], acceptanceCriteria: ["works"], verification: ["npm test"] }) };
      if (input.node.startsWith("implement:")) return { text: "", sessionId: `i-${input.node}`, structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [{ name: "test", passed: true, evidence: "ok" }] } };
      if (input.node === "verify") return { text: "", sessionId: "verifier", structured: { verdict: "pass", checks: [{ name: "aggregate", passed: true, evidence: "ok" }] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "align", directory: "/repo", worktree: "/repo", runId: "bounded" }), { recursionLimit: 128, configurable: { thread_id: "bounded", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 10 });
    expect(calls.filter((call) => call.node.startsWith("implement:")).map((call) => call.node)).toEqual(["implement:p2", "implement:p3"]);
    expect(calls.filter((call) => call.node === "verify")).toHaveLength(1);
    expect(calls.every((call) => { try { JSON.parse(call.prompt); return true; } catch { return false; } })).toBe(true);
    expect(JSON.parse(calls.find((call) => call.node === "scout:p1")!.prompt).concern.questions).toEqual(["Which seams must align?"]);
    const firstDecisionPrompt = calls.find((call) => call.node === "decide:p1")!.prompt;
    expect(JSON.parse(firstDecisionPrompt).facts).toEqual([expect.objectContaining({ text: "source exists", source: "src/a.ts:1" })]);
    expect(JSON.parse(firstDecisionPrompt).facts[0]).toMatchObject({ kind: "repository", confidence: 1 });
    expect(firstDecisionPrompt.match(/source exists/g)).toHaveLength(1);
    expect(firstDecisionPrompt).not.toContain('"research"');
    expect(calls.find((call) => call.node === "scout:p2")?.session).toEqual({ strategy: "fork", sessionId: "s-scout:p1" });
    expect(calls.find((call) => call.node === "scout:p3")?.prompt).not.toContain("BASE FULL DESCRIPTION");
    expect(JSON.parse(calls.find((call) => call.node === "scout:p3")!.prompt).dependencies[0]).toMatchObject({ id: "p2", leaves: [{ id: "p2", contract: { objective: "Implement decide:p2" } }] });
    expect(JSON.parse(calls.find((call) => call.node === "implement:p3")!.prompt).dependencies[0]).toMatchObject({ id: "p2", leaves: [{ id: "p2", contract: { objective: "Implement decide:p2" }, artifacts: { changedFiles: ["src/a.ts"] } }] });
    expect(JSON.parse(calls.find((call) => call.node === "implement:p2")!.prompt).grounding[0]).toMatchObject({ text: "source exists", kind: "repository" });
    expect(configured.result?.(result)).toContain("Verified 2 implementation leaves");
  });

  it("sends a bounded change directly to implementation and verification", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string }> = [];
    const runtime = { call: async (input: { node: string; prompt: string }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", structured: { route: "direct_change", scope: "local", goal: "fix typo", questions: ["irrelevant surplus"] } };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [] } };
      if (input.node === "verify") return { text: "", structured: { verdict: "pass", checks: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "fix /repo/src/a.ts", directory: "/repo", worktree: "/repo", runId: "short" }), { configurable: { thread_id: "short", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 3 });
    expect(configured.progress?.(result)?.nodes).toEqual([expect.objectContaining({ id: "p1", status: "verified" })]);
    expect(calls.map((call) => call.node)).toEqual(["classify", "implement:p1", "verify"]);
    expect(JSON.parse(calls[1].prompt)).toEqual(expect.objectContaining({ leafId: "p1", constraints: [], dependencies: [] }));
    expect(calls[1].prompt).not.toContain("contextCycles");
    expect(calls[2].prompt).not.toContain("/repo");
    expect(calls[2].prompt).toContain("./src/a.ts");
  });

  it("replans a blocked direct change and sends repair only its findings", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", repairAgent: "repair", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string; session?: { strategy: string; sessionId?: string } }> = [];
    let implementations = 0;
    let verifications = 0;
    const runtime = { call: async (input: { node: string; prompt: string; session?: { strategy: string; sessionId?: string } }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", structured: { route: "direct_change", scope: "local", goal: "fix ownership" } };
      if (input.node === "implement:p1" && implementations++ === 0) return { text: "", sessionId: "impl", structured: { status: "blocked", changedFiles: [], checks: [], blocker: "ownership is unclear" } };
      if (input.node === "scout:p1") return { text: "", sessionId: "scout", structured: { facts: [{ text: "src/a.ts owns it", source: "src/a.ts:1" }], constraints: [], unknowns: [] } };
      if (input.node === "decide:p1") return { text: "", structured: decisionValue("ready", { objective: "fix ownership", targets: ["src/a.ts"], acceptanceCriteria: ["owner fixed"], verification: ["npm test"] }) };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [{ name: "test", passed: true, evidence: "ok" }] } };
      if (input.node === "verify" && verifications++ === 0) return { text: "", sessionId: "verify", structured: { verdict: "repair", findings: [{ leafId: "p1", problem: "edge case fails", evidence: "focused test" }] } };
      if (input.node === "repair:p1") return { text: "", sessionId: "impl", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [{ name: "test", passed: true, evidence: "fixed" }] } };
      if (input.node === "verify") return { text: "", sessionId: "verify", structured: { verdict: "pass", checks: [{ name: "test", passed: true, evidence: "ok" }] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "fix ownership", directory: "/repo", worktree: "/repo", runId: "fallback" }), { recursionLimit: 128, configurable: { thread_id: "fallback", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed" });
    expect(calls.map((call) => call.node)).toEqual(["classify", "implement:p1", "scout:p1", "decide:p1", "implement:p1", "verify", "repair:p1", "verify"]);
    const reopenedScoutPrompt = JSON.parse(calls.find((call) => call.node === "scout:p1")!.prompt);
    expect(reopenedScoutPrompt.issues).toEqual([{ source: "implementation", leafId: "p1", text: "ownership is unclear" }]);
    expect(JSON.parse(calls.find((call) => call.node === "decide:p1")!.prompt).facts[0]).toMatchObject({ kind: "inference", confidence: .6 });
    expect(JSON.parse(calls.find((call) => call.node === "repair:p1")!.prompt)).toEqual({ leafId: "p1", findings: ["edge case fails — focused test"] });
    expect(calls.filter((call) => call.node === "implement:p1")[1].session).toEqual({ strategy: "fresh" });
    expect(calls.filter((call) => call.node === "verify").map((call) => call.session)).toEqual([{ strategy: "fresh" }, { strategy: "fresh" }]);
  });

  it("carries verifier replan findings forward and excludes stale descendants", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string }> = [];
    let rootDecisions = 0;
    let verifications = 0;
    const runtime = { call: async (input: { node: string; prompt: string }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", structured: { route: "planned_change", scope: "subsystem", goal: "change seams", questions: ["Which seams?"] } };
      if (input.node.startsWith("scout:")) return { text: "", structured: { facts: [], constraints: [], unknowns: [] } };
      if (input.node === "decide:p1" && rootDecisions++ === 0) return { text: "", structured: { disposition: "split", children: [
        { key: "a", title: "A", question: "A?", dependencies: [] }, { key: "b", title: "B", question: "B?", dependencies: ["a"] },
      ] } };
      if (input.node.startsWith("decide:") && input.node !== "decide:p1") return { text: "", structured: { disposition: "ready", objective: input.node, targets: ["src/a.ts"], acceptanceCriteria: ["works"], verification: ["npm test"] } };
      if (input.node === "decide:p1") return { text: "", structured: { disposition: "ready", objective: "corrected contract", targets: ["src/final.ts"], acceptanceCriteria: ["correct"], verification: ["npm test"] } };
      if (input.node.startsWith("implement:")) return { text: "", structured: { status: "completed", changedFiles: [`${input.node}.ts`], checks: [] } };
      if (input.node === "verify" && verifications++ === 0) return { text: "", structured: { verdict: "replan", findings: [{ leafId: "p3", problem: "contract omitted integration", evidence: "src/b.ts:7" }] } };
      if (input.node === "verify") return { text: "", structured: { verdict: "pass", checks: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "change seams", directory: "/repo", worktree: "/repo", runId: "replan" }), { recursionLimit: 128, configurable: { thread_id: "replan", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } });
    const reopenedScout = calls.filter((call) => call.node === "scout:p1")[1];
    expect(JSON.parse(reopenedScout.prompt).issues).toEqual([{ source: "verification", leafId: "p3", text: "contract omitted integration — src/b.ts:7" }]);
    const finalVerifierLeaves = JSON.parse(calls.filter((call) => call.node === "verify")[1].prompt).leaves;
    expect(finalVerifierLeaves.map((leaf: { leafId: string }) => leaf.leafId)).toEqual(["p1"]);
    expect(configured.result?.(result)).toContain("p1:");
    expect(configured.result?.(result)).not.toContain("p2:");
    expect(configured.result?.(result)).not.toContain("p3:");
  });

  it("passes a human answer once, then retains it as a scoped constraint", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string }> = [];
    let decisions = 0;
    const runtime = { call: async (input: { node: string; prompt: string }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", structured: { route: "planned_change", scope: "local", goal: "choose", questions: ["Which choice?"] } };
      if (input.node === "scout:p1") return { text: "", structured: { facts: [], constraints: [], unknowns: ["choice"] } };
      if (input.node === "decide:p1" && decisions++ === 0) return { text: "", structured: { disposition: "interrupt", question: "Which color?" } };
      if (input.node === "decide:p1") return { text: "", structured: { disposition: "ready", objective: "use blue", targets: ["src/a.ts"], acceptanceCriteria: ["blue"], verification: ["npm test"] } };
      if (input.node === "implement:p1") return { text: "", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [] } };
      if (input.node === "verify") return { text: "", structured: { verdict: "pass", checks: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const config = { recursionLimit: 64, configurable: { thread_id: "human", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } };
    const paused = await configured.graph.invoke(configured.initial({ task: "choose", directory: "/repo", worktree: "/repo", runId: "human" }), config);
    expect(isInterrupted(paused)).toBe(true);
    await configured.graph.invoke(new Command({ resume: "blue" }), config);
    const resumedDecision = JSON.parse(calls.filter((call) => call.node === "decide:p1")[1].prompt);
    expect(resumedDecision.humanAnswer).toBe("blue");
    expect(resumedDecision.constraints).not.toContainEqual(expect.objectContaining({ text: "User decision: blue" }));
    const implementation = JSON.parse(calls.find((call) => call.node === "implement:p1")!.prompt);
    expect(implementation.constraints).toEqual(["User decision: blue"]);
    expect(JSON.stringify(implementation).match(/blue/g)).toHaveLength(3);
  });

  it("automatically forks an aborted child session with all call limits expanded", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const scoutSessions: Array<{ strategy: string; sessionId?: string } | undefined> = [];
    const scoutLimits: Array<Record<string, number | undefined> | undefined> = [];
    let scoutCalls = 0;
    const runtime = { call: async (input: { node: string; limits?: Record<string, number | undefined>; session?: { strategy: string; sessionId?: string } }) => {
      if (input.node === "classify") return { text: "", structured: { route: "planned_change", scope: "local", goal: "bounded", questions: ["What must change?"] } };
      if (input.node === "scout:p1") {
        scoutSessions.push(input.session);
        scoutLimits.push(input.limits);
        scoutCalls++;
        if (scoutCalls === 1) return { text: "", sessionId: "scout-aborted", usage: { turns: 8, input: 30_000, output: 100, reasoning: 0, cacheRead: 100_000, cacheWrite: 0, cost: .01 }, budgetStop: { kind: "budget", metric: "turns", used: 8, limit: 8 } };
        return { text: "", sessionId: "scout-fork", structured: { facts: [], constraints: [], unknowns: [] } };
      }
      if (input.node === "decide:p1") return { text: "", sessionId: "decider", structured: decisionValue("ready", { objective: "fix", targets: ["src/a.ts"], acceptanceCriteria: ["works"], verification: ["npm test"] }) };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [] } };
      if (input.node === "verify") return { text: "", sessionId: "verify", structured: { verdict: "pass", checks: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const config = { recursionLimit: 64, configurable: { thread_id: "budget-continue", langgraphOpenCodeRuntime: runtime, ...verifierWorkspace } };
    const completed = await configured.graph.invoke(configured.initial({ task: "bounded", directory: "/repo", worktree: "/repo", runId: "budget-continue" }), config);
    expect(isInterrupted(completed)).toBe(false);
    expect(configured.progress?.(completed)).toMatchObject({ phase: "completed" });
    expect(scoutSessions).toEqual([{ strategy: "fresh" }, { strategy: "fork", sessionId: "scout-aborted" }]);
    expect(scoutLimits).toEqual([
      expect.objectContaining({ maxTurns: 16, maxCacheReadTokens: 800_000, maxContextTokens: 96_000 }),
      expect.objectContaining({ maxTurns: 32, maxCacheReadTokens: 1_600_000, maxContextTokens: 192_000 }),
    ]);
  });

  it("retains an isolated verifier workspace only across a budget resume", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const prepared: Array<string | undefined> = [];
    let releases = 0;
    let verifies = 0;
    const sessions: unknown[] = [];
    const runtime = { call: async (input: { node: string; directory?: string; worktree?: string; session?: unknown }) => {
      if (input.node === "classify") return { text: "", structured: { route: "direct_change", scope: "local", goal: "fix" } };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", changedFiles: ["src/a.ts"], checks: [] } };
      if (input.node === "verify") {
        sessions.push(input.session);
        expect(input).toMatchObject({ directory: "/mirror", worktree: "/mirror" });
        if (verifies++ === 0) return { text: "", sessionId: "verifier-aborted", budgetStop: { kind: "budget", metric: "turns", used: 12, limit: 12 } };
        return { text: "", sessionId: "verifier-fork", structured: { verdict: "pass", checks: [] } };
      }
      throw new Error(`unexpected node ${input.node}`);
    } };
    const config = { recursionLimit: 64, configurable: {
      thread_id: "verify-budget", langgraphOpenCodeRuntime: runtime,
      langgraphPrepareVerifierWorkspace: async (_runId: string, _worktree: string, existing?: string) => { prepared.push(existing); return existing ?? "/mirror"; },
      langgraphReleaseVerifierWorkspace: async () => { releases++; },
    } };
    const completed = await configured.graph.invoke(configured.initial({ task: "fix", directory: "/repo", worktree: "/repo", runId: "verify-budget" }), config);
    expect(isInterrupted(completed)).toBe(false);
    expect(configured.progress?.(completed)?.phase).toBe("completed");
    expect(prepared).toEqual([undefined, "/mirror"]);
    expect(releases).toBe(1);
    expect(sessions).toEqual([{ strategy: "fresh" }, { strategy: "fork", sessionId: "verifier-aborted" }]);
  });

  it("does not acquire the worktree for direct answers", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    let leases = 0;
    const runtime = { call: async (input: { node: string }) => input.node === "classify"
      ? { text: "", structured: { route: "answer", scope: "local", goal: "explain" } }
      : { text: "direct answer" } };
    const result = await configured.graph.invoke(configured.initial({ task: "what?", directory: "/repo", worktree: "/repo", runId: "answer" }), { configurable: { thread_id: "answer", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { leases++; } } });
    expect(leases).toBe(0);
    expect(configured.result?.(result)).toBe("direct answer");
  });
});

function decisionValue(disposition: "ready" | "split", leaf?: { objective: string; targets: string[]; acceptanceCriteria: string[]; verification: string[] }, children: Array<{ key: string; title: string; question: string; dependencies: string[] }> = []) {
  return disposition === "ready" ? { disposition, ...leaf } : { disposition, children };
}

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
  it("persists cross-process cancellation and emits a terminal event", async () => {
    const state = temp("opencode-langgraph-cancel-");
    const project = temp("opencode-langgraph-cancel-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(project, "file.txt"), "value");
      const verifierWorkspace = await prepareVerifierWorkspace("run", project);
      writeStoredRun({ runId: "run", rootSessionId: "root", userMessageId: "message", graph: "progressive-lod", task: "task", directory: project, worktree: project, status: "interrupted" });
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
      messages: async ({ path: requestPath }: { path: { id: string } }) => ({ data: requestPath.id === "root"
        ? ["message-1", "message-command"].map((parentID) => ({ info: { role: "assistant", parentID }, parts: [{ type: "text", text: "The answer is 4." }] }))
        : [{ info: { role: "assistant", ...(titles.get(requestPath.id)?.includes("classify") ? { structured: { route: "answer", scope: "local", goal: "answer question" } } : {}) }, parts: [{ type: "text", text: "The answer is 4." }] }],
      }),
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown>; agent?: Record<string, { tools?: Record<string, boolean>; maxSteps?: number; permission?: Record<string, unknown> }> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph", "graph-resume", "graph-cancel"]);
      expect(config.agent?.["langgraph-presenter"]).toMatchObject({ maxSteps: 1, tools: { read: false, bash: false, edit: false, task: false, skill: false } });
      expect(config.agent?.["langgraph-classifier"]).toMatchObject({ maxSteps: 2, tools: { read: false, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-decider"]).toMatchObject({ maxSteps: 2, tools: { read: false, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-scout"]).toMatchObject({ tools: { bash: false, edit: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
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
      expect(events.map((event) => event.node)).toEqual(expect.arrayContaining(["__start__", "answer", "__end__"]));
      expect(new Set(events.map((event) => event.userMessageId))).toEqual(new Set(["message-command", "message-1"]));
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
    expect(graphHelpText()).toContain("G run graph");
    expect(graphHelpText()).toContain("4 prompt");
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

  it("renders semantic progress as a hierarchy with budget state", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "progressive-lod", node: "analyze", status: "active", agent: "analyst", model: "inherit" };
    const tree = renderPlanTree([{ ...base, progress: { phase: "planning", scope: "subsystem", callsUsed: 3, callBudget: 24, activeNodeId: "p2", nodes: [
      { id: "p1", title: "Requested behavior", level: "observable outcome", depth: 0, status: "removed", agents: ["langgraph-classifier"] },
      { id: "p2", parentId: "p1", title: "Session handoff", level: "state transition", depth: 1, status: "active", evidence: 2, confidence: .8, agents: ["langgraph-decider"] },
    ] } }]);
    expect(tree).toContain("PLAN::MATRIX  [PLANNING] [SUBSYSTEM]");
    expect(tree).toContain("CALLS  █░░░░░░░░░ 3/24");
    expect(tree).toContain("└─ ▶ p2  Session handoff");
    expect(tree).toContain("state transition");
    expect(tree).toContain("[LOD:1] [STATUS:ACTIVE] [EVIDENCE:2] [CONF:80%] [DECIDER]");
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
