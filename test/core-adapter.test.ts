import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { server } from "../src/opencode/server.js";
import { graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, tui, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readStoredRun, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { ConnectorDefinition } from "../src/core/types.js";
import { applyDecision, applyVerification, implementationOrder, liveNodeCount, mergeResearch, nextImplementationLeaf, reopenFailedPlan } from "../src/core/progressive-lod/plan.js";
import { ClassificationSchema, DEFAULT_ROLE_LIMITS, DetailDecisionSchema, SCOPE_BUDGETS, type DetailDecision, type ProgressiveLodState } from "../src/core/progressive-lod/types.js";
import { branchProjection, progressiveLodGraph } from "../src/core/progressive-lod/graph.js";
import { DurableFileSaver } from "../src/core/durable-checkpointer.js";
import { acquireWorktree } from "../src/opencode/worktree-lock.js";

function graph(terminates = true) {
  const State = Annotation.Root({ result: Annotation<string> });
  const builder = new StateGraph(State).addNode("work", () => ({ result: "ok" })).addEdge(START, "work");
  if (terminates) builder.addEdge("work", END);
  return builder.compile({ checkpointer: new MemorySaver() });
}

describe("typed graph validation", () => {
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
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-config-"));
    const definition = await loadConnectorDefinition(project);
    expect(definition.defaultGraph).toBe("progressive-lod");
    expect(definition.models["scout-model"]).toEqual({ backend: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(definition.agents.classifier).toMatchObject({ model: "classifier-model", maxSteps: 2, tools: { read: false, grep: false, glob: false, bash: false } });
    expect(definition.agents.answer.model).toBe("answer-model");
    expect(definition.agents.scout).toMatchObject({ model: "scout-model", maxSteps: 8, tools: { edit: false, task: false } });
    expect(definition.agents.decider).toMatchObject({ model: "decider-model", maxSteps: 2, tools: { read: false, bash: false } });
    expect(definition.agents.verifier).toMatchObject({ model: "verifier-model", maxSteps: 12 });
    expect(definition.agents.implementer).toMatchObject({ model: "implementer-model", maxSteps: 32, tools: { task: false } });
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "progressive-lod"');
    expect((await loadConnectorDefinition(project)).graphs["progressive-lod"]).toBeDefined();
  });

  it("applies preset model, role, and scope-budget overrides", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-options-"));
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
      expect.objectContaining({ node: "plan", status: "active", state: {} }),
      expect.objectContaining({ node: "plan", status: "completed", text: "actual answer", state: {} }),
    ]));
  });

  it("runs command models through stdin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-command-"));
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
    profile: { route: "change", scope: "subsystem", summary: "change", planningFrame: "behavioral outcome", readOnly: false, risks: [] },
    budget: SCOPE_BUDGETS.subsystem, roleLimits: DEFAULT_ROLE_LIMITS,
    plan: [{ id: "p1", title: "root", description: "root", level: "behavioral outcome", depth: 0, status: "active", dependencies: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0, scoutSessionId: "scout-root", scoutSessionMode: "continue", scoutTurns: 2 }],
    activeNodeId: "p1", evidence: [], constraints: [], decisions: {}, usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 1, nextId: 2, startedAt: Date.now(), implementationSessions: {}, implementationResults: {}, repairAttempts: 0, budgetGrants: {}, humanQuestion: "", humanAnswer: "", result: "",
  });
  const leaf = { objective: "change behavior", targets: ["src/a.ts"], acceptanceCriteria: ["behavior is correct"], verification: ["npm test"] };
  const decision = (value: Partial<DetailDecision>): DetailDecision => ({ disposition: "ready", summary: "bounded", options: [], selectedOption: "", confidence: 1, question: "", children: [], leaf, ...value });

  it("does not reject a task-derived planning frame because its prose exceeds an arbitrary length", () => {
    const level = "repository-specific planning boundary with a concrete ownership seam ".repeat(20);
    expect(ClassificationSchema.parse({ route: "change", scope: "architectural", summary: "change", planningFrame: level, readOnly: false, risks: [] }).planningFrame).toBe(level);
    expect(DetailDecisionSchema.parse(decision({ disposition: "refine", leaf: undefined, children: [{ key: "next", title: "next", description: "next", level, dependencies: [] }] })).children[0].level).toBe(level);
    expect(() => applyDecision(state(), decision({ disposition: "ready", children: [{ key: "bad", title: "bad", description: "bad", level: "bad", dependencies: [] }] }))).toThrow("no children");
  });

  it("makes split children pending, resolves dependencies, and forks branch context", () => {
    const merged = applyDecision(state(), decision({ disposition: "split", leaf: undefined, children: [
      { key: "base", title: "Base", description: "base", level: "contract", dependencies: [] },
      { key: "consumer", title: "Consumer", description: "consumer", level: "integration", dependencies: ["base"] },
    ] }));
    expect(liveNodeCount(merged.plan)).toBe(2);
    expect(merged.plan[0].status).toBe("expanded");
    expect(merged.plan.find((node) => node.title === "Base")).toMatchObject({ id: "p2", status: "active", scoutSessionMode: "fork" });
    expect(merged.plan.find((node) => node.title === "Consumer")).toMatchObject({ id: "p3", status: "pending", dependencies: ["p2"], scoutSessionMode: "fork" });
  });

  it("deduplicates evidence and omits unrelated branch descriptions", () => {
    const current = state();
    const first = mergeResearch(current, { summary: "found", evidence: [{ claim: "entry", source: "src/a.ts:1", excerpt: "entry", kind: "repository", confidence: 1 }], constraints: [], unresolved: [] });
    const second = mergeResearch({ ...current, ...first }, { summary: "again", evidence: [{ claim: "entry", source: "src/a.ts:1", excerpt: "entry", kind: "repository", confidence: 1 }], constraints: [], unresolved: [] });
    expect(second.evidence).toHaveLength(1);
    current.plan.push({ ...current.plan[0], id: "p2", parentId: "p1", status: "active", description: "active description" }, { ...current.plan[0], id: "p3", parentId: "p1", status: "ready", description: "UNRELATED FULL DESCRIPTION" });
    current.activeNodeId = "p2";
    const projection = JSON.stringify(branchProjection(current));
    expect(projection).toContain("active description");
    expect(projection).toContain('"title":"root"');
    expect(projection).not.toContain("UNRELATED FULL DESCRIPTION");
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
  it("scouts branches, implements one cohesive leaf per session, and verifies once", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const calls: Array<{ node: string; prompt: string; session?: { strategy: string; sessionId?: string } }> = [];
    const runtime = { call: async (input: { node: string; prompt: string; session?: { strategy: string; sessionId?: string } }) => {
      calls.push(input);
      if (input.node === "classify") return { text: "", sessionId: "classifier", structured: { route: "change", scope: "local", summary: "align two seams", planningFrame: "behavior", readOnly: false, risks: [] } };
      if (input.node.startsWith("scout:")) return { text: "", sessionId: `s-${input.node}`, tools: [{ tool: "read", status: "completed", title: "src/a.ts", input: { filePath: "src/a.ts" } }], structured: { summary: `facts for ${input.node}`, evidence: [{ claim: "source exists", source: "src/a.ts:1", excerpt: "export", kind: "repository", confidence: 1 }], constraints: [], unresolved: [] } };
      if (input.node === "decide:p1") return { text: "", sessionId: "decider", structured: decisionValue("split", undefined, [
        { key: "base", title: "Base contract", description: "BASE FULL DESCRIPTION", level: "contract", dependencies: [] },
        { key: "consumer", title: "Consumer seam", description: "CONSUMER FULL DESCRIPTION", level: "integration", dependencies: ["base"] },
      ]) };
      if (input.node.startsWith("decide:")) return { text: "", sessionId: "decider", structured: decisionValue("ready", { objective: `Implement ${input.node}`, targets: [`src/${input.node.slice(-2)}.ts`], acceptanceCriteria: ["works"], verification: ["npm test"] }) };
      if (input.node.startsWith("implement:")) return { text: "", sessionId: `i-${input.node}`, structured: { status: "completed", summary: `done ${input.node}`, changedFiles: ["src/a.ts"], checks: [{ name: "test", passed: true, evidence: "ok" }], blocker: "" } };
      if (input.node === "verify") return { text: "", sessionId: "verifier", structured: { passed: true, summary: "all leaves verified", checks: [{ name: "aggregate", passed: true, evidence: "ok" }], failedNodeIds: [], repairable: false, architecturalMismatch: false } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "align", directory: "/repo", worktree: "/repo", runId: "bounded" }), { recursionLimit: 128, configurable: { thread_id: "bounded", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 10 });
    expect(calls.filter((call) => call.node.startsWith("implement:")).map((call) => call.node)).toEqual(["implement:p2", "implement:p3"]);
    expect(calls.filter((call) => call.node === "verify")).toHaveLength(1);
    expect(calls.find((call) => call.node === "scout:p2")?.session).toEqual({ strategy: "fork", sessionId: "s-scout:p1" });
    expect(calls.find((call) => call.node === "scout:p3")?.prompt).not.toContain("BASE FULL DESCRIPTION");
    expect(configured.result?.(result)).toContain("all leaves verified");
  });

  it("allows a grounded local concern to become a leaf immediately", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const runtime = { call: async (input: { node: string }) => {
      if (input.node === "classify") return { text: "", structured: { route: "change", scope: "local", summary: "fix typo", planningFrame: "single file", readOnly: false, risks: [] } };
      if (input.node === "scout:p1") return { text: "", sessionId: "scout", structured: { summary: "located", evidence: [], constraints: [], unresolved: [] } };
      if (input.node === "decide:p1") return { text: "", sessionId: "decider", structured: decisionValue("ready", { objective: "fix typo", targets: ["src/a.ts"], acceptanceCriteria: ["label fixed"], verification: ["npm test"] }) };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", summary: "fixed", changedFiles: ["src/a.ts"], checks: [], blocker: "" } };
      if (input.node === "verify") return { text: "", structured: { passed: true, summary: "verified", checks: [], failedNodeIds: [], repairable: false, architecturalMismatch: false } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "fix", directory: "/repo", worktree: "/repo", runId: "short" }), { configurable: { thread_id: "short", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 5 });
    expect(configured.progress?.(result)?.nodes).toEqual([expect.objectContaining({ id: "p1", status: "verified" })]);
  });

  it("interrupts on a child budget instead of silently restarting the role", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    let scoutCalls = 0;
    const runtime = { call: async (input: { node: string }) => {
      if (input.node === "classify") return { text: "", structured: { route: "change", scope: "local", summary: "bounded", planningFrame: "behavior", readOnly: false, risks: [] } };
      if (input.node === "scout:p1") { scoutCalls++; return { text: "", sessionId: "scout", usage: { turns: 8, input: 30_000, output: 100, reasoning: 0, cacheRead: 100_000, cacheWrite: 0, cost: .01 }, budgetStop: { kind: "budget", metric: "turns", used: 8, limit: 8 } }; }
      throw new Error(`unexpected node ${input.node}`);
    } };
    const config = { recursionLimit: 64, configurable: { thread_id: "budget", langgraphOpenCodeRuntime: runtime } };
    const paused = await configured.graph.invoke(configured.initial({ task: "bounded", directory: "/repo", worktree: "/repo", runId: "budget" }), config);
    expect(isInterrupted(paused)).toBe(true);
    expect(paused.__interrupt__[0].value).toMatchObject({ kind: "budget", role: "scout", metric: "turns", choices: ["continue", "narrow: …", "stop"] });
    const stopped = await configured.graph.invoke(new Command({ resume: "stop" }), config);
    expect(configured.progress?.(stopped)).toMatchObject({ phase: "failed" });
    expect(configured.result?.(stopped)).toContain("Stopped at the scout turns budget");
    expect(scoutCalls).toBe(1);
  });

  it("forks an aborted child session after a call-budget approval", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", verifierAgent: "verifier", checkpointer: new MemorySaver() });
    const scoutSessions: Array<{ strategy: string; sessionId?: string } | undefined> = [];
    let scoutCalls = 0;
    const runtime = { call: async (input: { node: string; session?: { strategy: string; sessionId?: string } }) => {
      if (input.node === "classify") return { text: "", structured: { route: "change", scope: "local", summary: "bounded", planningFrame: "behavior", readOnly: false, risks: [] } };
      if (input.node === "scout:p1") {
        scoutSessions.push(input.session);
        scoutCalls++;
        if (scoutCalls === 1) return { text: "", sessionId: "scout-aborted", usage: { turns: 8, input: 30_000, output: 100, reasoning: 0, cacheRead: 100_000, cacheWrite: 0, cost: .01 }, budgetStop: { kind: "budget", metric: "turns", used: 8, limit: 8 } };
        return { text: "", sessionId: "scout-fork", structured: { summary: "grounded", evidence: [], constraints: [], unresolved: [] } };
      }
      if (input.node === "decide:p1") return { text: "", sessionId: "decider", structured: decisionValue("ready", { objective: "fix", targets: ["src/a.ts"], acceptanceCriteria: ["works"], verification: ["npm test"] }) };
      if (input.node === "implement:p1") return { text: "", sessionId: "impl", structured: { status: "completed", summary: "fixed", changedFiles: ["src/a.ts"], checks: [], blocker: "" } };
      if (input.node === "verify") return { text: "", sessionId: "verify", structured: { passed: true, summary: "verified", checks: [], failedNodeIds: [], repairable: false, architecturalMismatch: false } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const config = { recursionLimit: 64, configurable: { thread_id: "budget-continue", langgraphOpenCodeRuntime: runtime } };
    const paused = await configured.graph.invoke(configured.initial({ task: "bounded", directory: "/repo", worktree: "/repo", runId: "budget-continue" }), config);
    expect(isInterrupted(paused)).toBe(true);
    const resumed = await configured.graph.invoke(new Command({ resume: "continue" }), config);
    expect(configured.progress?.(resumed)).toMatchObject({ phase: "completed" });
    expect(scoutSessions).toEqual([{ strategy: "fresh" }, { strategy: "fork", sessionId: "scout-aborted" }]);
  });

  it("does not acquire the worktree for direct answers", async () => {
    const configured = progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    let leases = 0;
    const runtime = { call: async (input: { node: string }) => input.node === "classify"
      ? { text: "", structured: { route: "answer", scope: "local", summary: "explain", planningFrame: "direct explanation", readOnly: true, risks: [] } }
      : { text: "direct answer" } };
    const result = await configured.graph.invoke(configured.initial({ task: "what?", directory: "/repo", worktree: "/repo", runId: "answer" }), { configurable: { thread_id: "answer", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { leases++; } } });
    expect(leases).toBe(0);
    expect(configured.result?.(result)).toBe("direct answer");
  });
});

function decisionValue(disposition: "ready" | "split", leaf?: { objective: string; targets: string[]; acceptanceCriteria: string[]; verification: string[] }, children: Array<{ key: string; title: string; description: string; level: string; dependencies: string[] }> = []) {
  return { disposition, summary: disposition, options: [], selectedOption: "", confidence: 1, question: "", children, ...(leaf ? { leaf } : {}) };
}

describe("worktree queue", () => {
  it("serializes leases in FIFO order", async () => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-lock-"));
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
});

describe("durable checkpoints", () => {
  it("resumes an interrupt through a separately opened durable saver", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-checkpoints-"));
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
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-cancel-"));
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      writeStoredRun({ runId: "run", rootSessionId: "root", userMessageId: "message", graph: "progressive-lod", task: "task", directory: "/repo", worktree: "/repo", status: "running" });
      const hooks = await server({ client: {}, directory: "/repo", worktree: "/repo" } as never);
      await hooks["command.execute.before"]?.({ command: "graph-cancel", sessionID: "root", arguments: "" }, { parts: [] } as never);
      expect(readStoredRun("run").status).toBe("cancelled");
      expect(readPluginEvents("root", state).at(-1)).toMatchObject({ runId: "run", node: "__end__", status: "interrupted", text: "Cancelled by user" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("runs the graph from a root chat message and records visible events", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-project-"));
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
        : [{ info: { role: "assistant", ...(titles.get(requestPath.id)?.includes("classify") ? { structured: { route: "answer", scope: "local", summary: "answer question", planningFrame: "direct answer", readOnly: true, risks: [] } } : {}) }, parts: [{ type: "text", text: "The answer is 4." }] }],
      }),
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph", "graph-cancel"]);
      expect(Object.keys(hooks.tool ?? {})).toEqual(["langgraph_run", "langgraph_resume"]);
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
      deadline = Date.now() + 2_000;
      while ((child < 4 || posted.length < 6) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child).toBe(4);
      expect(posted).toHaveLength(6);
      expect(posted.at(-1)).toMatchObject({ body: { agent: "build" } });
      const events = readPluginEvents("root");
      expect(events.map((event) => event.node)).toEqual(expect.arrayContaining(["__start__", "answer", "__end__"]));
      expect(new Set(events.map((event) => event.userMessageId))).toEqual(new Set(["message-command", "message-1"]));
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("adopts the home-screen graph selection for the first session message", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-project-"));
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
  });

  it("ships the TUI framework as runtime dependencies", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(["@opentui/core", "@opentui/solid", "solid-js"]));
    expect(manifest.exports["./tui"]).toBe("./dist/src/opencode/tui.js");
    expect(manifest.scripts.build).toContain("build-tui.mjs");
  });

  it("persists graph selection when graph mode is toggled", () => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
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
      ["t", "state"], ["return", "inspect"], ["up", "up"], ["j", "down"], ["left", "left"],
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
      { id: "p1", title: "Requested behavior", level: "observable outcome", depth: 0, status: "removed" },
      { id: "p2", parentId: "p1", title: "Session handoff", level: "state transition", depth: 1, status: "active", evidence: 2, confidence: .8 },
    ] } }]);
    expect(tree).toContain("LOD  PLANNING / SUBSYSTEM");
    expect(tree).toContain("CALLS  █░░░░░░░░░ 3/24");
    expect(tree).toContain("└─ ▶ p2  Session handoff");
    expect(tree).toContain("state transition");
    expect(tree).toContain("[LOD 1] [ACTIVE] [2 EVIDENCE] [80%]");
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
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-viewer-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
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
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-project-"));
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-other-"));
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
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-project-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-state-"));
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
