import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, isInterrupted } from "@langchain/langgraph";
import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConnectorDefinition, withSolutionRoleModelAssignments } from "../core/config.js";
import { assertValidConnector, validateConnector } from "../core/validate.js";
import { OpenCodeAgentRuntime } from "./runtime.js";
import { forwardPermissionEvent } from "./permissions.js";
import { adoptHomeGraphState, appendPluginEvent, readHomeGraphState, readLatestProjectRun, readLatestStoredRun, readSessionGraphName, readSessionGraphState, readStoredRun, writeStoredRun, type PluginRunEvent, type StoredRun } from "./store.js";
import { acquireWorktree, type WorktreeLease } from "./worktree-lock.js";
import { CONNECTOR_PRESENTER, CONNECTOR_ROOT_SYSTEM_PROMPT, SOLUTION_ROLE_CONTRACTS } from "../core/solution-lod/roles.js";
import { reopenRegion } from "../core/solution-lod/reducer.js";
import type { GraphProgressSnapshot } from "../core/types.js";
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
    tool: {
      langgraph_start: tool({
        description: "Start a LangGraph run in the current project and return its runId as soon as it is saved. The run continues in the background. Use this instead of invoking the OpenCode CLI or /run-graph. Keep the runId and call langgraph_inspect to monitor it. Start the next run only after the current one completes, fails, or is cancelled.",
        args: { task: tool.schema.string(), graph: tool.schema.string().optional() },
        execute: async (args: { task: string; graph?: string }, context) => startRun(plugin, context.sessionID, args.task, args.graph, {
          directory: context.directory, worktree: context.worktree, ask: context.ask, metadata: context.metadata,
        }),
      }),
      langgraph_inspect: tool({
        description: "Read a run's saved status, current work, solution regions, agent activations, usage, and result. This changes nothing. Pass the runId returned by langgraph_start. With no ID it reads this session's latest run; rootSessionId selects another session and projectScope selects this project's latest run.",
        args: { runId: tool.schema.string().optional(), rootSessionId: tool.schema.string().optional(), projectScope: tool.schema.boolean().optional() },
        execute: async (args: { runId?: string; rootSessionId?: string; projectScope?: boolean }, context) => inspectRun(context.sessionID, args.runId, { rootSessionId: args.rootSessionId, worktree: args.projectScope ? context.worktree : undefined }),
      }),
      langgraph_prune: tool({
        description: "Remove one wrong part of a saved solution and everything derived from it. Use the part's regionId from langgraph_inspect. You may replace its goal, allowed choices, or success criteria. This saves the repair so langgraph_resume can continue from it.",
        args: { runId: tool.schema.string().optional(), regionId: tool.schema.string(), reason: tool.schema.string().optional(), objective: tool.schema.string().optional(), allowedVariables: tool.schema.array(tool.schema.string()).optional(), acceptanceCriteria: tool.schema.array(tool.schema.string()).optional() },
        execute: async (args: { runId?: string; regionId: string; reason?: string; objective?: string; allowedVariables?: string[]; acceptanceCriteria?: string[] }, context) => pruneRun(context.sessionID, args.runId, args.regionId, args.reason, { objective: args.objective, allowedVariables: args.allowedVariables, acceptanceCriteria: args.acceptanceCriteria }),
      }),
      langgraph_resume: tool({
        description: "Continue a run from its saved state. Pass answer only when the run stopped to ask the user a question. After langgraph_prune, call this to continue from the repaired solution.",
        args: { runId: tool.schema.string().optional(), answer: tool.schema.string().optional() },
        execute: async (args: { runId?: string; answer?: string }, context) => resumeRun(plugin, context.sessionID, args.runId, args.answer),
      }),
      langgraph_cancel: tool({
        description: "Cancel a running, queued, or interrupted LangGraph run. Pass the runId returned by langgraph_start. The run remains inspectable but cannot be resumed unless a region is pruned first.",
        args: { runId: tool.schema.string().optional() },
        execute: async (args: { runId?: string }, context) => cancelRun(context.sessionID, args.runId),
      }),
      langgraph_pause: tool({
        description: "Cooperatively pause a running LangGraph run at its latest durable checkpoint. Pass the runId returned by langgraph_start, then use langgraph_resume to continue. A node interrupted after external side effects may be replayed on resume.",
        args: { runId: tool.schema.string().optional() },
        execute: async (args: { runId?: string }, context) => pauseRun(context.sessionID, args.runId),
      }),
    },
    config: async (config) => {
      config.agent ??= {};
      config.agent[PRESENTER_AGENT] = { description: "LangGraph lifecycle presenter and graph recovery", mode: "primary", hidden: true, prompt: CONNECTOR_PRESENTER.systemPrompt, tools: CONNECTOR_PRESENTER.tools, maxSteps: CONNECTOR_PRESENTER.maxSteps, permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } };
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
      config.command["graph-pause"] = { description: "Pause the active LangGraph run", agent: PRESENTER_AGENT, template: "Pause the active LangGraph run." };
      config.command["graph-cancel"] = { description: "Cancel the active or queued LangGraph run", agent: PRESENTER_AGENT, template: "Cancel the active LangGraph run." };
    },
    "command.execute.before": async (input) => {
      if (input.command === "run-graph") manualMessages.add(input.sessionID);
      if (input.command === "graph-pause") {
        await pauseRun(input.sessionID);
        cancelledMessages.add(input.sessionID);
        for (const controller of activeControllers.get(input.sessionID) ?? []) controller.abort(new Error("Paused by user"));
      }
      if (input.command === "graph-cancel") {
        cancelledMessages.add(input.sessionID);
        for (const controller of activeControllers.get(input.sessionID) ?? []) controller.abort(new Error("Cancelled by user"));
        const run = readLatestStoredRun(input.sessionID);
        if (run?.status === "running" || run?.status === "queued" || run?.status === "pausing" || run?.status === "paused" || run?.status === "interrupted") {
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
      if (!manual && (interrupted?.status === "interrupted" || interrupted?.status === "paused")) {
        output.message.agent = PRESENTER_AGENT;
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, messageID: rootMessageID, sessionID: input.sessionID, type: "text", synthetic: true, text: "The LangGraph connector is resuming the paused graph with this answer. Reply briefly that it is resuming; do not perform the task yourself." });
        const controller = new AbortController();
        registerController(input.sessionID, controller);
        void executeResume(plugin, interrupted, task, parentModel, controller.signal)
          .then((result) => postGraphResult(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, result))
          .catch((error) => {
            const status = readLatestStoredRun(input.sessionID)?.status;
            if (status !== "paused" && status !== "cancelled") return postGraphFailure(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, error);
          })
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
        graph: graphState?.graph, modelAssignments: graphState?.modelAssignments, signal: controller.signal,
      })
        .then((result) => postGraphResult(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, result))
        .catch((error) => {
          const status = readLatestStoredRun(input.sessionID)?.status;
          if (status !== "paused" && status !== "cancelled") return postGraphFailure(plugin, internalMessages, input.sessionID, rootMessageID, parentModel, error);
        })
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
      body: { messageID, model, agent: PRESENTER_AGENT, system: CONNECTOR_PRESENTER.systemPrompt, parts: [{ type: "text", text }] },
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
      ? `LangGraph ${result.graph} ended without verified success. You may inspect it with langgraph_inspect and, if a solution region caused the failure, recover it with langgraph_prune and langgraph_resume. Otherwise report this result directly; do not claim completion:\n${result.output}`
      : `LangGraph ${result.graph} completed. Present this result directly; do not repeat its edits or rerun it:\n${result.output}`;
  await postRootMessage(plugin, internalMessages, sessionID, parentMessageID, model, text);
}

async function postGraphFailure(plugin: PluginInput, internalMessages: Set<string>, sessionID: string, parentMessageID: string, model: { providerID: string; modelID: string } | undefined, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await postRootMessage(plugin, internalMessages, sessionID, parentMessageID, model, `LangGraph failed: ${message}. Report this failure clearly and suggest /graph for node details. Do not claim the task completed.`);
}

type LoadedGraph = { configured: NonNullable<Awaited<ReturnType<typeof loadConnectorDefinition>>["graphs"][string]> };

async function loadGraphForRun(saved: StoredRun): Promise<LoadedGraph> {
  const loaded = await loadConnectorDefinition(saved.worktree);
  const definition = saved.graph === "solution-lod" ? withSolutionRoleModelAssignments(loaded, saved.modelAssignments) : loaded;
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[saved.graph];
  if (!configured) throw new Error(`Configured graph no longer exists: ${saved.graph}`);
  return { configured };
}

async function resolveStoredRun(sessionID: string, runId?: string, options?: { rootSessionId?: string; worktree?: string }): Promise<StoredRun> {
  const run = runId ? readStoredRun(runId)
    : options?.rootSessionId ? readLatestStoredRun(options.rootSessionId)
      : options?.worktree ? readLatestProjectRun(options.worktree)
        : readLatestStoredRun(sessionID);
  if (!run) throw new Error(runId ? `No LangGraph run found for runId ${runId}.` : options?.worktree ? "No LangGraph run found for this project. Start a graph run first." : "No LangGraph run found for this session. Start a graph run first.");
  return run;
}

function runSummary(saved: StoredRun, state: unknown, progress?: GraphProgressSnapshot): string {
  const values = state as Record<string, unknown> | undefined;
  return JSON.stringify({
    runId: saved.runId, graph: saved.graph, storedStatus: saved.status, phase: values?.phase,
    result: values?.result, callsUsed: values?.callsUsed, usage: values?.usage,
    progress,
  }, null, 2);
}

async function inspectRun(sessionID: string, runId?: string, options?: { rootSessionId?: string; worktree?: string }): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId, options);
  const { configured } = await loadGraphForRun(saved);
  const snapshot = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  const values = snapshot.values as Record<string, unknown> | undefined;
  if (!values || Object.keys(values).length === 0) {
    return JSON.stringify({ runId: saved.runId, graph: saved.graph, rootSessionId: saved.rootSessionId, storedStatus: saved.status, phase: "no-checkpoint-yet", note: "This run has not reached its first checkpoint yet (queued or still acquiring the worktree). There is nothing to inspect or prune until it does." }, null, 2);
  }
  return runSummary(saved, values, configured.progress?.(values as never));
}

async function startRun(plugin: PluginInput, sessionID: string, task: string, graph: string | undefined, context: {
  directory: string;
  worktree: string;
  ask?: ExecuteGraphInput["ask"];
  metadata?: ExecuteGraphInput["metadata"];
}): Promise<string> {
  const latest = readLatestStoredRun(sessionID);
  if (latest && (latest.status === "queued" || latest.status === "running" || latest.status === "pausing" || latest.status === "paused" || latest.status === "interrupted")) {
    throw new Error(`LangGraph run ${latest.runId} is ${latest.status}. Inspect, resume, or cancel it before starting another run from this session.`);
  }
  const runId = randomUUID();
  const graphState = readSessionGraphState(sessionID) ?? readHomeGraphState(context.worktree);
  const parentModel = await rootSessionModel(plugin, sessionID);
  let started = false;
  let resolveStarted!: (value: { runId: string; graph: string }) => void;
  let rejectStarted!: (reason: unknown) => void;
  const persisted = new Promise<{ runId: string; graph: string }>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  void executeGraph(plugin, {
    task,
    rootSessionId: sessionID,
    userMessageId: `tool:${runId}`,
    directory: context.directory,
    worktree: executionWorktree(context.directory, context.worktree),
    parentModel,
    graph: graph ?? graphState?.graph,
    modelAssignments: graphState?.modelAssignments,
    ask: context.ask,
    metadata: context.metadata,
    runId,
    onStarted: (value) => {
      started = true;
      resolveStarted(value);
    },
  }).catch((error) => {
    if (!started) rejectStarted(error);
    else {
      try {
        const current = readStoredRun(runId);
        if (current.status === "running" || current.status === "queued") writeStoredRun({ ...current, status: "failed" });
      } catch { /* run storage was removed externally */ }
    }
  });
  const value = await persisted;
  return JSON.stringify({ ...value, status: "running", next: `Call langgraph_inspect with runId ${value.runId}.` }, null, 2);
}

async function pauseRun(sessionID: string, runId?: string): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId);
  if (saved.status !== "running") throw new Error(`LangGraph run ${saved.runId} is ${saved.status} and cannot be paused.`);
  const { configured } = await loadGraphForRun(saved);
  const snapshot = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  if (!snapshot.values || Object.keys(snapshot.values as object).length === 0) throw new Error(`LangGraph run ${saved.runId} has not reached a durable checkpoint yet.`);
  const current = readStoredRun(saved.runId);
  if (current.status !== "running") throw new Error(`LangGraph run ${saved.runId} is ${current.status} and cannot be paused.`);
  writeStoredRun({ ...current, status: "pausing" });
  const deadline = Date.now() + 30_000;
  let status = "pausing";
  while (status === "pausing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = readStoredRun(saved.runId).status;
  }
  return JSON.stringify({ runId: saved.runId, graph: saved.graph, status }, null, 2);
}

async function cancelRun(sessionID: string, runId?: string): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId);
  const current = readStoredRun(saved.runId);
  if (!["queued", "running", "pausing", "paused", "interrupted"].includes(current.status)) throw new Error(`LangGraph run ${saved.runId} is ${current.status} and cannot be cancelled.`);
  writeStoredRun({ ...current, status: "cancelled" });
  await releaseVerifierWorkspace(saved.runId);
  return JSON.stringify({ runId: saved.runId, graph: saved.graph, status: "cancelled" }, null, 2);
}

type PruneOverrides = { objective?: string; allowedVariables?: string[]; acceptanceCriteria?: string[] };

function applyPruneOverrides(network: Parameters<typeof reopenRegion>[0], regionId: string, overrides: PruneOverrides): Parameters<typeof reopenRegion>[0] {
  if (!overrides.objective && !overrides.allowedVariables && !overrides.acceptanceCriteria) return network;
  const regions = network.regions.map((item) => {
    if (item.id !== regionId) return item;
    return {
      ...item,
      ...(overrides.objective ? { objective: overrides.objective } : {}),
      ...(overrides.allowedVariables ? { allowedVariables: [...overrides.allowedVariables] } : {}),
      ...(overrides.acceptanceCriteria ? { acceptanceCriteria: [...overrides.acceptanceCriteria] } : {}),
    };
  });
  return { ...network, regions };
}

async function pruneRun(sessionID: string, runId: string | undefined, regionId: string, reason?: string, overrides: PruneOverrides = {}): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId);
  if (saved.graph !== "solution-lod") throw new Error("langgraph_prune only supports the solution-lod graph.");
  if (saved.status === "running" || saved.status === "queued") throw new Error(`Cannot prune ${saved.status} run ${saved.runId}; wait for it to finish or fail first.`);
  const { configured } = await loadGraphForRun(saved);
  const snapshot = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  const values = snapshot.values as { network: Parameters<typeof reopenRegion>[0]; activeActivationId?: string; result: string; phase: string; [key: string]: unknown };
  const network0 = values.network;
  const region = network0.regions.find((item: { id: string }) => item.id === regionId);
  if (!region) throw new Error(`Region ${regionId} not found in the run's solution network. Use langgraph_inspect to list regions.`);
  const reopened = reopenRegion(network0, regionId, reason ?? `Reopened by agent: region ${regionId}`);
  const overridden = applyPruneOverrides(reopened, regionId, overrides);
  const network = {
    ...overridden,
    activations: overridden.activations.filter((item: { regionId: string; status: string }) => item.regionId !== regionId || item.status === "completed"),
    regions: overridden.regions.map((item: { id: string; activationIds: string[] }) => item.id === regionId ? { ...item, activationIds: [] } : item),
  };
  const updated = { ...values, network, activeActivationId: undefined, result: "", phase: "pruned" };
  await configured.graph.updateState({ configurable: { thread_id: saved.runId } }, updated, "__start__");
  writeStoredRun({ ...saved, status: "pruned" });
  appendPluginEvent({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, userMessageId: saved.userMessageId, graph: saved.graph, node: `__prune__:${regionId}`, status: "pruned", agent: "connector", model: "connector", text: `Pruned region ${regionId}: ${reason ?? "reopened for resynthesis"}${overrides.objective ? ` · overrode objective: ${overrides.objective}` : ""}`, state: updated });
  const fresh = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  return runSummary(saved, fresh.values, configured.progress?.(fresh.values as never));
}

async function resumeRun(plugin: PluginInput, sessionID: string, runId: string | undefined, answer?: string): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId);
  if (saved.status === "interrupted") {
    const parentModel = await rootSessionModel(plugin, saved.rootSessionId);
    const result = await resumeFromCheckpoint(plugin, saved, new Command({ resume: answer }), { parentModel });
    return JSON.stringify({
      runId: result.runId, graph: result.graph, interrupted: result.interrupted, failed: result.failed,
      output: result.output.slice(0, 8_000),
    }, null, 2);
  }
  if (saved.status === "pruned" || saved.status === "paused") {
    const parentModel = await rootSessionModel(plugin, saved.rootSessionId);
    const result = await resumeFromCheckpoint(plugin, saved, null, { parentModel });
    return JSON.stringify({
      runId: result.runId, graph: result.graph, interrupted: result.interrupted, failed: result.failed,
      output: result.output.slice(0, 8_000),
    }, null, 2);
  }
  throw new Error(`LangGraph run ${saved.runId} is ${saved.status} and cannot be resumed. Prune a region first with langgraph_prune, then resume.`);
}

async function rootSessionModel(plugin: PluginInput, sessionID: string): Promise<{ providerID: string; modelID: string } | undefined> {
  try {
    const messages = await plugin.client.session.messages({ path: { id: sessionID }, query: { directory: plugin.directory }, throwOnError: true });
    return messageModel(messages.data.at(-1)?.info ?? { role: "user" });
  } catch {
    return undefined;
  }
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
  modelAssignments?: import("../core/types.js").SolutionRoleModelAssignments;
  signal?: AbortSignal;
  ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
  runId?: string;
  onStarted?: (input: { runId: string; graph: string }) => void;
}

function watchCancellation(runId: string, upstream?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(upstream?.reason ?? new Error("Graph run cancelled"));
  if (upstream?.aborted) abort(); else upstream?.addEventListener("abort", abort, { once: true });
  const timer = setInterval(() => {
    try {
      const status = readStoredRun(runId).status;
      if (status === "cancelled" || status === "pausing") controller.abort(new Error(status === "pausing" ? "Paused by user" : "Cancelled by user"));
    } catch { /* run is not persisted yet */ }
  }, 250);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => { clearInterval(timer); upstream?.removeEventListener("abort", abort); },
  };
}

async function executeGraph(plugin: PluginInput, input: ExecuteGraphInput): Promise<GraphExecution> {
  const loaded = await loadConnectorDefinition(input.worktree);
  const graphName = input.graph ?? loaded.defaultGraph;
  const definition = graphName === "solution-lod" ? withSolutionRoleModelAssignments(loaded, input.modelAssignments) : loaded;
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[graphName];
  if (!configured) throw new Error(`Unknown LangGraph: ${graphName}`);
  const runId = input.runId ?? randomUUID();
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
  const saved: StoredRun = { checkpointVersion: graphName === "solution-lod" ? 3 : undefined, runId, rootSessionId: input.rootSessionId, userMessageId: input.userMessageId, graph: graphName, task: input.task, directory: input.directory, worktree: input.worktree, modelAssignments: input.modelAssignments, status: "running" };
  writeStoredRun(saved);
  input.onStarted?.({ runId, graph: graphName });
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
    const stopped = signal.aborted ? readStoredRun(runId).status : "failed";
    emit({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, graph: graphName, node: "__end__", status: signal.aborted ? "interrupted" : "failed", agent: "langgraph", model: "langgraph", text });
    writeStoredRun({ ...saved, status: stopped === "pausing" ? "paused" : signal.aborted ? "cancelled" : "failed" });
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
  return resumeFromCheckpoint(plugin, saved, saved.status === "paused" ? null : new Command({ resume: answer }), { parentModel, signal, ask });
}

interface CheckpointResumeOptions {
  parentModel?: { providerID: string; modelID: string };
  signal?: AbortSignal;
  ask?: ExecuteGraphInput["ask"];
}

async function resumeFromCheckpoint(
  plugin: PluginInput,
  saved: StoredRun,
  input: null | InstanceType<typeof Command>,
  options: CheckpointResumeOptions = {},
): Promise<GraphExecution> {
  if (saved.graph === "solution-lod" && saved.checkpointVersion !== 3) throw new Error("This interrupted solution-lod run uses an incompatible checkpoint schema. Start a new message to create a clean state-v3 run.");
  const loaded = await loadConnectorDefinition(saved.worktree);
  const definition = saved.graph === "solution-lod" ? withSolutionRoleModelAssignments(loaded, saved.modelAssignments) : loaded;
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[saved.graph];
  if (!configured) throw new Error(`Configured graph no longer exists: ${saved.graph}`);
  let signal = options.signal ?? new AbortController().signal;
  const cancellation = watchCancellation(saved.runId, signal);
  signal = cancellation.signal;
  const emit = (event: PluginRunEvent) => {
    const linked = { ...event, userMessageId: saved.userMessageId };
    appendPluginEvent(linked);
  };
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: saved.rootSessionId, parentModel: options.parentModel,
    directory: saved.directory, worktree: saved.worktree, signal, ask: options.ask,
    onEvent: (event) => {
      emit({ ...event, at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, progress: event.state ? configured.progress?.(event.state) : undefined });
    },
  });
  let lease: WorktreeLease | undefined;
  const acquire = async () => { if (!lease) lease = await acquireWorktree(saved.worktree, signal); };
  writeStoredRun({ ...saved, status: "running" });
  try {
    const result = await configured.graph.invoke(input, { recursionLimit: 512, configurable: { thread_id: saved.runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: acquire, langgraphPrepareVerifierWorkspace: prepareVerifierWorkspace, langgraphReleaseVerifierWorkspace: releaseVerifierWorkspace }, signal });
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
    const stopped = signal.aborted ? readStoredRun(saved.runId).status : "failed";
    writeStoredRun({ ...saved, status: stopped === "pausing" ? "paused" : signal.aborted ? "cancelled" : "failed" });
    emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: signal.aborted ? "interrupted" : "failed", agent: "langgraph", model: "langgraph", text });
    throw error;
  } finally {
    cancellation.dispose();
    lease?.release();
  }
}

const plugin: PluginModule = { id: "opencode-langgraph", server };
export default plugin;
