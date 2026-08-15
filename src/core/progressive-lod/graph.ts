import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z, type ZodType } from "zod";
import { agentNode } from "../agent-node.js";
import { DurableFileSaver } from "../durable-checkpointer.js";
import type { AgentCallResult, AgentRuntime, AgentSessionDirective, AgentUsage, ConnectorGraph, GraphProgressSnapshot } from "../types.js";
import { applyDecision, applyVerification, budgetExceeded, mergeResearch, nextImplementationLeaf, reopenFailedPlan } from "./plan.js";
import {
  ClassificationSchema, DEFAULT_ROLE_LIMITS, DetailDecisionSchema, ImplementationResultSchema, ResearchSchema, SCOPE_BUDGETS, VerificationSchema,
  type DetailDecision, type ImplementationResult, type PendingBudget, type PlanNode, type ProgressiveLodState, type ProgressiveRoleLimits, type ResearchPacket, type ScopeBudget, type VerificationOutput,
} from "./types.js";

const ProgressiveState = Annotation.Root({
  stateVersion: Annotation<2>, runId: Annotation<string>, originalTask: Annotation<string>, directory: Annotation<string>, worktree: Annotation<string>, phase: Annotation<string>,
  profile: Annotation<ProgressiveLodState["profile"]>, budget: Annotation<ScopeBudget>, roleLimits: Annotation<ProgressiveRoleLimits>,
  plan: Annotation<PlanNode[]>, activeNodeId: Annotation<string | undefined>, activeLeafId: Annotation<string | undefined>,
  evidence: Annotation<ProgressiveLodState["evidence"]>, constraints: Annotation<ProgressiveLodState["constraints"]>, research: Annotation<ResearchPacket | undefined>, decision: Annotation<DetailDecision | undefined>,
  decisions: Annotation<Record<string, string>>, usage: Annotation<AgentUsage>, callsUsed: Annotation<number>, nextId: Annotation<number>, startedAt: Annotation<number>,
  deciderSessionId: Annotation<string | undefined>, implementationSessions: Annotation<Record<string, string>>, verifierSessionId: Annotation<string | undefined>,
  implementationResults: Annotation<Record<string, ImplementationResult>>, verification: Annotation<VerificationOutput | undefined>, repairAttempts: Annotation<number>,
  pendingBudget: Annotation<PendingBudget | undefined>, budgetGrants: Annotation<Record<string, number>>, resumeRole: Annotation<PendingBudget["role"] | undefined>,
  resumeFromAbortedSession: Annotation<boolean | undefined>,
  humanQuestion: Annotation<string>, humanAnswer: Annotation<string>, result: Annotation<string>,
});

const durableSavers = new Map<string, DurableFileSaver>();
export function defaultDurableCheckpointer(): DurableFileSaver {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const checkpointDirectory = path.join(stateBase, "opencode-langgraph", "checkpoints");
  fs.mkdirSync(checkpointDirectory, { recursive: true });
  const existing = durableSavers.get(checkpointDirectory);
  if (existing) return existing;
  const saver = new DurableFileSaver(checkpointDirectory); durableSavers.set(checkpointDirectory, saver); return saver;
}

export interface ProgressiveLodOptions {
  classifierAgent?: string;
  scoutAgent: string;
  deciderAgent: string;
  implementerAgent: string;
  repairAgent?: string;
  verifierAgent?: string;
  answerAgent?: string;
  roleLimits?: Partial<ProgressiveRoleLimits>;
  budgets?: Partial<Record<"local" | "subsystem" | "architectural" | "unknown", Partial<ScopeBudget>>>;
  checkpointer?: BaseCheckpointSaver;
}

const EMPTY_USAGE: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
function addUsage(left: AgentUsage, right: AgentUsage | undefined): AgentUsage {
  const value = right ?? EMPTY_USAGE;
  return { turns: left.turns + value.turns, input: left.input + value.input, output: left.output + value.output, reasoning: left.reasoning + value.reasoning, cacheRead: left.cacheRead + value.cacheRead, cacheWrite: left.cacheWrite + value.cacheWrite, cost: left.cost + value.cost };
}

function runtime(config?: RunnableConfig): AgentRuntime {
  const value = config?.configurable?.langgraphOpenCodeRuntime as AgentRuntime | undefined;
  if (!value) throw new Error("Progressive LOD node was invoked without an OpenCode runtime");
  return value;
}

function structured<Output>(result: AgentCallResult, schema: ZodType<Output>, node: string): Output {
  let value = result.structured;
  if (value === undefined) {
    const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    try { value = JSON.parse((fenced ?? result.text).trim()); } catch { throw new Error(`${node} returned invalid JSON`); }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${node} returned invalid structured output: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function relevantNodeIds(state: ProgressiveLodState, nodeId = state.activeNodeId): Set<string> {
  const byId = new Map(state.plan.map((node) => [node.id, node]));
  const ids = new Set<string>();
  let cursor = nodeId ? byId.get(nodeId) : undefined;
  while (cursor) { ids.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
  const visit = (id: string) => { if (ids.has(id)) return; ids.add(id); for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency); };
  for (const dependency of (nodeId ? byId.get(nodeId)?.dependencies : []) ?? []) visit(dependency);
  return ids;
}

function lineageNodeIds(state: ProgressiveLodState, nodeId = state.activeNodeId): Set<string> {
  const byId = new Map(state.plan.map((node) => [node.id, node]));
  const ids = new Set<string>();
  let cursor = nodeId ? byId.get(nodeId) : undefined;
  while (cursor) { ids.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
  return ids;
}

export function branchProjection(state: ProgressiveLodState): Record<string, unknown> {
  const ids = lineageNodeIds(state);
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  const dependencyIds = new Set(active?.dependencies ?? []);
  const evidenceIds = new Set(state.plan.filter((node) => ids.has(node.id) || dependencyIds.has(node.id)).flatMap((node) => node.evidenceIds));
  return {
    task: state.originalTask, profile: state.profile, humanAnswer: state.humanAnswer || undefined,
    branch: state.plan.filter((node) => ids.has(node.id)).map(({ scoutSessionId: _session, scoutSessionMode: _mode, scoutTurns: _turns, ...node }) => node),
    evidence: state.evidence.filter((item) => evidenceIds.has(item.id)), constraints: state.constraints,
    decisions: Object.fromEntries(Object.entries(state.decisions).filter(([id]) => ids.has(id))),
    dependencies: state.plan.filter((node) => dependencyIds.has(node.id)).map(({ id, title, status, evidenceIds: nodeEvidenceIds }) => ({ id, title, status, evidenceIds: nodeEvidenceIds, result: state.implementationResults[id]?.summary })),
    unrelated: state.plan.filter((node) => !ids.has(node.id) && !dependencyIds.has(node.id)).map(({ id, parentId, title, status }) => ({ id, parentId, title, status })),
  };
}

function leafPayload(state: ProgressiveLodState, node: PlanNode): Record<string, unknown> {
  const ids = relevantNodeIds(state, node.id);
  const evidenceIds = new Set(state.plan.filter((candidate) => ids.has(candidate.id)).flatMap((candidate) => candidate.evidenceIds));
  return {
    task: state.originalTask, leaf: node, constraints: state.constraints,
    evidence: state.evidence.filter((item) => evidenceIds.has(item.id)),
    ancestorDecisions: Object.fromEntries(Object.entries(state.decisions).filter(([id]) => ids.has(id))),
    dependencies: node.dependencies.map((id) => ({ id, result: state.implementationResults[id] })).filter((item) => item.result),
  };
}

function sessionDirective(sessionId: string | undefined, strategy: AgentSessionDirective["strategy"] | undefined, turns = 0): AgentSessionDirective {
  if (!sessionId || turns >= 16) return { strategy: "fresh" };
  return { strategy: strategy ?? "continue", sessionId };
}

function resumableSession(sessionId: string | undefined, resumeFromAbortedSession: boolean | undefined): AgentSessionDirective {
  if (!sessionId) return { strategy: "fresh" };
  return { strategy: resumeFromAbortedSession ? "fork" : "continue", sessionId };
}

function groundedResearch(raw: z.infer<typeof ResearchSchema>, result: AgentCallResult): z.infer<typeof ResearchSchema> {
  const trace = JSON.stringify((result.tools ?? []).map(({ title, input }) => ({ title, input })));
  return { ...raw, evidence: raw.evidence.map((item) => item.kind !== "inference" && !trace.includes(item.source.split(":")[0]) ? { ...item, kind: "inference" as const, confidence: Math.min(item.confidence, .7) } : item) };
}

function globalStop(state: ProgressiveLodState): PendingBudget["stop"] {
  const multiplier = (state.budgetGrants.global ?? 0) + 1;
  const checks: Array<[PendingBudget["stop"]["metric"], number, number]> = [
    ["calls", state.callsUsed, state.budget.calls * multiplier],
    ["turns", state.usage.turns, state.budget.maxTurns * multiplier], ["input", state.usage.input, state.budget.maxInputTokens * multiplier],
    ["cacheRead", state.usage.cacheRead, state.budget.maxCacheReadTokens * multiplier], ["cost", state.usage.cost, state.budget.maxCost * multiplier],
    ["minutes", (Date.now() - state.startedAt) / 60_000, state.budget.minutes * multiplier],
  ];
  const hit = checks.find(([, used, limit]) => used >= limit) ?? checks[0];
  return { kind: "budget", metric: hit[0], used: hit[1], limit: hit[2] };
}

function progress(state: ProgressiveLodState): GraphProgressSnapshot {
  return {
    phase: state.phase, scope: state.profile?.scope, activeNodeId: state.activeNodeId ?? state.activeLeafId, callsUsed: state.callsUsed, callBudget: state.budget.calls,
    summary: state.verification?.summary ?? state.research?.summary ?? state.profile?.summary, usage: state.usage,
    nodes: state.plan.map((node) => ({ id: node.id, parentId: node.parentId, title: node.title, level: node.level, depth: node.depth, status: node.status, dependencies: node.dependencies, evidence: node.evidenceIds.length, confidence: node.confidence })),
  };
}

export function progressiveLodGraph(options: ProgressiveLodOptions): ConnectorGraph<ProgressiveLodState> {
  const classifier = options.classifierAgent ?? options.scoutAgent;
  const verifier = options.verifierAgent ?? options.deciderAgent;
  const answer = options.answerAgent ?? options.scoutAgent;
  const roleLimits = Object.fromEntries((Object.keys(DEFAULT_ROLE_LIMITS) as Array<keyof ProgressiveRoleLimits>).map((role) => [role, { ...DEFAULT_ROLE_LIMITS[role], ...(options.roleLimits?.[role] ?? {}) }])) as unknown as ProgressiveRoleLimits;
  const repairAgent = options.repairAgent ?? options.implementerAgent;
  const budgets = Object.fromEntries(Object.entries(SCOPE_BUDGETS).map(([scope, budget]) => [scope, { ...budget, ...(options.budgets?.[scope as keyof typeof SCOPE_BUDGETS] ?? {}) }])) as typeof SCOPE_BUDGETS;

  const builder = new StateGraph(ProgressiveState)
    .addNode("classify", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const result = await runtime(config).call({ agent: classifier, node: "classify", state, limits: state.roleLimits.classifier, schema: z.toJSONSchema(ClassificationSchema) as Record<string, unknown>, prompt: `Task type: routing classification only. Do not solve, inspect, or plan. route=answer only for a read-only response; route=change when files or external state must change. Return the task-specific planning frame.\n\n${state.originalTask}` });
      if (result.budgetStop) throw new Error(`Classifier exceeded ${result.budgetStop.metric} budget`);
      const profile = structured(result, ClassificationSchema, "classify");
      return { profile, budget: budgets[profile.scope], phase: "classified", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result.usage) };
    })
    .addNode("answer", agentNode<ProgressiveLodState>({ node: "answer", agent: answer, prompt: (state) => `Task type: direct read-only answer. Answer accurately and do not mutate state.\n\n${state.originalTask}`, output: (text, state, result) => ({ result: text, phase: "completed", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result.usage) }) }))
    .addNode("acquire", async (_state: ProgressiveLodState, config?: RunnableConfig) => { const acquire = config?.configurable?.langgraphAcquireWorktree as (() => Promise<void>) | undefined; if (acquire) await acquire(); return {}; })
    .addNode("initialize", (state: ProgressiveLodState) => ({
      phase: "scouting", activeNodeId: "p1", nextId: 2, resumeRole: "scout" as const,
      plan: [{ id: "p1", title: state.profile?.summary ?? state.originalTask, description: state.originalTask, level: state.profile?.planningFrame ?? "task outcome", depth: 0, status: "active" as const, dependencies: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0, scoutSessionMode: "fresh" as const, scoutTurns: 0 }],
    }))
    .addNode("guard", (state: ProgressiveLodState) => budgetExceeded(state) ? { pendingBudget: { scope: "global" as const, role: state.resumeRole ?? "scout", nodeId: state.activeNodeId ?? state.activeLeafId, stop: globalStop(state) }, phase: "budget-paused" } : {})
    .addNode("scout", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const active = state.plan.find((node) => node.id === state.activeNodeId); if (!active) throw new Error("Scout requires an active branch");
      const result = await runtime(config).call({
        agent: options.scoutAgent, node: `scout:${active.id}`, state, limits: state.roleLimits.scout,
        session: state.resumeFromAbortedSession
          ? resumableSession(active.scoutSessionId, true)
          : sessionDirective(active.scoutSessionId, active.scoutSessionMode, active.scoutTurns), schema: z.toJSONSchema(ResearchSchema) as Record<string, unknown>,
        prompt: `Task type: branch-scoped repository scouting. Inspect only facts still missing for this active concern. Do not design the solution, decompose other branches, edit files, or run tests. Return at most 12 cited facts and short excerpts.\n\n${JSON.stringify(branchProjection(state))}`,
      });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      const plan = state.plan.map((node) => node.id === active.id ? { ...node, scoutSessionId: result.sessionId, scoutSessionMode: "continue" as const, scoutTurns: (node.scoutTurns ?? 0) + (result.usage?.turns ?? 0) } : node);
      if (result.budgetStop) return { plan, usage, callsUsed, resumeFromAbortedSession: false, pendingBudget: { scope: "call" as const, role: "scout" as const, nodeId: active.id, stop: result.budgetStop, sessionId: result.sessionId }, resumeRole: "scout" as const, phase: "budget-paused" };
      const merged = mergeResearch({ ...state, plan }, groundedResearch(structured(result, ResearchSchema, "scout"), result));
      return { ...merged, plan, usage, callsUsed, resumeFromAbortedSession: false, resumeRole: "decider" as const, phase: "deciding" };
    })
    .addNode("decide", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const active = state.plan.find((node) => node.id === state.activeNodeId); if (!active) throw new Error("Decider requires an active branch");
      const result = await runtime(config).call({
        agent: options.deciderAgent, node: `decide:${active.id}`, state, limits: state.roleLimits.decider,
        session: resumableSession(state.deciderSessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(DetailDecisionSchema) as Record<string, unknown>,
        prompt: `Task type: one tool-free LOD decision. Use only the supplied typed evidence. Choose exactly one disposition. split creates pending concerns only; it cannot create implementation leaves. ready applies only to the active concern and requires bounded targets, acceptance criteria, and verification. Alternatives are short decision summaries, never duplicate plans.\n\n${JSON.stringify({ projection: branchProjection(state), research: state.research })}`,
      });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      if (result.budgetStop) return { usage, callsUsed, deciderSessionId: result.sessionId, resumeFromAbortedSession: false, pendingBudget: { scope: "call" as const, role: "decider" as const, nodeId: active.id, stop: result.budgetStop, sessionId: result.sessionId }, resumeRole: "decider" as const, phase: "budget-paused" };
      return { decision: structured(result, DetailDecisionSchema, "decide"), deciderSessionId: undefined, resumeFromAbortedSession: false, usage, callsUsed, phase: "merging" };
    })
    .addNode("merge", (state: ProgressiveLodState) => {
      if (!state.decision) throw new Error("Merge requires a detail decision");
      const merged = applyDecision(state, state.decision);
      return { ...merged, decision: undefined, research: undefined, humanQuestion: merged.humanQuestion, resumeRole: merged.activeNodeId ? "scout" as const : "implementer" as const, phase: merged.humanQuestion ? "waiting-human" : merged.activeNodeId ? "scouting" : "selecting-leaf" };
    })
    .addNode("human", (state: ProgressiveLodState) => {
      const response = interrupt({ kind: "decision", question: state.humanQuestion, activeNodeId: state.activeNodeId, plan: progress(state) });
      const answer = typeof response === "string" ? response : JSON.stringify(response);
      return { humanAnswer: answer, humanQuestion: "", constraints: [...state.constraints, { id: `c${state.constraints.length + 1}`, text: `User decision: ${answer}`, source: "user" }], resumeRole: "decider" as const, phase: "deciding" };
    })
    .addNode("budget_interrupt", (state: ProgressiveLodState) => {
      const pending = state.pendingBudget; if (!pending) throw new Error("Budget interrupt requires a pending budget");
      const response = interrupt({ kind: "budget", role: pending.role, nodeId: pending.nodeId, metric: pending.stop.metric, used: pending.stop.used, limit: pending.stop.limit, choices: ["continue", "narrow: …", "stop"] });
      const answer = String(response).trim();
      if (answer.toLowerCase() === "stop") return { pendingBudget: undefined, resumeRole: undefined, phase: "failed", result: `Stopped at the ${pending.role} ${pending.stop.metric} budget (${pending.stop.used}/${pending.stop.limit}).` };
      const constraints = answer.toLowerCase().startsWith("narrow:") ? [...state.constraints, { id: `c${state.constraints.length + 1}`, text: answer.slice(7).trim(), source: "user budget decision" }] : state.constraints;
      const budgetGrants = pending.scope === "global" ? { ...state.budgetGrants, global: (state.budgetGrants.global ?? 0) + 1 } : state.budgetGrants;
      return { pendingBudget: undefined, budgetGrants, constraints, resumeFromAbortedSession: pending.scope === "call" || state.resumeFromAbortedSession, resumeRole: pending.role, phase: `resuming-${pending.role}` };
    })
    .addNode("select_leaf", (state: ProgressiveLodState) => {
      const leaf = nextImplementationLeaf(state.plan);
      if (leaf) return { activeLeafId: leaf.id, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: "implementing" as const } : node), resumeRole: "implementer" as const, phase: "implementing" };
      if (state.plan.some((node) => node.status === "implemented")) return { activeLeafId: undefined, resumeRole: "verifier" as const, phase: "verifying" };
      return { activeLeafId: undefined, resumeRole: undefined, phase: "failed", result: "Planning ended without an implementable leaf." };
    })
    .addNode("implement", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const leaf = state.plan.find((node) => node.id === state.activeLeafId); if (!leaf?.leaf) throw new Error("Implementation requires one grounded leaf");
      const existing = state.implementationSessions[leaf.id];
      const result = await runtime(config).call({ agent: options.implementerAgent, node: `implement:${leaf.id}`, state, limits: state.roleLimits.implementer, session: resumableSession(existing, state.resumeFromAbortedSession), schema: z.toJSONSchema(ImplementationResultSchema) as Record<string, unknown>, prompt: `Task type: one cohesive implementation leaf. Implement only this leaf, preserve unrelated work, run its checks, and return structured changed-file/check artifacts. If prerequisites are omitted, return status=blocked and name the missing scope; do not redesign it.\n\n${JSON.stringify(leafPayload(state, leaf))}` });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1; const sessions = { ...state.implementationSessions, [leaf.id]: result.sessionId ?? existing };
      if (result.budgetStop) return { usage, callsUsed, implementationSessions: sessions, resumeFromAbortedSession: false, pendingBudget: { scope: "call" as const, role: "implementer" as const, nodeId: leaf.id, stop: result.budgetStop, sessionId: result.sessionId }, resumeRole: "implementer" as const, phase: "budget-paused" };
      const output = structured(result, ImplementationResultSchema, "implement");
      return { usage, callsUsed, implementationSessions: sessions, implementationResults: { ...state.implementationResults, [leaf.id]: output }, resumeFromAbortedSession: false, activeLeafId: undefined, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: output.status === "completed" ? "implemented" as const : "failed" as const } : node), phase: output.status === "completed" ? "selecting-leaf" : "implementation-blocked" };
    })
    .addNode("reopen_blocker", (state: ProgressiveLodState) => {
      const failed = state.plan.filter((node) => node.status === "failed").map((node) => node.id); const reopened = reopenFailedPlan(state.plan, failed, state.budget.reopens);
      return { plan: reopened.plan, activeNodeId: reopened.activeNodeId, activeLeafId: undefined, resumeRole: reopened.activeNodeId ? "scout" as const : undefined, phase: reopened.activeNodeId ? "scouting" : "failed", research: undefined, decision: undefined };
    })
    .addNode("verify", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const result = await runtime(config).call({ agent: verifier, node: "verify", state, limits: state.roleLimits.verifier, session: resumableSession(state.verifierSessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(VerificationSchema) as Record<string, unknown>, prompt: `Task type: one aggregate independent verification. Inspect the actual worktree and diff. Check every implemented leaf against its contract and artifacts. Do not edit files. failedNodeIds must be exact plan IDs.\n\n${JSON.stringify({ task: state.originalTask, constraints: state.constraints, leaves: state.plan.filter((node) => node.leaf).map((node) => ({ node, result: state.implementationResults[node.id] })) })}` });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      if (result.budgetStop) return { usage, callsUsed, verifierSessionId: result.sessionId, resumeFromAbortedSession: false, pendingBudget: { scope: "call" as const, role: "verifier" as const, stop: result.budgetStop, sessionId: result.sessionId }, resumeRole: "verifier" as const, phase: "budget-paused" };
      const verification = structured(result, VerificationSchema, "verify");
      return { usage, callsUsed, verifierSessionId: result.sessionId, resumeFromAbortedSession: false, verification, plan: applyVerification(state.plan, verification), phase: verification.passed ? "completed" : "verification-failed" };
    })
    .addNode("select_repair", (state: ProgressiveLodState) => {
      const leaf = state.plan.filter((node) => node.status === "failed").sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
      if (!leaf) return { activeLeafId: undefined, verifierSessionId: undefined, resumeRole: "verifier" as const, phase: "verifying" };
      return { activeLeafId: leaf.id, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: "implementing" as const } : node), resumeRole: "repair" as const, phase: "repairing" };
    })
    .addNode("repair", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const leaf = state.plan.find((node) => node.id === state.activeLeafId); if (!leaf?.leaf) throw new Error("Repair requires one failed leaf");
      const sessionId = state.implementationSessions[leaf.id]; if (!sessionId) throw new Error(`Repair has no implementation session for ${leaf.id}`);
      const result = await runtime(config).call({ agent: repairAgent, node: `repair:${leaf.id}`, state, limits: state.roleLimits.repair, session: resumableSession(sessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(ImplementationResultSchema) as Record<string, unknown>, prompt: `Task type: bounded repair of the same cohesive leaf. Address only the verifier findings for this leaf and rerun focused checks. Return structured artifacts.\n\n${JSON.stringify({ leaf: leafPayload(state, leaf), prior: state.implementationResults[leaf.id], verification: state.verification })}` });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      const sessions = { ...state.implementationSessions, [leaf.id]: result.sessionId ?? sessionId };
      if (result.budgetStop) return { usage, callsUsed, implementationSessions: sessions, resumeFromAbortedSession: false, pendingBudget: { scope: "call" as const, role: "repair" as const, nodeId: leaf.id, stop: result.budgetStop, sessionId: result.sessionId }, resumeRole: "repair" as const, phase: "budget-paused" };
      const output = structured(result, ImplementationResultSchema, "repair");
      return { usage, callsUsed, implementationSessions: sessions, resumeFromAbortedSession: false, repairAttempts: state.repairAttempts + 1, implementationResults: { ...state.implementationResults, [leaf.id]: output }, activeLeafId: undefined, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: output.status === "completed" ? "implemented" as const : "failed" as const } : node), phase: output.status === "completed" ? "selecting-repair" : "implementation-blocked" };
    })
    .addNode("reopen", (state: ProgressiveLodState) => {
      const reopened = reopenFailedPlan(state.plan, state.verification?.failedNodeIds ?? [], state.budget.reopens);
      return { plan: reopened.plan, activeNodeId: reopened.activeNodeId, verifierSessionId: undefined, verification: undefined, research: undefined, decision: undefined, resumeRole: reopened.activeNodeId ? "scout" as const : undefined, phase: reopened.activeNodeId ? "scouting" : "failed" };
    })
    .addNode("finish", (state: ProgressiveLodState) => {
      if (state.result) return {};
      const summaries = Object.entries(state.implementationResults).map(([id, item]) => `${id}: ${item.summary}`).join("\n");
      return { phase: state.verification?.passed ? "completed" : "failed", result: state.verification?.passed ? `${summaries}\n\nVerification: ${state.verification.summary}` : `The graph did not reach verified success.\n\n${state.verification?.summary ?? (summaries || "No implementation completed.")}` };
    })
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state: ProgressiveLodState) => state.profile?.route ?? "answer", { answer: "answer", change: "acquire" })
    .addEdge("answer", END)
    .addConditionalEdges("acquire", (state: ProgressiveLodState) => state.plan.length ? "guard" : "initialize", { guard: "guard", initialize: "initialize" })
    .addEdge("initialize", "guard")
    .addConditionalEdges("guard", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : state.resumeRole ?? "scout", { budget: "budget_interrupt", scout: "scout", decider: "decide", implementer: "implement", verifier: "verify", repair: "repair" })
    .addConditionalEdges("scout", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : "guard", { budget: "budget_interrupt", guard: "guard" })
    .addConditionalEdges("decide", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : "merge", { budget: "budget_interrupt", merge: "merge" })
    .addConditionalEdges("merge", (state: ProgressiveLodState) => state.humanQuestion ? "human" : state.activeNodeId ? "guard" : "select", { human: "human", guard: "guard", select: "select_leaf" })
    .addEdge("human", "acquire")
    .addConditionalEdges("budget_interrupt", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : "acquire", { finish: "finish", acquire: "acquire" })
    .addConditionalEdges("select_leaf", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : "guard", { finish: "finish", guard: "guard" })
    .addConditionalEdges("implement", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : state.phase === "implementation-blocked" ? "reopen" : "select", { budget: "budget_interrupt", reopen: "reopen_blocker", select: "select_leaf" })
    .addConditionalEdges("reopen_blocker", (state: ProgressiveLodState) => state.activeNodeId ? "guard" : "finish", { guard: "guard", finish: "finish" })
    .addConditionalEdges("verify", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : state.verification?.passed ? "finish" : state.verification?.architecturalMismatch ? "reopen" : state.verification?.repairable && state.repairAttempts < state.budget.repairs ? "repair" : "finish", { budget: "budget_interrupt", finish: "finish", reopen: "reopen", repair: "select_repair" })
    .addConditionalEdges("select_repair", (state: ProgressiveLodState) => state.resumeRole === "repair" ? "guard" : "guard", { guard: "guard" })
    .addConditionalEdges("repair", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : state.phase === "implementation-blocked" ? "reopen" : "next", { budget: "budget_interrupt", reopen: "reopen_blocker", next: "select_repair" })
    .addConditionalEdges("reopen", (state: ProgressiveLodState) => state.activeNodeId ? "guard" : "finish", { guard: "guard", finish: "finish" })
    .addEdge("finish", END);

  return {
    graph: builder.compile({ checkpointer: options.checkpointer ?? defaultDurableCheckpointer() }),
    initial: ({ task, directory, worktree, runId }) => ({ stateVersion: 2, runId, originalTask: task, directory, worktree, phase: "classifying", budget: budgets.unknown, roleLimits, plan: [], evidence: [], constraints: [], decisions: {}, usage: { ...EMPTY_USAGE }, callsUsed: 0, nextId: 1, startedAt: Date.now(), implementationSessions: {}, implementationResults: {}, repairAttempts: 0, budgetGrants: {}, humanQuestion: "", humanAnswer: "", result: "" }),
    result: (state) => state.result,
    progress,
    display: { classify: { phase: "route", agent: classifier }, scout: { phase: "ground", agent: options.scoutAgent }, decide: { phase: "detail", agent: options.deciderAgent }, merge: { phase: "reduce" }, budget_interrupt: { phase: "budget" }, implement: { phase: "leaf", agent: options.implementerAgent }, verify: { phase: "verify", agent: verifier }, repair: { phase: "repair", agent: repairAgent } },
  };
}
