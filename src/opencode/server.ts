import { randomUUID } from "node:crypto";
import { Command, isInterrupted } from "@langchain/langgraph";
import { tool, type Plugin, type PluginInput, type PluginModule } from "@opencode-ai/plugin";
import { loadConnectorDefinition } from "../core/config.js";
import { assertValidConnector, validateConnector } from "../core/validate.js";
import { OpenCodeAgentRuntime } from "./runtime.js";
import { forwardPermissionEvent } from "./permissions.js";
import { appendPluginEvent, readSessionGraphEnabled, readStoredRun, writeStoredRun, type PluginRunEvent, type StoredRun } from "./store.js";

function messageModel(info: { role: string; model?: { providerID: string; modelID: string }; providerID?: string; modelID?: string }) {
  if (info.role === "user") return info.model;
  if (info.providerID && info.modelID) return { providerID: info.providerID, modelID: info.modelID };
}

export const server: Plugin = async (plugin) => {
  const internalMessages = new Set<string>();
  const manualMessages = new Set<string>();
  return {
    event: ({ event }) => forwardPermissionEvent(event),
    config: async (config) => {
      config.command ??= {};
      config.command["run-graph"] = {
        description: "Run this task through the current session's LangGraph",
        agent: "build",
        template: "$ARGUMENTS",
      };
    },
    "command.execute.before": async (input) => {
      if (input.command === "run-graph") manualMessages.add(input.sessionID);
    },
    "chat.message": async (input, output) => {
      if (input.messageID && internalMessages.delete(input.messageID)) return;
      const manual = manualMessages.delete(input.sessionID);
      if (!manual && !readSessionGraphEnabled(input.sessionID)) return;
      const session = await plugin.client.session.get({ path: { id: input.sessionID }, query: { directory: plugin.directory }, throwOnError: true });
      if (session.data.parentID) return;
      const task = output.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!task) return;
      const rootMessageID = input.messageID ?? output.message.id;
      const parentModel = input.model ?? output.message.model;
      output.parts.push({
        id: `prt_${randomUUID().replaceAll("-", "")}`,
        messageID: rootMessageID,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "The LangGraph connector started this message's graph in the background. Reply briefly that the graph is running and that /graph shows live state. Do not perform the task yourself.",
      });
      void executeGraph(plugin, {
        task, rootSessionId: input.sessionID, userMessageId: rootMessageID,
        directory: plugin.directory, worktree: plugin.worktree, parentModel,
      })
        .then((result) => postGraphResult(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, result))
        .catch((error) => postGraphFailure(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, error));
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || !readSessionGraphEnabled(input.sessionID)) return;
      const session = await plugin.client.session.get({ path: { id: input.sessionID }, query: { directory: plugin.directory }, throwOnError: true });
      if (session.data.parentID) return;
      output.system.push(`The OpenCode LangGraph connector runs a new graph for each user message while graph:on. A synthetic message contains its result or human-input request. Present that result directly and do not redo graph work. langgraph_run and langgraph_resume remain available for explicit manual control.`);
    },
    tool: {
      langgraph_run: graphTool(plugin),
      langgraph_resume: resumeTool(plugin),
    },
  };
};

async function postRootMessage(
  plugin: PluginInput,
  internalMessages: Set<string>,
  sessionID: string,
  parentMessageID: string,
  model: { providerID: string; modelID: string } | undefined,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const messages = await plugin.client.session.messages({ path: { id: sessionID }, query: { directory: plugin.directory }, throwOnError: true });
    if (messages.data.some((message) => message.info.role === "assistant" && message.info.parentID === parentMessageID)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
  internalMessages.add(messageID);
  try {
    await plugin.client.session.promptAsync({
      path: { id: sessionID }, query: { directory: plugin.directory }, throwOnError: true,
      body: { messageID, model, agent: "build", parts: [{ type: "text", text }] },
    });
  } catch (error) {
    internalMessages.delete(messageID);
    throw error;
  }
}

async function postGraphResult(plugin: PluginInput, internalMessages: Set<string>, sessionID: string, parentMessageID: string, model: { providerID: string; modelID: string } | undefined, result: GraphExecution): Promise<void> {
  const text = result.interrupted
    ? `LangGraph ${result.graph} paused for human input. Ask the user this question and nothing else:\n${result.output}`
    : `LangGraph ${result.graph} completed. Present this result directly; do not repeat its edits or rerun it:\n${result.output}`;
  await postRootMessage(plugin, internalMessages, sessionID, parentMessageID, model, text);
}

async function postGraphFailure(plugin: PluginInput, internalMessages: Set<string>, sessionID: string, parentMessageID: string, model: { providerID: string; modelID: string } | undefined, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await postRootMessage(plugin, internalMessages, sessionID, parentMessageID, model, `LangGraph failed: ${message}. Report this failure clearly and suggest /graph for node details. Do not claim the task completed.`);
}

interface GraphExecution {
  output: string;
  interrupted: boolean;
  runId: string;
  graph: string;
}

interface ExecuteGraphInput {
  task: string;
  rootSessionId: string;
  userMessageId: string;
  directory: string;
  worktree: string;
  parentModel?: { providerID: string; modelID: string };
  graph?: string;
  signal?: AbortSignal;
  ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
}

async function executeGraph(plugin: PluginInput, input: ExecuteGraphInput): Promise<GraphExecution> {
  const definition = await loadConnectorDefinition(input.worktree);
  assertValidConnector(await validateConnector(definition));
  const graphName = input.graph ?? definition.defaultGraph;
  const configured = definition.graphs[graphName];
  if (!configured) throw new Error(`Unknown LangGraph: ${graphName}`);
  const runId = randomUUID();
  const signal = input.signal ?? new AbortController().signal;
  const emit = (event: PluginRunEvent) => {
    const linked = { ...event, userMessageId: input.userMessageId };
    appendPluginEvent(linked);
  };
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: input.rootSessionId, parentModel: input.parentModel,
    directory: input.directory, worktree: input.worktree, signal, ask: input.ask,
    onEvent: (event) => {
      emit({ ...event, at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName });
      input.metadata?.({ title: `LangGraph · ${event.node}`, metadata: { runId, graph: graphName, ...event } });
    },
  });
  const saved: StoredRun = { runId, rootSessionId: input.rootSessionId, userMessageId: input.userMessageId, graph: graphName, task: input.task, directory: input.directory, worktree: input.worktree, status: "running" };
  writeStoredRun(saved);
  const drawable = await configured.graph.getGraphAsync({ xray: true });
  const serialized = drawable.toJSON() as { nodes: Array<{ id: string }> | Record<string, unknown>; edges: Array<{ source: string; target: string }> };
  const topology = { nodes: Array.isArray(serialized.nodes) ? serialized.nodes.map((node) => node.id) : Object.keys(serialized.nodes), edges: serialized.edges.map(({ source, target }) => ({ source, target })) };
  const mermaid = drawable.drawMermaid({ withStyles: false });
  const initialState = configured.initial({ task: input.task, directory: input.directory, worktree: input.worktree, runId });
  emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__start__", status: "active", agent: "langgraph", model: "langgraph", state: initialState, mermaid, topology });
  try {
    const result = await configured.graph.invoke(initialState, { configurable: { thread_id: runId, langgraphOpenCodeRuntime: runtime }, signal });
    if (isInterrupted(result)) {
      writeStoredRun({ ...saved, status: "interrupted" });
      const requests = result.__interrupt__.map((item) => item.value);
      const output = JSON.stringify(requests, null, 2);
      emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__interrupt__", status: "interrupted", agent: "human", model: "input", text: output, state: result });
      return { runId, graph: graphName, output, interrupted: true };
    }
    const output = configured.result ? configured.result(result) : typeof result.report === "string" ? result.report : JSON.stringify(result, null, 2);
    emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__end__", status: "completed", agent: "langgraph", model: "langgraph", text: output, state: result });
    writeStoredRun({ ...saved, status: "completed" });
    return { runId, graph: graphName, output, interrupted: false };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__end__", status: "failed", agent: "langgraph", model: "langgraph", text });
    writeStoredRun({ ...saved, status: "failed" });
    throw error;
  }
}

async function executeResume(
  plugin: PluginInput,
  saved: StoredRun,
  answer: unknown,
  parentModel?: { providerID: string; modelID: string },
  signal = new AbortController().signal,
  ask?: ExecuteGraphInput["ask"],
): Promise<GraphExecution> {
  const definition = await loadConnectorDefinition(saved.worktree);
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[saved.graph];
  if (!configured) throw new Error(`Configured graph no longer exists: ${saved.graph}`);
  const emit = (event: PluginRunEvent) => {
    const linked = { ...event, userMessageId: saved.userMessageId };
    appendPluginEvent(linked);
  };
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: saved.rootSessionId, parentModel,
    directory: saved.directory, worktree: saved.worktree, signal, ask,
    onEvent: (event) => emit({ ...event, at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph }),
  });
  writeStoredRun({ ...saved, status: "running" });
  try {
    const result = await configured.graph.invoke(new Command({ resume: answer }), { configurable: { thread_id: saved.runId, langgraphOpenCodeRuntime: runtime }, signal });
    if (isInterrupted(result)) {
      writeStoredRun({ ...saved, status: "interrupted" });
      const output = JSON.stringify(result.__interrupt__.map((item) => item.value), null, 2);
      emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__interrupt__", status: "interrupted", agent: "human", model: "input", text: output, state: result });
      return { runId: saved.runId, graph: saved.graph, output, interrupted: true };
    }
    const output = configured.result ? configured.result(result) : typeof result.report === "string" ? result.report : JSON.stringify(result, null, 2);
    writeStoredRun({ ...saved, status: "completed" });
    emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: "completed", agent: "langgraph", model: "langgraph", text: output, state: result });
    return { runId: saved.runId, graph: saved.graph, output, interrupted: false };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    writeStoredRun({ ...saved, status: "failed" });
    emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: "failed", agent: "langgraph", model: "langgraph", text });
    throw error;
  }
}

function graphTool(plugin: PluginInput) {
  return tool({
    description: "Run a configured LangGraph workflow through OpenCode agents.",
    args: {
      task: tool.schema.string().min(1).describe("Complete task for the graph"),
      graph: tool.schema.string().optional().describe("Configured graph name; defaults to the repository default"),
    },
    async execute(args, context) {
      const parent = await plugin.client.session.message({
        path: { id: context.sessionID, messageID: context.messageID },
        query: { directory: context.directory },
        throwOnError: true,
      });
      const parentModel = messageModel(parent.data.info);
      const result = await executeGraph(plugin, {
        task: args.task, graph: args.graph, rootSessionId: context.sessionID, userMessageId: context.messageID,
        directory: context.directory, worktree: context.worktree, parentModel,
        signal: context.abort, ask: context.ask, metadata: context.metadata,
      });
      return { title: result.interrupted ? "LangGraph · input required" : `LangGraph · ${result.graph}`, output: result.interrupted ? `The graph is paused. Ask the user for this input, then call langgraph_resume with runId ${result.runId}:\n${result.output}` : result.output, metadata: { runId: result.runId, graph: result.graph, interrupted: result.interrupted } };
    },
  });
}

function resumeTool(plugin: PluginInput) {
  return tool({
    description: "Resume a paused LangGraph after the user has answered its human-in-the-loop request.",
    args: {
      runId: tool.schema.string().min(1),
      answer: tool.schema.unknown().describe("User answer passed to LangGraph Command.resume"),
    },
    async execute(args, context) {
      const saved = readStoredRun(args.runId);
      if (saved.rootSessionId !== context.sessionID) throw new Error("LangGraph run belongs to a different OpenCode session");
      if (saved.status !== "interrupted") throw new Error(`LangGraph run is ${saved.status}, not interrupted`);
      const parent = await plugin.client.session.message({ path: { id: context.sessionID, messageID: context.messageID }, query: { directory: context.directory }, throwOnError: true });
      const result = await executeResume(plugin, saved, args.answer, messageModel(parent.data.info), context.abort, context.ask);
      return { title: result.interrupted ? "LangGraph · more input required" : `LangGraph · ${saved.graph}`, output: result.interrupted ? `Ask the user, then call langgraph_resume again with runId ${saved.runId}:\n${result.output}` : result.output, metadata: { runId: saved.runId, interrupted: result.interrupted } };
    },
  });
}

const plugin: PluginModule = { id: "opencode-langgraph", server };
export default plugin;
