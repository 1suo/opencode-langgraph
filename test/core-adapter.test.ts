import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { server } from "../src/opencode/server.js";
import { graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, tui, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { ConnectorDefinition } from "../src/core/types.js";
import { mergeAnalysis } from "../src/core/progressive-lod/plan.js";
import { AnalysisSchema, ClassificationSchema, SCOPE_BUDGETS, type ProgressiveLodState } from "../src/core/progressive-lod/types.js";
import { progressiveLodGraph } from "../src/core/progressive-lod/graph.js";
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
    expect((await loadConnectorDefinition(project)).defaultGraph).toBe("progressive-lod");
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "progressive-lod"');
    expect((await loadConnectorDefinition(project)).graphs["progressive-lod"]).toBeDefined();
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
});

describe("progressive planning reducer", () => {
  const state = (): ProgressiveLodState => ({
    runId: "run", originalTask: "change", directory: "/repo", worktree: "/repo", phase: "planning",
    profile: { route: "change", scope: "subsystem", summary: "change", planningFrame: "behavioral outcome", readOnly: false, risks: [] },
    budget: SCOPE_BUDGETS.subsystem, plan: [{ id: "p1", title: "root", description: "root", level: "behavioral outcome", depth: 0, status: "active", dependencies: [], files: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0 }],
    activeNodeId: "p1", evidence: [], constraints: [], discoveries: [], callsUsed: 1, nextId: 2, startedAt: Date.now(), repairAttempts: 0, humanQuestion: "", humanAnswer: "", implementation: "", result: "",
  });

  it("does not reject task-derived planning level names by arbitrary length", () => {
    const level = "repository-specific planning boundary ".repeat(12);
    expect(ClassificationSchema.parse({ route: "change", scope: "architectural", summary: "change", planningFrame: level, readOnly: false, risks: [] }).planningFrame).toBe(level);
    expect(AnalysisSchema.parse({ summary: "grounded", evidence: [], constraints: [], candidates: [{ name: "one", rationale: "", refinements: [{ action: "refine", title: "next", description: "next", level, implementable: false, dependencies: [], files: [] }] }], evaluation: { selected: 0, confidence: 1, needsMoreContext: false, needsHuman: false, question: "" } }).candidates[0].refinements[0].level).toBe(level);
  });

  it("accepts candidate-common refinements and assigns stable IDs", () => {
    const output = { summary: "grounded", evidence: [{ claim: "entry exists", source: "src/a.ts:1", kind: "repository" as const, confidence: 1 }], constraints: [], candidates: [
      { name: "a", rationale: "", refinements: [{ action: "split" as const, title: "Shared contract", description: "update contract", level: "protocol boundary", implementable: false, dependencies: [], files: ["src/a.ts"] }, { action: "split" as const, title: "Only A", description: "a", level: "patch", implementable: true, dependencies: [], files: [] }] },
      { name: "b", rationale: "", refinements: [{ action: "split" as const, title: "Shared contract", description: "update contract differently", level: "protocol boundary", implementable: false, dependencies: [], files: ["src/a.ts"] }, { action: "split" as const, title: "Only B", description: "b", level: "patch", implementable: true, dependencies: [], files: [] }] },
    ], evaluation: { selected: 0, confidence: .8, needsMoreContext: false, needsHuman: false, question: "" } };
    const merged = mergeAnalysis(state(), output);
    expect(merged.plan.map((node) => node.id)).toEqual(["p1", "p2"]);
    expect(merged.plan.at(-1)).toMatchObject({ title: "Shared contract", level: "protocol boundary", depth: 1, evidenceIds: ["e1"] });
    expect(merged.nextId).toBe(3);
  });

  it("holds the active branch for bounded context collection", () => {
    const output = { summary: "need source", evidence: [], constraints: [], candidates: [{ name: "one", rationale: "", refinements: [{ action: "refine" as const, title: "next", description: "next", level: "repository ownership", implementable: false, dependencies: [], files: [] }] }], evaluation: { selected: 0, confidence: .4, needsMoreContext: true, needsHuman: false, question: "" } };
    const merged = mergeAnalysis(state(), output);
    expect(merged.activeNodeId).toBe("p1");
    expect(merged.plan[0]).toMatchObject({ status: "active", contextCycles: 1 });
  });
});

describe("progressive planning graph", () => {
  it("derives a task-specific hierarchy deeper than the documentation example", async () => {
    const configured = progressiveLodGraph({ analystAgent: "analyst", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    let leases = 0;
    const runtime = { call: async (input: { node: string; state: ProgressiveLodState }) => {
      if (input.node === "classify") return { text: "", structured: { route: "change", scope: "local", summary: "change feature", planningFrame: "observable behavior", readOnly: false, risks: [] } };
      if (input.node === "analyze") {
        const active = input.state.plan.find((node) => node.id === input.state.activeNodeId)!;
        const levels = ["integration seam", "state transition", "failure semantics", "runtime observation", "concrete patch"];
        return { text: "", structured: { summary: `refined ${active.level}`, evidence: [{ claim: "grounded", source: "src/a.ts:1", kind: "repository", confidence: 1 }], constraints: [], candidates: [{ name: "direct", rationale: "grounded", refinements: [{ action: "refine", title: `Branch ${active.depth + 1}`, description: "bounded work", level: levels[active.depth], implementable: active.depth >= 4, dependencies: [], files: ["src/a.ts"] }] }], evaluation: { selected: 0, confidence: .9, needsMoreContext: false, needsHuman: false, question: "" } } };
      }
      if (input.node === "implement") return { text: "implemented and checked" };
      if (input.node === "verify") return { text: "", structured: { passed: true, summary: "all checks pass", checks: [{ name: "test", passed: true, evidence: "ok" }], failedNodeIds: [], repairable: false, architecturalMismatch: false } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const initial = configured.initial({ task: "change it", directory: "/repo", worktree: "/repo", runId: "run" });
    const result = await configured.graph.invoke(initial, { configurable: { thread_id: "run", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { leases++; } } });
    expect(leases).toBe(1);
    expect(configured.result?.(result)).toContain("all checks pass");
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 8 });
    expect(configured.progress?.(result)?.nodes).toHaveLength(6);
    expect(configured.progress?.(result)?.nodes.at(-1)).toMatchObject({ level: "concrete patch", depth: 5, status: "verified" });
  });

  it("allows a grounded local task to become implementable immediately", async () => {
    const configured = progressiveLodGraph({ analystAgent: "analyst", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    const runtime = { call: async (input: { node: string }) => {
      if (input.node === "classify") return { text: "", structured: { route: "change", scope: "local", summary: "fix typo", planningFrame: "single-file correction", readOnly: false, risks: [] } };
      if (input.node === "analyze") return { text: "", structured: { summary: "located typo", evidence: [], constraints: [], candidates: [{ name: "direct", rationale: "mechanical", refinements: [{ action: "refine", title: "Correct label", description: "Edit src/a.ts and assert the rendered label", level: "verified text edit", implementable: true, dependencies: [], files: ["src/a.ts"] }] }], evaluation: { selected: 0, confidence: 1, needsMoreContext: false, needsHuman: false, question: "" } } };
      if (input.node === "implement") return { text: "implemented" };
      if (input.node === "verify") return { text: "", structured: { passed: true, summary: "verified", checks: [], failedNodeIds: [], repairable: false, architecturalMismatch: false } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "fix typo", directory: "/repo", worktree: "/repo", runId: "short" }), { configurable: { thread_id: "short", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", callsUsed: 4 });
    expect(configured.progress?.(result)?.nodes.at(-1)).toMatchObject({ level: "verified text edit", depth: 1, status: "verified" });
  });

  it("does not acquire the worktree for direct answers", async () => {
    const configured = progressiveLodGraph({ analystAgent: "analyst", implementerAgent: "implementer", checkpointer: new MemorySaver() });
    let leases = 0;
    const runtime = { call: async (input: { node: string }) => input.node === "classify"
      ? { text: "", structured: { route: "answer", scope: "local", summary: "explain", planningFrame: "direct explanation", readOnly: true, risks: [] } }
      : { text: "direct answer" } };
    const result = await configured.graph.invoke(configured.initial({ task: "what?", directory: "/repo", worktree: "/repo", runId: "answer" }), { configurable: { thread_id: "answer", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { leases++; } } });
    expect(leases).toBe(0);
    expect(configured.result?.(result)).toBe("direct answer");
  });
});

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
    expect(graphHelpText()).toContain("G topology");
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

  it("renders cyclic topology without parsing canonical Mermaid", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "default", status: "pending", agent: "—", model: "—" };
    const topology = { nodes: ["start", "work", "retry", "end"], edges: [
      { source: "start", target: "work" }, { source: "work", target: "retry" },
      { source: "retry", target: "work" }, { source: "work", target: "end" },
    ] };
    const mermaid = "graph TD;\n\tcanonical_only --> ignored;";
    const layout = renderEventGraph([{ ...base, node: "start", topology, mermaid }]);
    expect(layout.canvas).toContain("start");
    expect(layout.canvas).toContain("work");
    expect(layout.canvas).toContain("retry");
    expect(layout.canvas).not.toContain("canonical only");
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("renders semantic progress as a hierarchy with budget state", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "progressive-lod", node: "analyze", status: "active", agent: "analyst", model: "inherit" };
    const tree = renderPlanTree([{ ...base, progress: { phase: "planning", scope: "subsystem", callsUsed: 3, callBudget: 24, activeNodeId: "p2", nodes: [
      { id: "p1", title: "Requested behavior", level: "observable outcome", depth: 0, status: "removed" },
      { id: "p2", parentId: "p1", title: "Session handoff", level: "state transition", depth: 1, status: "active", evidence: 2, confidence: .8 },
    ] } }]);
    expect(tree).toContain("planning · subsystem · calls 3/24");
    expect(tree).toContain("└─ ▶ Session handoff");
    expect(tree).toContain("state transition · depth 1");
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
