import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { server } from "../src/opencode/server.js";
import { graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, tui, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { ConnectorDefinition } from "../src/core/types.js";

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

  it("uses the Neolit workflow only as an explicit built-in preset", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-langgraph-config-"));
    expect((await loadConnectorDefinition(project)).defaultGraph).toBe("default");
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "neolit"');
    expect((await loadConnectorDefinition(project)).graphs.default).toBeDefined();
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
    const client = { session: {
      get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
      create: async ({ body }: { body: { parentID: string } }) => {
        const id = `child-${++child}`;
        parents.set(id, body.parentID);
        return { data: { id } };
      },
      promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: ["message-1", "message-command"].map((parentID) => ({ info: { role: "assistant", parentID }, parts: [{ type: "text", text: "The answer is 4." }] })) }),
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph"]);
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
      while ((child < 2 || posted.length < 4) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child).toBe(2);
      expect(posted).toHaveLength(4);
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
    expect(graphHelpText()).toContain("defineGraph({ graph, initial, result })");
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
      expect(calls.pop()).toBe(expected);
    }
  });

  it("renders cyclic graphs with beautiful-mermaid", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "default", status: "pending", agent: "—", model: "—" };
    const topology = { nodes: ["start", "work", "retry", "end"], edges: [
      { source: "start", target: "work" }, { source: "work", target: "retry" },
      { source: "retry", target: "work" }, { source: "work", target: "end" },
    ] };
    const mermaid = "graph TD;\n\tstart --> work;\n\twork -. &nbsp;retry&nbsp; .-> retry;\n\tretry --> work;\n\twork --> end;";
    const layout = renderEventGraph([{ ...base, node: "start", topology, mermaid }]);
    expect(layout.canvas).toContain("start");
    expect(layout.canvas).toContain("work");
    expect(layout.canvas).toContain("retry");
    expect(layout.canvas).toContain("┆");
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
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
