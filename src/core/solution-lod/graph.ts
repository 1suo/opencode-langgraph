import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z, type ZodType } from "zod";
import { DurableFileSaver } from "../durable-checkpointer.js";
import type { AgentCallResult, AgentRuntime, AgentUsage, ConnectorGraph, GraphProgressSnapshot, SolutionSemanticSnapshot } from "../types.js";
import { completeImplementation, completePresentation, completeVerification, ensureRunnableWork, initialNetwork, markActivation, mergeSolutionDelta, nextQueuedActivation, setRegionStatus } from "./reducer.js";
import { DEFAULT_SOLUTION_ROLE_LIMITS, ImplementationOutputSchema, PresentationOutputSchema, SolutionDeltaSchema, VerificationOutputSchema, type Activation, type Capability, type SolutionLodState, type SolutionNetwork, type SolutionRoleLimits } from "./types.js";

const SolutionState = Annotation.Root({
  stateVersion: Annotation<3>, runId: Annotation<string>, originalTask: Annotation<string>, conversationContext: Annotation<string>, directory: Annotation<string>, worktree: Annotation<string>, phase: Annotation<string>,
  activeActivationId: Annotation<string | undefined>, network: Annotation<SolutionNetwork>, usage: Annotation<AgentUsage>, callsUsed: Annotation<number>, startedAt: Annotation<number>, worktreeAcquired: Annotation<boolean>, result: Annotation<string>,
});

const EMPTY_USAGE: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const addUsage = (left: AgentUsage, right?: AgentUsage): AgentUsage => ({ turns: left.turns + (right?.turns ?? 0), input: left.input + (right?.input ?? 0), output: left.output + (right?.output ?? 0), reasoning: left.reasoning + (right?.reasoning ?? 0), cacheRead: left.cacheRead + (right?.cacheRead ?? 0), cacheWrite: left.cacheWrite + (right?.cacheWrite ?? 0), cost: left.cost + (right?.cost ?? 0) });

const durableSavers = new Map<string, DurableFileSaver>();
export function defaultSolutionCheckpointer(): DurableFileSaver {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const directory = path.join(stateBase, "opencode-langgraph", "checkpoints"); fs.mkdirSync(directory, { recursive: true });
  const existing = durableSavers.get(directory); if (existing) return existing;
  const saver = new DurableFileSaver(directory); durableSavers.set(directory, saver); return saver;
}

export interface SolutionLodOptions {
  agents: Record<Capability, string>;
  roleLimits?: Partial<SolutionRoleLimits>;
  checkpointer?: BaseCheckpointSaver;
}

function runtime(config?: RunnableConfig): AgentRuntime {
  const value = config?.configurable?.langgraphOpenCodeRuntime as AgentRuntime | undefined;
  if (!value) throw new Error("Solution LOD node was invoked without an OpenCode runtime");
  return value;
}

function structured<Output>(result: AgentCallResult, schema: ZodType<Output>): Output {
  if (result.structured !== undefined) return schema.parse(result.structured);
  const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return schema.parse(JSON.parse((fenced ?? result.text).trim()));
}

function lineage(network: SolutionNetwork, regionId: string) {
  const result = []; let cursor = network.regions.find((item) => item.id === regionId);
  while (cursor) {
    result.unshift({ id: cursor.id, lod: cursor.lod, objective: cursor.objective, selectedCandidates: cursor.selectedCandidateIds.map((id) => network.candidates.find((item) => item.id === id)?.proposition).filter(Boolean) });
    cursor = cursor.parentId ? network.regions.find((item) => item.id === cursor?.parentId) : undefined;
  }
  return result;
}

export function projectActivationContext(state: SolutionLodState, activation: Activation): Record<string, unknown> {
  const region = state.network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Activation ${activation.id} references missing region ${activation.regionId}`);
  const refs = new Set([...activation.contextRefs, ...region.evidenceIds, ...region.constraintIds, ...region.artifactIds]);
  return {
    task: state.originalTask,
    conversationContext: state.conversationContext || undefined,
    activation: { id: activation.id, capability: activation.capability, request: activation.request, expectedDelta: activation.expectedDelta },
    availableCapabilities: [
      { capability: "inspect", useWhen: "A named repository fact is missing", produces: "evidence and evidence-backed constraints" },
      { capability: "synthesize", useWhen: "The current domain must be formed or collapsed from available evidence", produces: "candidates, selection constraints, and conditional next-LOD regions" },
      { capability: "implement", useWhen: "A change region is already actionable", produces: "workspace artifacts and focused checks" },
      { capability: "verify", useWhen: "A change region has implementation artifacts", produces: "criterion-linked pass, repair, reopen, or fail findings" },
      { capability: "present", useWhen: "An answer region is already actionable", produces: "the user-facing answer" },
    ],
    region: { id: region.id, edge: region.edge, lod: region.lod, objective: region.objective, delivery: region.delivery, allowedVariables: region.allowedVariables, acceptanceCriteria: region.acceptanceCriteria, status: region.status },
    collapsedAncestry: lineage(state.network, region.id),
    domain: state.network.candidates.filter((item) => item.regionId === region.id).map(({ id, key, proposition, status, eliminationReasons, evidenceIds, nextLod }) => ({ id, key, proposition, status, eliminationReasons, evidenceIds, conditionalNextLod: nextLod })),
    evidence: state.network.evidence.filter((item) => refs.has(item.id)).map(({ id, text, source, kind }) => ({ id, text, source, kind })),
    constraints: state.network.constraints.filter((item) => refs.has(item.id) || item.subject === region.id || region.candidateIds.includes(item.subject) || region.candidateIds.includes(item.target)),
    artifacts: state.network.artifacts.filter((item) => refs.has(item.id)),
  };
}

function statusPaths(worktree: string): Map<string, string> {
  try {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const entries = raw.split("\0").filter(Boolean); const paths = new Map<string, string>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]; const status = entry.slice(0, 2); let file = entry.slice(3);
      if (status.includes("R") || status.includes("C")) file = entries[++index] ?? file;
      const absolute = path.join(worktree, file); let digest = "missing";
      try { const stat = fs.statSync(absolute); digest = stat.isFile() ? createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : "directory"; } catch {}
      paths.set(file, `${status}:${digest}`);
    }
    return paths;
  } catch { return new Map(); }
}

function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort();
}

function semantic(network: SolutionNetwork): SolutionSemanticSnapshot {
  return {
    kind: "solution-lod-v1", revision: network.revision,
    regions: network.regions.map((region) => ({ id: region.id, key: region.key, parentId: region.parentId, edge: region.edge, lod: region.lod, objective: region.objective, status: region.status, viable: region.candidateIds.filter((id) => network.candidates.find((candidate) => candidate.id === id)?.status !== "eliminated").length, total: region.candidateIds.length, selectedCandidateIds: region.selectedCandidateIds, candidateIds: region.candidateIds, constraintIds: region.constraintIds, evidenceIds: region.evidenceIds, activationIds: region.activationIds, artifactIds: region.artifactIds })),
    candidates: network.candidates.map(({ id, regionId, proposition, status, eliminationReasons, evidenceIds, nextLod }) => ({ id, regionId, proposition, status, eliminationReasons, evidenceIds, conditionalChildren: nextLod.map((item) => item.objective) })),
    constraints: network.constraints.map(({ id, kind, subject, target, reason }) => ({ id, kind, subject, target, reason })),
    evidence: network.evidence.map(({ id, text, source, kind }) => ({ id, text, source, kind })),
    activations: network.activations.map(({ id, capability, regionId, request, expectedDelta, senderActivationId, status, error }) => ({ id, capability, regionId, request, expectedDelta, senderActivationId, status, error })),
    artifacts: network.artifacts.map(({ id, regionId, kind, path, summary, passed, activationId }) => ({ id, regionId, kind, path, summary, passed, activationId })),
  };
}

function progress(state: SolutionLodState): GraphProgressSnapshot {
  return {
    phase: state.phase, activeNodeId: state.network.activations.find((item) => item.id === state.activeActivationId)?.regionId,
    callsUsed: state.callsUsed, summary: state.result || state.network.regions.find((item) => item.id === "r1")?.objective, usage: state.usage, semantic: semantic(state.network),
    nodes: state.network.regions.map((region) => ({ id: region.id, parentId: region.parentId, title: region.objective, level: `L${region.lod}`, depth: region.lod, status: region.status, evidence: region.evidenceIds.length, agents: region.activationIds.map((id) => state.network.activations.find((item) => item.id === id)?.capability).filter((item): item is Capability => Boolean(item)) })),
  };
}

function finalResult(state: SolutionLodState): string {
  const answers = state.network.regions.filter((item) => item.delivery === "answer" && item.answer).map((item) => item.answer!);
  if (answers.length) return answers.join("\n\n");
  const verified = state.network.regions.filter((item) => item.status === "verified" && item.delivery === "change");
  if (verified.length) {
    const files = [...new Set(verified.flatMap((region) => region.artifactIds).map((id) => state.network.artifacts.find((item) => item.id === id)).filter((item) => item?.kind === "file").map((item) => item!.path!))];
    return `Implemented and verified ${verified.length} solution region${verified.length === 1 ? "" : "s"}.${files.length ? `\n\nChanged files:\n${files.map((file) => `- ${file}`).join("\n")}` : ""}`;
  }
  return state.result;
}

export function solutionLodGraph(options: SolutionLodOptions): ConnectorGraph<SolutionLodState> {
  const limits = Object.fromEntries((Object.keys(DEFAULT_SOLUTION_ROLE_LIMITS) as Capability[]).map((role) => [role, { ...DEFAULT_SOLUTION_ROLE_LIMITS[role], ...(options.roleLimits?.[role] ?? {}) }])) as unknown as SolutionRoleLimits;
  const builder = new StateGraph(SolutionState)
    .addNode("schedule", (state: SolutionLodState) => {
      const scheduled = ensureRunnableWork(state.network);
      if (scheduled.done) return { network: scheduled.network, activeActivationId: undefined, phase: "completed", result: finalResult({ ...state, network: scheduled.network }) };
      if (scheduled.blocked) return { network: scheduled.network, activeActivationId: undefined, phase: "blocked", result: `The solution network is blocked: ${scheduled.blocked}` };
      const activation = nextQueuedActivation(scheduled.network); if (!activation) return { network: scheduled.network, phase: "blocked", result: "The solution network produced no runnable activation." };
      let network = markActivation(scheduled.network, activation.id, "running");
      if (activation.capability === "implement") network = setRegionStatus(network, activation.regionId, "implementing");
      return { network, activeActivationId: activation.id, phase: `${activation.capability}:${activation.regionId}` };
    })
    .addNode("acquire", async (_state: SolutionLodState, config?: RunnableConfig) => { const acquire = config?.configurable?.langgraphAcquireWorktree as (() => Promise<void>) | undefined; if (acquire) await acquire(); return { worktreeAcquired: true }; })
    .addNode("activate", async (state: SolutionLodState, config?: RunnableConfig) => {
      const activation = state.network.activations.find((item) => item.id === state.activeActivationId); if (!activation) throw new Error("Activate requires a selected activation");
      const snapshotWorkspace = config?.configurable?.langgraphSnapshotWorkspace as ((worktree: string) => Map<string, string>) | undefined;
      const snapshot = snapshotWorkspace ?? statusPaths;
      const before = activation.capability === "implement" ? snapshot(state.worktree) : undefined;
      try {
        const schema = activation.capability === "implement" ? ImplementationOutputSchema : activation.capability === "verify" ? VerificationOutputSchema : activation.capability === "present" ? PresentationOutputSchema : SolutionDeltaSchema;
        const result = await runtime(config).call({ agent: options.agents[activation.capability], node: `${activation.capability}:${activation.regionId}`, state, limits: limits[activation.capability], schema: z.toJSONSchema(schema) as Record<string, unknown>, validateStructured: (value) => schema.parse(value), prompt: JSON.stringify(projectActivationContext(state, activation)) });
        const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
        if (result.budgetStop) {
          const error = `Agent scheduling quantum reached: ${result.budgetStop.metric}`;
          const changedFiles = before ? changedBetween(before, snapshot(state.worktree)) : [];
          let network = markActivation(state.network, activation.id, "failed", result.sessionId, error);
          if (activation.capability === "implement" && changedFiles.length) {
            network = completeImplementation(network, activation.id, { status: "blocked", summary: error, changedFiles, checks: [], blocker: error, activations: [] }, changedFiles);
            network = markActivation(network, activation.id, "failed", result.sessionId, error);
          } else if (activation.capability === "implement") network = setRegionStatus(network, activation.regionId, "actionable");
          return { network, usage, callsUsed, activeActivationId: undefined, phase: "activation-deferred" };
        }
        let network: SolutionNetwork;
        if (activation.capability === "implement") network = completeImplementation(state.network, activation.id, structured(result, ImplementationOutputSchema), changedBetween(before!, snapshot(state.worktree)));
        else if (activation.capability === "verify") network = completeVerification(state.network, activation.id, structured(result, VerificationOutputSchema));
        else if (activation.capability === "present") network = completePresentation(state.network, activation.id, structured(result, PresentationOutputSchema).answer);
        else network = markActivation(mergeSolutionDelta(state, activation.id, structured(result, SolutionDeltaSchema)), activation.id, "completed", result.sessionId);
        return { network, usage, callsUsed, activeActivationId: undefined, phase: "propagating" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let network = markActivation(state.network, activation.id, "failed", activation.sessionId, message);
        if (activation.capability === "implement") {
          const changedFiles = changedBetween(before!, snapshot(state.worktree));
          if (changedFiles.length) {
            network = completeImplementation(network, activation.id, { status: "blocked", summary: `Implementation output failed but workspace mutation was retained: ${message}`, changedFiles, checks: [], blocker: message, activations: [] }, changedFiles);
            network = markActivation(network, activation.id, "failed", activation.sessionId, message);
          } else network = setRegionStatus(network, activation.regionId, "actionable");
        }
        return { network, callsUsed: state.callsUsed + 1, activeActivationId: undefined, phase: "activation-failed" };
      }
    })
    .addNode("finish", (state: SolutionLodState) => ({ result: state.result || finalResult(state) }))
    .addEdge(START, "schedule")
    .addConditionalEdges("schedule", (state: SolutionLodState) => state.result ? "finish" : state.network.activations.find((item) => item.id === state.activeActivationId)?.capability === "implement" && !state.worktreeAcquired ? "acquire" : "activate", { finish: "finish", acquire: "acquire", activate: "activate" })
    .addEdge("acquire", "activate")
    .addEdge("activate", "schedule")
    .addEdge("finish", END);
  return {
    graph: builder.compile({ checkpointer: options.checkpointer ?? defaultSolutionCheckpointer() }),
    initial: ({ task, conversationContext = "", directory, worktree, runId }) => ({ stateVersion: 3, runId, originalTask: task, conversationContext, directory, worktree, phase: "forming-root-domain", network: initialNetwork(task), usage: { ...EMPTY_USAGE }, callsUsed: 0, startedAt: Date.now(), worktreeAcquired: false, result: "" }),
    result: (state) => state.result,
    progress,
    display: { schedule: { phase: "collapse" }, acquire: { phase: "lease" }, activate: { phase: "activate" }, finish: { phase: "result" } },
  };
}
