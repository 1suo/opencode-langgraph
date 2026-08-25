import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, isInterrupted } from "@langchain/langgraph";
import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConnectorDefinition, withSolutionRoleModelAssignments } from "../core/config.js";
import { DurableFileSaver } from "../core/durable-checkpointer.js";
import { errorMessage } from "../core/error-message.js";
import { assertValidConnector, validateConnector } from "../core/validate.js";
import { OpenCodeAgentRuntime } from "./runtime.js";
import { forwardPermissionEvent } from "./permissions.js";
import { adoptHomeGraphState, appendPluginEvent, classifyMutationRecovery, countRecentFailedRuns, readHomeGraphState, readLatestProjectRun, readLatestStoredRun, readSessionGraphName, readSessionGraphState, readStoredRun, reconcileRuns, updateStoredRun, writeStoredRun, type PluginRunEvent, type StoredRun } from "./store.js";
import { processIdentity, worktreeLeaseController } from "./worktree-lock.js";
import { CONNECTOR_PRESENTER, CONNECTOR_ROOT_SYSTEM_PROMPT, SOLUTION_ROLE_CONTRACTS } from "../core/solution-lod/roles.js";
import { reopenRegion, resetPrunedRegion } from "../core/solution-lod/reducer.js";
import type { GraphProgressNode, GraphProgressSnapshot } from "../core/types.js";
import type { SolutionNetwork } from "../core/solution-lod/types.js";
import { prepareVerifierWorkspace, releaseVerifierWorkspace, workspaceDirtyPaths, workspaceFingerprint } from "./verifier-workspace.js";

const PRESENTER_AGENT = CONNECTOR_PRESENTER.name;
const ACTIVE_RUN_STATUSES: StoredRun["status"][] = ["queued", "running", "pausing", "paused", "interrupted"];

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
  reconcileRuns();
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
        description: "Read a run's saved status, phase, result, usage, and a compact region tree with per-node metadata (status, domain phase, viable candidates, selection). This changes nothing. Pass the runId returned by langgraph_start. With no ID it reads this session's latest run; rootSessionId selects another session and projectScope selects this project's latest run. Pass regionId to drill into one region's candidates, constraints, facts, activations, and artifacts instead of the tree. Use verbose:true only when the full semantic network is strictly required; it returns very large output.",
        args: { runId: tool.schema.string().optional(), rootSessionId: tool.schema.string().optional(), projectScope: tool.schema.boolean().optional(), regionId: tool.schema.string().optional(), verbose: tool.schema.boolean().optional() },
        execute: async (args: { runId?: string; rootSessionId?: string; projectScope?: boolean; regionId?: string; verbose?: boolean }, context) => inspectRun(context.sessionID, args.runId, { rootSessionId: args.rootSessionId, worktree: args.projectScope ? context.worktree : undefined, regionId: args.regionId, verbose: args.verbose }),
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
          await persistHandoffSummary(run);
          updateStoredRun(run.runId, (current) => ({ ...current, status: "cancelled", operator: { ...current.operator, lastOutcome: { at: new Date().toISOString(), kind: "cancelled", message: "Run cancelled explicitly; its checkpoint and handoff summary remain inspectable." } } }));
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
      if (interrupted && ACTIVE_RUN_STATUSES.includes(interrupted.status)) {
        const handoff = await persistHandoffSummary(interrupted);
        output.message.agent = PRESENTER_AGENT;
        output.parts.push({
          id: `prt_${randomUUID().replaceAll("-", "")}`,
          messageID: rootMessageID,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: `Do not perform this task manually or start another execution mechanism. Run ${interrupted.runId} is ${interrupted.status} and still owns the workflow. Explain that no handoff occurred; the operator may pause to review, but must explicitly cancel before repeating a manual handoff request. Current recoverable handoff summary:\n${JSON.stringify(handoff, null, 2)}`,
        });
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
  const message = errorMessage(error);
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

const INSPECT_CLIP = 160;

function clip(text: string | undefined, limit = INSPECT_CLIP): string | undefined {
  if (text === undefined) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

/** Compact per-region rows — the same metadata the TUI left panel shows, without the semantic network. */
function inspectNodeTree(progress?: GraphProgressSnapshot): Array<Record<string, unknown>> | undefined {
  if (!progress?.nodes.length) return undefined;
  const totals = new Map(progress.semantic?.regions.map((region) => [region.id, region.total]) ?? []);
  return progress.nodes.map((node: GraphProgressNode) => {
    const row: Record<string, unknown> = { id: node.id, parentId: node.parentId, level: node.level, status: node.status, title: clip(node.title, 120) };
    for (const key of ["operation", "domainPhase", "challengeVerdict"] as const) if (node[key]) row[key] = node[key];
    if (node.evidence !== undefined) row.facts = node.evidence;
    if (node.viable !== undefined) row.viable = `${node.viable}/${totals.get(node.id) ?? node.viable}`;
    if (node.cegarRound) row.cegarRound = node.cegarRound;
    if (node.selectedCandidateId) row.selectedCandidateId = node.selectedCandidateId;
    if (node.blockedReason) row.blockedReason = clip(node.blockedReason);
    return row;
  });
}

function inspectTelemetry(progress?: GraphProgressSnapshot): Record<string, unknown> | undefined {
  const telemetry = progress?.telemetry;
  if (!telemetry) return undefined;
  return {
    activations: telemetry.activations, retries: telemetry.retries, reopens: telemetry.reopens,
    counterexampleRepairs: telemetry.counterexampleRepairs, cycles: telemetry.cycles,
    candidates: telemetry.candidates, regionCount: telemetry.regionCount,
    validationFailures: telemetry.validationFailures, elapsedMs: telemetry.elapsedMs,
    blockedReasons: telemetry.blockedReasons.map((reason) => clip(reason, 80)),
    cost: telemetry.usage.cost,
  };
}

function runSummary(saved: StoredRun, state: unknown, progress?: GraphProgressSnapshot, options?: { verbose?: boolean }): string {
  const values = state as Record<string, unknown> | undefined;
  if (options?.verbose) {
    return JSON.stringify({
      runId: saved.runId, graph: saved.graph, storedStatus: saved.status, phase: values?.phase,
      result: values?.result, callsUsed: values?.callsUsed, usage: values?.usage,
      progress, metrics: saved.metrics, dirtyWarning: saved.dirtyWarning, operator: saved.operator,
    }, null, 2);
  }
  return JSON.stringify({
    runId: saved.runId, graph: saved.graph, storedStatus: saved.status, phase: values?.phase,
    activeNode: progress?.activeNodeId,
    ...(typeof values?.result === "string" && values.result ? { result: values.result } : {}),
    callsUsed: values?.callsUsed, usage: values?.usage, metrics: saved.metrics,
    dirtyWarning: saved.dirtyWarning, operator: saved.operator,
    nodes: inspectNodeTree(progress), telemetry: inspectTelemetry(progress),
    next: "Default output is a compact tree. Pass regionId to langgraph_inspect for one region's candidates, constraints, facts, activations, and artifacts. verbose:true dumps the full semantic network; avoid it unless strictly needed.",
  }, null, 2);
}

function stanceRows(network: SolutionNetwork, stances: SolutionNetwork["candidates"][number]["stances"]) {
  const names = new Map(network.variables.map((variable) => [variable.id, variable.name]));
  return (stances ?? []).map((stance) => ({ choice: names.get(stance.variableId) ?? stance.variableId, relation: stance.relation, option: stance.valueLabel }));
}

/** One region's full local slice: candidates, constraints, facts, activations, artifacts. */
export function buildRegionDetail(network: SolutionNetwork, regionId: string): Record<string, unknown> {
  const region = network.regions.find((item) => item.id === regionId);
  if (!region) throw new Error(`Region ${regionId} not found in this run's solution network. Live regions: ${network.regions.map((item) => item.id).join(", ") || "none"}.`);
  const candidateIds = new Set(region.candidateIds);
  const evidenceById = new Map(network.evidence.map((item) => [item.id, item]));
  const activationById = new Map(network.activations.map((item) => [item.id, item]));
  const artifactById = new Map(network.artifacts.map((item) => [item.id, item]));
  return {
    region: {
      id: region.id, parentId: region.parentId, edge: region.edge, lod: region.lod, scopeId: region.scopeId,
      objective: region.objective, delivery: region.delivery,
      allowedVariables: region.allowedVariables,
      criteria: region.acceptanceCriteria.map((criterion, index) => ({ criterionId: region.criterionIds[index], criterion })),
      status: region.status, domainPhase: region.domainPhase,
      domainFingerprint: region.domainFingerprint, acceptedFingerprint: region.acceptedFingerprint,
      cegarRound: region.cegarRound, challengeVerdict: region.challengeVerdict,
      mutationResources: region.mutationResources, requirementIds: region.requirementIds,
      dependencyScopeIds: region.dependencyScopeIds,
      reopens: region.reopens, noProgressCount: region.noProgressCount,
      convergenceCycles: (region.convergenceCycles ?? []).map(({ kind, revision }) => ({ kind, revision })),
      ...(region.blockedReason ? { blockedReason: region.blockedReason } : {}),
      ...(region.contradiction ? { contradiction: region.contradiction } : {}),
      ...(region.certifiedLeaf ? { certifiedLeaf: region.certifiedLeaf } : {}),
      ...(region.answer ? { answer: region.answer } : {}),
    },
    candidates: region.candidateIds.flatMap((id) => {
      const candidate = network.candidates.find((item) => item.id === id);
      return candidate ? [{ id: candidate.id, key: candidate.key, proposition: candidate.proposition, status: candidate.status, eliminationReasons: candidate.eliminationReasons, factIds: candidate.evidenceIds, stances: stanceRows(network, candidate.stances) }] : [];
    }),
    constraints: network.constraints.filter((item) => !item.historical && (region.constraintIds.includes(item.id) || candidateIds.has(item.subject) || candidateIds.has(item.target)))
      .map(({ id, kind, subject, target, reason, sourceKind, evidenceRefs }) => ({ id, kind, subject, target, reason, sourceKind, evidenceRefs })),
    facts: region.evidenceIds.flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [{ id: item.id, text: item.text, source: item.source, kind: item.kind, status: item.status ?? (item.kind === "inference" ? "hypothesis" : "confirmed") }] : [];
    }),
    activations: region.activationIds.flatMap((id) => {
      const item = activationById.get(id);
      return item ? { id: item.id, capability: item.capability, operation: item.operation, status: item.status, request: clip(item.request, 200), expectedDelta: item.expectedDelta, error: clip(item.error) } : [];
    }),
    artifacts: region.artifactIds.flatMap((id) => {
      const item = artifactById.get(id);
      return item && !item.historical ? { id: item.id, kind: item.kind, path: item.path, summary: clip(item.summary), passed: item.passed, criterionIds: item.criterionIds, findings: item.findings } : [];
    }),
    telemetry: network.telemetry?.regions[regionId],
  };
}

export function buildHandoffSummary(saved: StoredRun, state?: unknown): Record<string, unknown> {
  const values = state as { phase?: unknown; result?: unknown; network?: { regions?: Array<Record<string, unknown>>; candidates?: Array<Record<string, unknown>>; evidence?: Array<Record<string, unknown>>; artifacts?: Array<Record<string, unknown>> } } | undefined;
  const network = values?.network;
  const selectedIds = new Set((network?.regions ?? []).flatMap((region) => Array.isArray(region.selectedCandidateIds) ? region.selectedCandidateIds as string[] : []));
  return {
    runId: saved.runId,
    status: saved.status,
    phase: values?.phase ?? "no-checkpoint-yet",
    result: values?.result,
    selectedCandidates: (network?.candidates ?? []).filter((candidate) => selectedIds.has(String(candidate.id))).map((candidate) => ({ id: candidate.id, regionId: candidate.regionId, proposition: candidate.proposition })),
    evidence: (network?.evidence ?? []).map((item) => ({ id: item.id, text: item.text, source: item.source, status: item.status })),
    artifacts: network?.artifacts ?? [],
    unfinishedRegions: (network?.regions ?? []).filter((region) => region.status !== "verified" && region.status !== "collapsed").map((region) => ({ id: region.id, objective: region.objective, status: region.status, scopeId: region.scopeId })),
    note: "This is a summary only; scheduler ownership was not transferred and the graph was not marked complete.",
  };
}

async function persistHandoffSummary(saved: StoredRun): Promise<Record<string, unknown>> {
  let state: unknown;
  try {
    const { configured } = await loadGraphForRun(saved);
    state = (await configured.graph.getState({ configurable: { thread_id: saved.runId } })).values;
  } catch { /* queued runs may not have a checkpoint yet */ }
  const summary = buildHandoffSummary(saved, state);
  const outcomes = ["inspect the active run", "pause and review without transferring ownership", "cancel explicitly, then repeat the manual handoff request"];
  updateStoredRun(saved.runId, (current) => ({ ...current, operator: { ...current.operator, lastOutcome: { at: new Date().toISOString(), kind: "handoff-blocked", message: "Manual execution was blocked while the graph remained active." }, handoff: { at: new Date().toISOString(), summary, outcomes } } }));
  return { ...summary, outcomes };
}

async function inspectRun(sessionID: string, runId?: string, options?: { rootSessionId?: string; worktree?: string; regionId?: string; verbose?: boolean }): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId, options);
  const { configured } = await loadGraphForRun(saved);
  const snapshot = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  const values = snapshot.values as Record<string, unknown> | undefined;
  if (!values || Object.keys(values).length === 0) {
    return JSON.stringify({ runId: saved.runId, graph: saved.graph, rootSessionId: saved.rootSessionId, storedStatus: saved.status, phase: "no-checkpoint-yet", note: "This run has not reached its first checkpoint yet (queued or still acquiring the worktree). There is nothing to inspect or prune until it does." }, null, 2);
  }
  if (options?.regionId !== undefined) {
    if (saved.graph !== "solution-lod") throw new Error(`langgraph_inspect regionId drill-down only supports the solution-lod graph, not ${saved.graph}.`);
    const network = values.network as SolutionNetwork | undefined;
    if (!network) throw new Error("The checkpointed state contains no solution network to drill into.");
    return JSON.stringify({
      runId: saved.runId, graph: saved.graph, storedStatus: saved.status, phase: values.phase,
      ...buildRegionDetail(network, options.regionId),
    }, null, 2);
  }
  return runSummary(saved, values, configured.progress?.(values as never), { verbose: options?.verbose });
}

async function startRun(plugin: PluginInput, sessionID: string, task: string, graph: string | undefined, context: {
  directory: string;
  worktree: string;
  ask?: ExecuteGraphInput["ask"];
  metadata?: ExecuteGraphInput["metadata"];
}): Promise<string> {
  // A failing host or a looping agent must not multiply doomed runs: if several runs
  // started from this session failed recently, require explicit user action instead.
  const recentFailures = countRecentFailedRuns(sessionID, 10 * 60_000);
  if (recentFailures >= 3) throw new Error(`LangGraph refused to start: ${recentFailures} runs from this session failed in the last 10 minutes. Resolve the underlying issue and use /run-graph explicitly to continue.`);
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
        if (current.status === "running" || current.status === "queued") updateStoredRun(runId, (latest) => latest.status === "running" || latest.status === "queued" ? { ...latest, status: "failed" } : latest);
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
  updateStoredRun(saved.runId, (latest) => {
    if (latest.status !== "running") throw new Error(`LangGraph run ${saved.runId} is ${latest.status} and cannot be paused.`);
    return { ...latest, status: "pausing" };
  });
  const deadline = Date.now() + 30_000;
  let status = "pausing";
  while (status === "pausing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = readStoredRun(saved.runId).status;
  }
  if (status === "paused") {
    updateRunMetrics(saved.runId);
    updateStoredRun(saved.runId, (current) => ({ ...current, operator: { ...current.operator, lastOutcome: { at: new Date().toISOString(), kind: "paused", message: "Run paused; inspect and resume, prune, or cancel explicitly." } } }));
  }
  return JSON.stringify({ runId: saved.runId, graph: saved.graph, status, outcomes: status === "paused" ? ["inspect", "resume if replay-safe", "prune affected work", "cancel for manual handoff"] : ["inspect current status", "cancel if pause cannot complete"] }, null, 2);
}

async function cancelRun(sessionID: string, runId?: string): Promise<string> {
  const saved = await resolveStoredRun(sessionID, runId);
  const current = readStoredRun(saved.runId);
  if (!["queued", "running", "pausing", "paused", "interrupted"].includes(current.status)) throw new Error(`LangGraph run ${saved.runId} is ${current.status} and cannot be cancelled.`);
  await persistHandoffSummary(saved);
  updateStoredRun(saved.runId, (latest) => {
    if (!["queued", "running", "pausing", "paused", "interrupted"].includes(latest.status)) throw new Error(`LangGraph run ${saved.runId} is ${latest.status} and cannot be cancelled.`);
    return { ...latest, status: "cancelled", operator: { ...latest.operator, lastOutcome: { at: new Date().toISOString(), kind: "cancelled", message: "Run cancelled explicitly; state remains inspectable and may be pruned before recovery." } } };
  });
  updateRunMetrics(saved.runId);
  await releaseVerifierWorkspace(saved.runId);
  return JSON.stringify({ runId: saved.runId, graph: saved.graph, status: "cancelled", outcomes: ["inspect the retained checkpoint", "prune a region before graph recovery", "use the persisted handoff summary for manual work"] }, null, 2);
}

type PruneOverrides = { objective?: string; allowedVariables?: string[]; acceptanceCriteria?: string[] };

export function applyPruneOverrides(network: Parameters<typeof reopenRegion>[0], regionId: string, overrides: PruneOverrides): Parameters<typeof reopenRegion>[0] {
  if (!overrides.objective && !overrides.allowedVariables && !overrides.acceptanceCriteria) return network;
  const regions = network.regions.map((item) => {
    if (item.id !== regionId) return item;
    return {
      ...item,
      ...(overrides.objective ? { objective: overrides.objective } : {}),
      ...(overrides.allowedVariables ? { allowedVariables: [...overrides.allowedVariables] } : {}),
      ...(overrides.acceptanceCriteria ? {
        acceptanceCriteria: [...overrides.acceptanceCriteria],
        criterionIds: overrides.acceptanceCriteria.map((_, index) => `criterion:${item.scopeId}:${index}` as const),
      } : {}),
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
  const reopened = resetPrunedRegion(reopenRegion(network0, regionId, reason ?? `Reopened by agent: region ${regionId}`), regionId);
  const overridden = applyPruneOverrides(reopened, regionId, overrides);
  const network = {
    ...overridden,
    activations: overridden.activations.filter((item: { regionId: string; status: string }) => item.regionId !== regionId || item.status === "completed"),
    regions: overridden.regions.map((item: { id: string; activationIds: string[] }) => item.id === regionId ? { ...item, activationIds: [] } : item),
  };
  const updated = { ...values, network, activeActivationId: undefined, result: "", phase: "pruned" };
  await configured.graph.updateState({ configurable: { thread_id: saved.runId } }, updated, "__start__");
  updateStoredRun(saved.runId, (current) => ({ ...current, status: "pruned", recovery: undefined, mutation: undefined }));
  appendPluginEvent({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, userMessageId: saved.userMessageId, graph: saved.graph, node: `__prune__:${regionId}`, status: "pruned", agent: "connector", model: "connector", text: `Pruned region ${regionId}: ${reason ?? "reopened for resynthesis"}${overrides.objective ? ` · overrode objective: ${overrides.objective}` : ""}`, state: updated });
  const fresh = await configured.graph.getState({ configurable: { thread_id: saved.runId } });
  return runSummary(saved, fresh.values, configured.progress?.(fresh.values as never));
}

async function resumeRun(plugin: PluginInput, sessionID: string, runId: string | undefined, answer?: string): Promise<string> {
  const saved = refreshResumeRecovery(await resolveStoredRun(sessionID, runId));
  const replay = classifyResumeReplay(saved);
  if (replay === "review-required") throw new Error(`LangGraph run ${saved.runId} may contain uncheckpointed workspace mutations. Inspect the worktree and prune the affected region before resuming.`);
  if (saved.status === "interrupted") {
    const parentModel = await rootSessionModel(plugin, saved.rootSessionId);
    const result = await resumeFromCheckpoint(plugin, saved, replay === "checkpoint-replay" ? null : new Command({ resume: answer }), { parentModel });
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

export function classifyResumeReplay(run: StoredRun): "human-resume" | "checkpoint-replay" | "review-required" {
  const recovery = classifyMutationRecovery(run);
  if (recovery?.kind === "review-required") return "review-required";
  if (run.status === "paused" || run.status === "pruned" || recovery?.kind === "replay-safe") return "checkpoint-replay";
  return "human-resume";
}

function refreshResumeRecovery(saved: StoredRun): StoredRun {
  if (!saved.mutation || saved.mutation.phase === "checkpointed") return saved;
  return updateStoredRun(saved.runId, (current) => {
    const recovery = classifyMutationRecovery(current);
    return { ...current, recovery, ...(recovery?.kind === "review-required" ? { operator: { ...current.operator, lastOutcome: { at: new Date().toISOString(), kind: "review-required", message: recovery.reason } } } : {}) };
  });
}

function resourcePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  return value.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" ? [(item as { path: string }).path] : []);
}

export function plannedMutationResources(state: unknown, node: string): string[] | undefined {
  if (!state || typeof state !== "object") return;
  const values = state as Record<string, unknown>;
  for (const key of ["plannedMutationResources", "mutationResources", "writeResources", "resources"]) {
    const direct = resourcePaths(values[key]);
    if (direct) return [...new Set(direct)].sort();
  }
  const network = values.network as { activations?: Array<Record<string, unknown>>; regions?: Array<Record<string, unknown>> } | undefined;
  const regionId = node.slice(node.indexOf(":") + 1);
  const owners = [...(network?.activations ?? []).filter((item) => item.regionId === regionId && item.capability === "implement"), ...(network?.regions ?? []).filter((item) => item.id === regionId)];
  for (const owner of owners) for (const key of ["plannedMutationResources", "mutationResources", "writeResources", "resources"]) {
    const nested = resourcePaths(owner[key]);
    if (nested) return [...new Set(nested)].sort();
  }
  return;
}

function overlappingDirtyPaths(dirty: string[], resources: string[] | undefined): string[] {
  if (resources === undefined) return dirty;
  const prefixes = resources.map((resource) => resource.replaceAll("\\", "/").replace(/[*?].*$/, "").replace(/\/$/, ""));
  return dirty.filter((file) => prefixes.some((prefix) => prefix && (file === prefix || file.startsWith(`${prefix}/`) || prefix.startsWith(`${file}/`))));
}

export function updateRunMetrics(runId: string, state?: unknown): void {
  const values = state as { callsUsed?: unknown; usage?: unknown; network?: { activations?: unknown[]; regions?: Array<{ reopens?: number }>; telemetry?: import("../core/solution-lod/types.js").SolutionTelemetry } } | undefined;
  updateStoredRun(runId, (current) => {
    const startedAt = current.metrics?.startedAt ?? Date.now();
    const now = Date.now();
    return { ...current, metrics: {
      ...current.metrics, startedAt, updatedAt: now, elapsedMs: now - startedAt,
      ...(typeof values?.callsUsed === "number" ? { callsUsed: values.callsUsed } : {}),
      ...(values?.usage && typeof values.usage === "object" ? { usage: values.usage as import("../core/types.js").AgentUsage } : {}),
      ...(values?.network?.activations ? { activations: values.network.activations.length } : {}),
      ...(values?.network?.regions ? { regions: values.network.regions.length, reopens: values.network.regions.reduce((sum, region) => sum + (region.reopens ?? 0), 0) } : {}),
      ...(values?.network?.telemetry ? { telemetry: values.network.telemetry } : {}),
    } };
  });
}

export function recordMutationBoundary(runId: string, worktree: string, node: string, status: string, state?: unknown): StoredRun["dirtyWarning"] {
  let warning: StoredRun["dirtyWarning"];
  updateStoredRun(runId, (current) => {
    const prior = current.mutation;
    if (!node.startsWith("implement:")) {
      return prior?.phase === "observed" ? { ...current, mutation: { ...prior, phase: "checkpointed" }, recovery: undefined } : current;
    }
    if (status === "active") {
      if (prior?.node === node && prior.phase === "active") return current;
      let before = "unavailable";
      try { before = workspaceFingerprint(worktree); } catch { /* force review if this invocation becomes stale */ }
      const dirtyPaths = workspaceDirtyPaths(worktree);
      const resources = plannedMutationResources(state, node);
      const overlaps = overlappingDirtyPaths(dirtyPaths, resources);
      if (overlaps.length) warning = {
        at: new Date().toISOString(), node, dirtyPaths, ...(resources === undefined ? {} : { plannedResources: resources }), overlaps,
        policy: "Preserve existing work. The connector will not commit, stash, reset, or discard it.",
        outcomes: ["continue while preserving existing changes", "pause and review overlapping paths", "cancel and request a manual handoff summary"],
      };
      return { ...current, mutation: { node, phase: "active", before, at: new Date().toISOString() }, recovery: undefined, ...(warning ? { dirtyWarning: warning } : {}) };
    }
    if (status === "completed" && prior?.node === node) {
      let after = "unavailable";
      try { after = workspaceFingerprint(worktree); } catch { /* force review if this invocation becomes stale */ }
      return { ...current, mutation: { ...prior, phase: "observed", after, at: new Date().toISOString() } };
    }
    return current;
  });
  return warning;
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

type ConfiguredGraph = LoadedGraph["configured"];
type ConnectorDefinition = Awaited<ReturnType<typeof loadConnectorDefinition>>;

async function invokeConfiguredRun(options: {
  plugin: PluginInput;
  saved: StoredRun;
  definition: ConnectorDefinition;
  configured: ConfiguredGraph;
  invokeInput: null | InstanceType<typeof Command> | Record<string, unknown>;
  parentModel?: { providerID: string; modelID: string };
  signal?: AbortSignal;
  ask?: ExecuteGraphInput["ask"];
  metadata?: ExecuteGraphInput["metadata"];
  queueStatus: boolean;
  terminalStatusFirst: boolean;
  resumeCheckpointId?: string;
  resumeConfig?: Record<string, unknown>;
}): Promise<GraphExecution> {
  const { plugin, saved, definition, configured } = options;
  const cancellation = watchCancellation(saved.runId, options.signal);
  const signal = cancellation.signal;
  const emit = (event: PluginRunEvent) => appendPluginEvent({ ...event, userMessageId: saved.userMessageId });
  const runtime = new OpenCodeAgentRuntime({
    plugin, definition, parentSessionId: saved.rootSessionId, parentModel: options.parentModel,
    directory: saved.directory, worktree: saved.worktree, signal, ask: options.ask,
    onEvent: (event) => {
      const warning = recordMutationBoundary(saved.runId, saved.worktree, event.node, event.status, event.state);
      updateRunMetrics(saved.runId, event.state);
      emit({ ...event, at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, progress: event.state ? configured.progress?.(event.state) : undefined });
      if (warning) emit({ at: warning.at, runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__warning__:dirty-overlap", status: "warning", agent: "connector", model: "policy", text: JSON.stringify(warning), state: event.state });
      options.metadata?.({ title: `LangGraph · ${event.node}`, metadata: { runId: saved.runId, graph: saved.graph, ...event } });
    },
  });
  const lease = worktreeLeaseController(saved.worktree, signal, options.queueStatus ? (position) => emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__queue__", status: "queued", agent: "connector", model: "fifo", text: `Waiting for worktree · position ${position}` }) : undefined);
  const acquire = async () => {
    if (options.queueStatus) updateStoredRun(saved.runId, (current) => current.status === "running" ? { ...current, status: "queued" } : current);
    await lease.acquire();
    if (options.queueStatus) updateStoredRun(saved.runId, (current) => current.status === "queued" ? { ...current, status: "running", hostPid: process.pid, hostIdentity: processIdentity(process.pid) } : current);
  };
  const setTerminal = (status: "failed" | "completed", result: Record<string, unknown>) => {
    updateRunMetrics(saved.runId, result);
    updateStoredRun(saved.runId, (current) => current.status === "cancelled" ? current : { ...current, status, mutation: current.mutation ? { ...current.mutation, phase: "checkpointed" } : undefined });
  };
  try {
    const result = await configured.graph.invoke(options.invokeInput, { recursionLimit: 512, configurable: { thread_id: saved.runId, ...options.resumeConfig, ...(options.resumeCheckpointId ? { checkpoint_id: options.resumeCheckpointId } : {}), langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: acquire, langgraphPrepareVerifierWorkspace: prepareVerifierWorkspace, langgraphReleaseVerifierWorkspace: releaseVerifierWorkspace }, signal });
    if (isInterrupted(result)) {
      updateStoredRun(saved.runId, (current) => ({ ...current, status: "interrupted" }));
      const output = JSON.stringify(result.__interrupt__.map((item) => item.value), null, 2);
      emit({ at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__interrupt__", status: "interrupted", agent: "human", model: "input", text: output, state: result, progress: configured.progress?.(result) });
      return { runId: saved.runId, graph: saved.graph, output, interrupted: true, failed: false };
    }
    const output = configured.result ? configured.result(result) : typeof result.report === "string" ? result.report : JSON.stringify(result, null, 2);
    const progress = configured.progress?.(result);
    const failed = progress?.phase === "failed" || progress?.phase === "blocked";
    const status = failed ? "failed" as const : "completed" as const;
    const event = { at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status, agent: "langgraph", model: "langgraph", text: output, state: result, progress };
    if (options.terminalStatusFirst) setTerminal(status, result); else emit(event);
    if (options.terminalStatusFirst) emit(event); else setTerminal(status, result);
    return { runId: saved.runId, graph: saved.graph, output, interrupted: false, failed };
  } catch (error) {
    const text = errorMessage(error);
    const stopped = signal.aborted ? readStoredRun(saved.runId).status : "failed";
    const event = { at: new Date().toISOString(), runId: saved.runId, rootSessionId: saved.rootSessionId, graph: saved.graph, node: "__end__", status: signal.aborted ? "interrupted" : "failed", agent: "langgraph", model: "langgraph", text };
    const setStopped = () => updateStoredRun(saved.runId, (current) => {
      const next = { ...current, status: stopped === "pausing" ? "paused" as const : signal.aborted ? "cancelled" as const : "failed" as const };
      return next.status === "paused" ? { ...next, recovery: classifyMutationRecovery(next) } : next;
    });
    if (options.terminalStatusFirst) setStopped(); else emit(event);
    if (options.terminalStatusFirst) emit(event); else setStopped();
    throw error;
  } finally {
    cancellation.dispose();
    lease.release();
  }
}

async function executeGraph(plugin: PluginInput, input: ExecuteGraphInput): Promise<GraphExecution> {
  const loaded = await loadConnectorDefinition(input.worktree);
  const graphName = input.graph ?? loaded.defaultGraph;
  const definition = graphName === "solution-lod" ? withSolutionRoleModelAssignments(loaded, input.modelAssignments) : loaded;
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[graphName];
  if (!configured) throw new Error(`Unknown LangGraph: ${graphName}`);
  const runId = input.runId ?? randomUUID();
  const startedAt = Date.now();
  const saved: StoredRun = { checkpointVersion: graphName === "solution-lod" ? 8 : undefined, runId, rootSessionId: input.rootSessionId, userMessageId: input.userMessageId, graph: graphName, task: input.task, directory: input.directory, worktree: input.worktree, modelAssignments: input.modelAssignments, hostPid: process.pid, hostIdentity: processIdentity(process.pid), status: "running", metrics: { startedAt, updatedAt: startedAt, elapsedMs: 0 } };
  writeStoredRun(saved);
  input.onStarted?.({ runId, graph: graphName });
  const drawable = await configured.graph.getGraphAsync({ xray: true });
  const serialized = drawable.toJSON() as { nodes: Array<{ id: string }> | Record<string, unknown>; edges: Array<{ source: string; target: string }> };
  const topology = { nodes: Array.isArray(serialized.nodes) ? serialized.nodes.map((node) => node.id) : Object.keys(serialized.nodes), edges: serialized.edges.map(({ source, target }) => ({ source, target })) };
  const mermaid = drawable.drawMermaid({ withStyles: false });
  const initialState = configured.initial({ task: input.task, conversationContext: input.conversationContext, directory: input.directory, worktree: input.worktree, runId });
  appendPluginEvent({ at: new Date().toISOString(), runId, rootSessionId: input.rootSessionId, userMessageId: input.userMessageId, graph: graphName, node: "__start__", status: "active", agent: "langgraph", model: "langgraph", state: initialState, mermaid, topology, progress: configured.progress?.(initialState) });
  return invokeConfiguredRun({ plugin, saved, definition, configured, invokeInput: initialState, parentModel: input.parentModel, signal: input.signal, ask: input.ask, metadata: input.metadata, queueStatus: true, terminalStatusFirst: false });
}

async function executeResume(
  plugin: PluginInput,
  saved: StoredRun,
  answer: unknown,
  parentModel?: { providerID: string; modelID: string },
  signal = new AbortController().signal,
  ask?: ExecuteGraphInput["ask"],
): Promise<GraphExecution> {
  saved = refreshResumeRecovery(saved);
  const replay = classifyResumeReplay(saved);
  if (replay === "review-required") throw new Error(`LangGraph run ${saved.runId} requires workspace review before resume.`);
  return resumeFromCheckpoint(plugin, saved, replay === "checkpoint-replay" ? null : new Command({ resume: answer }), { parentModel, signal, ask });
}

interface CheckpointResumeOptions {
  parentModel?: { providerID: string; modelID: string };
  signal?: AbortSignal;
  ask?: ExecuteGraphInput["ask"];
}

async function resumeFromCheckpoint(
  plugin: PluginInput,
  saved: StoredRun,
  input: null | InstanceType<typeof Command> | Record<string, unknown>,
  options: CheckpointResumeOptions = {},
): Promise<GraphExecution> {
  saved = refreshResumeRecovery(saved);
  if (classifyResumeReplay(saved) === "review-required") throw new Error(`LangGraph run ${saved.runId} requires workspace review before resume.`);
  if (saved.graph === "solution-lod" && saved.checkpointVersion !== 8) throw new Error("This interrupted solution-lod run uses an incompatible checkpoint schema. Start a new message to create a clean state-v8 run.");
  const loaded = await loadConnectorDefinition(saved.worktree);
  const definition = saved.graph === "solution-lod" ? withSolutionRoleModelAssignments(loaded, saved.modelAssignments) : loaded;
  assertValidConnector(await validateConnector(definition));
  const configured = definition.graphs[saved.graph];
  if (!configured) throw new Error(`Configured graph no longer exists: ${saved.graph}`);
  updateStoredRun(saved.runId, (current) => ({ ...current, status: "running", hostPid: process.pid, hostIdentity: processIdentity(process.pid), recovery: undefined, mutation: current.recovery ? undefined : current.mutation }));
  let resumeCheckpointId: string | undefined;
  let resumeConfig: Record<string, unknown> | undefined;
  if (input === null && configured.graph.checkpointer instanceof DurableFileSaver) {
    resumeConfig = await configured.graph.checkpointer.resumeConfig(saved.runId);
    resumeCheckpointId = await configured.graph.checkpointer.latestCheckpointId(saved.runId);
  }
  return invokeConfiguredRun({ plugin, saved, definition, configured, invokeInput: input, parentModel: options.parentModel, signal: options.signal, ask: options.ask, queueStatus: false, terminalStatusFirst: true, resumeCheckpointId, resumeConfig });
}

const plugin: PluginModule = { id: "opencode-langgraph", server };
export default plugin;
