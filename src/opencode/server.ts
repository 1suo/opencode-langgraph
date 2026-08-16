import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, isInterrupted } from "@langchain/langgraph";
import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { loadConnectorDefinition } from "../core/config.js";
import { assertValidConnector, validateConnector } from "../core/validate.js";
import { OpenCodeAgentRuntime } from "./runtime.js";
import { forwardPermissionEvent } from "./permissions.js";
import { adoptHomeGraphState, appendPluginEvent, readHomeGraphState, readLatestStoredRun, readSessionGraphName, readSessionGraphState, readStoredRun, writeStoredRun, type PluginRunEvent, type StoredRun } from "./store.js";
import { acquireWorktree, type WorktreeLease } from "./worktree-lock.js";
import { CONNECTOR_PRESENTER, CONNECTOR_ROOT_SYSTEM_PROMPT, SOLUTION_ROLE_CONTRACTS } from "../core/solution-lod/roles.js";
import { prepareVerifierWorkspace, releaseVerifierWorkspace } from "./verifier-workspace.js";

const PRESENTER_AGENT = CONNECTOR_PRESENTER.name;

function executionWorktree(directory: string, worktree: string): string {
  const resolved = path.resolve(worktree);
  return resolved === path.parse(resolved).root ? path.resolve(directory) : resolved;
}

function messageModel(info: { role: string; model?: { providerID: string; modelID: string }; providerID?: string; modelID?: string }) {
  if (info.role === "user") return info.model;
  if (info.providerID && info.modelID) return { providerID: info.providerID, modelID: info.modelID };
}

const CONTEXT_TURNS = 8;
const CONTEXT_CHARS = 6_000;
const CONTEXT_TURN_CHARS = 1_200;

type ConversationMessage = {
  info: { id?: string; role: string };
  parts: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>;
};

function compactText(text: string, limit = CONTEXT_TURN_CHARS): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

export function buildConversationContext(messages: ConversationMessage[], currentMessageId: string, currentTask: string): string {
  const turns = messages.flatMap((message) => {
    if (message.info.id === currentMessageId || (message.info.role !== "user" && message.info.role !== "assistant")) return [];
    const text = compactText(message.parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n"));
    return text ? [{ role: message.info.role, text }] : [];
  });
  const last = turns.at(-1);
  if (last?.role === "user" && last.text === compactText(currentTask)) turns.pop();
  const selected: typeof turns = [];
  let used = 0;
  for (const turn of turns.slice(-CONTEXT_TURNS).reverse()) {
    const rendered = `${turn.role.toUpperCase()}: ${turn.text}`;
    if (selected.length && used + rendered.length + 1 > CONTEXT_CHARS) break;
    selected.unshift(turn);
    used += rendered.length + 1;
  }
  return selected.map((turn) => `${turn.role.toUpperCase()}: ${turn.text}`).join("\n");
}

export const server: Plugin = async (plugin) => {
  const internalMessages = new Set<string>();
  const manualMessages = new Set<string>();
  const cancelledMessages = new Set<string>();
  const activeControllers = new Map<string, Set<AbortController>>();
  const registerController = (sessionId: string, controller: AbortController) => activeControllers.set(sessionId, new Set([...(activeControllers.get(sessionId) ?? []), controller]));
  const unregisterController = (sessionId: string, controller: AbortController) => {
    const controllers = activeControllers.get(sessionId);
    controllers?.delete(controller);
    if (!controllers?.size) activeControllers.delete(sessionId);
  };
  return {
    event: ({ event }) => forwardPermissionEvent(event),
    config: async (config) => {
      config.agent ??= {};
      config.agent[PRESENTER_AGENT] = { description: "Tool-free LangGraph lifecycle presenter", mode: "primary", hidden: true, prompt: CONNECTOR_PRESENTER.systemPrompt, tools: CONNECTOR_PRESENTER.tools, maxSteps: CONNECTOR_PRESENTER.maxSteps, permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } };
      for (const [role, contract] of Object.entries(SOLUTION_ROLE_CONTRACTS)) {
        if (contract.agent === "build" || contract.agent === "plan") continue;
        config.agent[contract.agent] = { description: `LangGraph ${role} capability`, mode: "subagent", hidden: true, prompt: contract.systemPrompt, tools: contract.tools, maxSteps: contract.maxSteps, permission: { edit: "deny", bash: role === "verify" ? "allow" : "deny", webfetch: "deny", external_directory: "deny" } };
      }
      config.command ??= {};
      config.command["run-graph"] = {
        description: "Run this task through the current session's LangGraph",
        agent: PRESENTER_AGENT,
        template: "$ARGUMENTS",
      };
      config.command["graph-resume"] = { description: "Resume the current paused LangGraph", agent: PRESENTER_AGENT, template: "$ARGUMENTS" };
      config.command["graph-cancel"] = { description: "Cancel the active or queued LangGraph run", agent: PRESENTER_AGENT, template: "Cancel the active LangGraph run." };
    },
    "command.execute.before": async (input) => {
      if (input.command === "run-graph") manualMessages.add(input.sessionID);
      if (input.command === "graph-cancel") {
        cancelledMessages.add(input.sessionID);
        for (const controller of activeControllers.get(input.sessionID) ?? []) controller.abort(new Error("Cancelled by user"));
        const run = readLatestStoredRun(input.sessionID);
        if (run?.status === "running" || run?.status === "queued" || run?.status === "interrupted") {
          writeStoredRun({ ...run, status: "cancelled" });
          await releaseVerifierWorkspace(run.runId);
          appendPluginEvent({ at: new Date().toISOString(), runId: run.runId, rootSessionId: run.rootSessionId, userMessageId: run.userMessageId, graph: run.graph, node: "__end__", status: "interrupted", agent: "langgraph", model: "langgraph", text: "Cancelled by user" });
        }
      }
    },
    "chat.message": async (input, output) => {
      if (input.messageID && internalMessages.delete(input.messageID)) return;
      if (cancelledMessages.delete(input.sessionID)) return;
      const manual = manualMessages.delete(input.sessionID);
      const session = await plugin.client.session.get({ path: { id: input.sessionID }, query: { directory: plugin.directory }, throwOnError: true });
      if (session.data.parentID) return;
      const graphState = readSessionGraphState(input.sessionID) ?? adoptHomeGraphState(input.sessionID, plugin.worktree);
      const task = output.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!task) return;
      const rootMessageID = input.messageID ?? output.message.id;
      const parentModel = input.model ?? output.message.model;
      const interrupted = readLatestStoredRun(input.sessionID);
      if (!manual && interrupted?.status === "interrupted") {
        output.message.agent = PRESENTER_AGENT;
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, messageID: rootMessageID, sessionID: input.sessionID, type: "text", synthetic: true, text: "The LangGraph connector is resuming the paused graph with this answer. Reply briefly that it is resuming; do not perform the task yourself." });
        const controller = new AbortController();
        registerController(input.sessionID, controller);
        void executeResume(plugin, interrupted, task, parentModel, controller.signal)
          .then((result) => postGraphResult(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, result))
          .catch((error) => postGraphFailure(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, error))
          .finally(() => unregisterController(input.sessionID, controller));
        return;
      }
      if (!manual && graphState?.enabled !== true) return;
      const history = await plugin.client.session.messages({ path: { id: input.sessionID }, query: { directory: plugin.directory }, throwOnError: true });
      const conversationContext = buildConversationContext(history.data as ConversationMessage[], rootMessageID, task);
      output.message.agent = PRESENTER_AGENT;
      output.parts.push({
        id: `prt_${randomUUID().replaceAll("-", "")}`,
        messageID: rootMessageID,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "The LangGraph connector started this message's graph in the background. Reply briefly that the graph is running and that /graph shows live state. Do not perform the task yourself.",
      });
      const controller = new AbortController();
      registerController(input.sessionID, controller);
      void executeGraph(plugin, {
        task, conversationContext, rootSessionId: input.sessionID, userMessageId: rootMessageID,
        directory: plugin.directory, worktree: executionWorktree(plugin.directory, plugin.worktree), parentModel,
        graph: graphState?.graph, signal: controller.signal,
      })
        .then((result) => postGraphResult(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, result))
        .catch((error) => postGraphFailure(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, error))
        .finally(() => unregisterController(input.sessionID, controller));
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const graphState = readSessionGraphState(input.sessionID) ?? readHomeGraphState(plugin.worktree);
      if (graphState?.enabled !== true) return;
      const session = await plugin.client.session.get({ path: { id: input.sessionID }, query: { directory: plugin.directory }, throwOnError: true });
      if (session.data.parentID) return;
      output.system.push(CONNECTOR_ROOT_SYSTEM_PROMPT);
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
      body: { messageID, model, agent: PRESENTER_AGENT, system: CONNECTOR_PRESENTER.systemPrompt, tools: CONNECTOR_PRESENTER.tools, parts: [{ type: "text", text }] },
    });
  } catch (error) {
    internalMessages.delete(messageID);
    throw error;
  }
}

async function postGraphResult(plugin: PluginInput, internalMessages: Set<string>, sessionID: string, parentMessageID: string, model: { providerID: string; modelID: string } | undefined, result: GraphExecution): Promise<void> {
  const text = result.interrupted
    ? `LangGraph ${result.graph} paused for human input. Ask the user this question and nothing else:\n${result.output}`
    : result.failed
      ? `LangGraph ${result.graph} ended without verified success. Report this result directly; do not claim completion or rerun it:\n${result.output}`
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
  failed: boolean;
  runId: string;
  graph: string;
}

interface ExecuteGraphInput {
  task: string;
  conversationContext?: string;
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

function watchCancellation(runId: string, upstream?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(upstream?.reason ?? new Error("Graph run cancelled"));
  if (upstream?.aborted) abort(); else upstream?.addEventListener("abort", abort, { once: true });
  const timer = setInterval(() => {
    try { if (readStoredRun(runId).status === "cancelled") controller.abort(new Error("Cancelled by user")); } catch { /* run is not persisted yet */ }
  }, 250);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => { clearInterval(timer); upstream?.removeEventListener("abort", abort); },
  };
}

async function executeGraph(plugin: PluginInput, input: ExecuteGraphInput): Promise<GraphExecution> {
  const definition = await loadConnectorDefinition(input.worktree);
  assertValidConnector(await validateConnector(definition));
  const graphName = input.graph ?? definition.defaultGraph;
  const configured = definition.graphs[graphName];
  if (!configured) throw new Error(`Unknown LangGraph: ${graphName}`);
  const runId = randomUUID();
  const cancellation = watchCancellation(runId, input.signal);
  const signal = cancellation.signal;
  const emit = (event: PluginRunEvent) => {
    const linked = { ...event, userMessageId: input.userMessageId };
    appendPluginEvent(linked);
  };
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: input.rootSessionId, parentModel: input.parentModel,
    directory: input.directory, worktree: input.worktree, signal, ask: input.ask,
    onEvent: (event) => {
      emit({ ...event, at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, progress: event.state ? configured.progress?.(event.state) : undefined });
      input.metadata?.({ title: `LangGraph · ${event.node}`, metadata: { runId, graph: graphName, ...event } });
    },
  });
  const saved: StoredRun = { checkpointVersion: graphName === "solution-lod" ? 3 : undefined, runId, rootSessionId: input.rootSessionId, userMessageId: input.userMessageId, graph: graphName, task: input.task, directory: input.directory, worktree: input.worktree, status: "running" };
  writeStoredRun(saved);
  let lease: WorktreeLease | undefined;
  const acquire = async () => {
    if (lease) return;
    writeStoredRun({ ...saved, status: "queued" });
    lease = await acquireWorktree(input.worktree, signal, (position) => emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__queue__", status: "queued", agent: "connector", model: "fifo", text: `Waiting for worktree · position ${position}` }));
    writeStoredRun(saved);
  };
  const drawable = await configured.graph.getGraphAsync({ xray: true });
  const serialized = drawable.toJSON() as { nodes: Array<{ id: string }> | Record<string, unknown>; edges: Array<{ source: string; target: string }> };
  const topology = { nodes: Array.isArray(serialized.nodes) ? serialized.nodes.map((node) => node.id) : Object.keys(serialized.nodes), edges: serialized.edges.map(({ source, target }) => ({ source, target })) };
  const mermaid = drawable.drawMermaid({ withStyles: false });
  const initialState = configured.initial({ task: input.task, conversationContext: input.conversationContext, directory: input.directory, worktree: input.worktree, runId });
  emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__start__", status: "active", agent: "langgraph", model: "langgraph", state: initialState, mermaid, topology, progress: configured.progress?.(initialState) });
  try {
    const result = await configured.graph.invoke(initialState, { recursionLimit: 512, configurable: { thread_id: runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: acquire, langgraphPrepareVerifierWorkspace: prepareVerifierWorkspace, langgraphReleaseVerifierWorkspace: releaseVerifierWorkspace }, signal });
    if (isInterrupted(result)) {
      writeStoredRun({ ...saved, status: "interrupted" });
      const requests = result.__interrupt__.map((item) => item.value);
      const output = JSON.stringify(requests, null, 2);
      emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__interrupt__", status: "interrupted", agent: "human", model: "input", text: output, state: result, progress: configured.progress?.(result) });
      return { runId, graph: graphName, output, interrupted: true, failed: false };
    }
    const output = configured.result ? configured.result(result) : typeof result.report === "string" ? result.report : JSON.stringify(result, null, 2);
    const finalProgress = configured.progress?.(result);
    const failed = finalProgress?.phase === "failed" || finalProgress?.phase === "blocked";
    emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__end__", status: failed ? "failed" : "completed", agent: "langgraph", model: "langgraph", text: output, state: result, progress: finalProgress });
    writeStoredRun({ ...saved, status: failed ? "failed" : "completed" });
    return { runId, graph: graphName, output, interrupted: false, failed };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__end__", status: signal.aborted ? "interrupted" : "failed", agent: "langgraph", model: "langgraph", text });
    writeStoredRun({ ...saved, status: signal.aborted ? "cancelled" : "failed" });
    throw error;
  } finally {
    cancellation.dispose();
    lease?.release();
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
  if (saved.graph === "solution-lod" && saved.checkpointVersion !== 3) throw new Error("This interrupted solution-lod run uses an incompatible checkpoint schema. Start a new message to create a clean state-v3 run.");
  const definition = await loadConnectorDefinition(saved.worktree);
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[saved.graph];
  if (!configured) throw new Error(`Configured graph no longer exists: ${saved.graph}`);
  const cancellation = watchCancellation(saved.runId, signal);
  signal = cancellation.signal;
  const emit = (event: PluginRunEvent) => {
    const linked = { ...event, userMessageId: saved.userMessageId };
    appendPluginEvent(linked);
  };
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: saved.rootSessionId, parentModel,
    directory: saved.directory, worktree: saved.worktree, signal, ask,
    onEvent: (event) => emit({ ...event, at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, progress: event.state ? configured.progress?.(event.state) : undefined }),
  });
  let lease: WorktreeLease | undefined;
  const acquire = async () => { if (!lease) lease = await acquireWorktree(saved.worktree, signal); };
  writeStoredRun({ ...saved, status: "running" });
  try {
    const result = await configured.graph.invoke(new Command({ resume: answer }), { recursionLimit: 512, configurable: { thread_id: saved.runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: acquire, langgraphPrepareVerifierWorkspace: prepareVerifierWorkspace, langgraphReleaseVerifierWorkspace: releaseVerifierWorkspace }, signal });
    if (isInterrupted(result)) {
      writeStoredRun({ ...saved, status: "interrupted" });
      const output = JSON.stringify(result.__interrupt__.map((item) => item.value), null, 2);
      emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__interrupt__", status: "interrupted", agent: "human", model: "input", text: output, state: result, progress: configured.progress?.(result) });
      return { runId: saved.runId, graph: saved.graph, output, interrupted: true, failed: false };
    }
    const output = configured.result ? configured.result(result) : typeof result.report === "string" ? result.report : JSON.stringify(result, null, 2);
    const finalProgress = configured.progress?.(result);
    const failed = finalProgress?.phase === "failed" || finalProgress?.phase === "blocked";
    writeStoredRun({ ...saved, status: failed ? "failed" : "completed" });
    emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: failed ? "failed" : "completed", agent: "langgraph", model: "langgraph", text: output, state: result, progress: finalProgress });
    return { runId: saved.runId, graph: saved.graph, output, interrupted: false, failed };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    writeStoredRun({ ...saved, status: signal.aborted ? "cancelled" : "failed" });
    emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: signal.aborted ? "interrupted" : "failed", agent: "langgraph", model: "langgraph", text });
    throw error;
  } finally {
    cancellation.dispose();
    lease?.release();
  }
}

const plugin: PluginModule = { id: "opencode-langgraph", server };
export default plugin;
