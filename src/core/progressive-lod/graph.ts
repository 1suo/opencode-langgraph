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
import { applyDecision, applyVerification, mergeResearch, nextImplementationLeaf, reopenFailedPlan } from "./plan.js";
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
  verifierWorkspace: Annotation<string | undefined>,
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

function compactDecisionQuestion(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const firstQuestion = normalized.includes("?") ? normalized.slice(0, normalized.indexOf("?") + 1) : normalized;
  if (firstQuestion.length <= 320) return firstQuestion;
  const clipped = firstQuestion.slice(0, 320);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > 200 ? boundary : 319).replace(/[,:;\s]+$/, "")}?`;
}

export function normalizeDetailDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const decision = value as Record<string, unknown>;
  const normalizeChild = (child: unknown) => child && typeof child === "object"
    ? { ...(child as Record<string, unknown>), ...typeof (child as Record<string, unknown>).question === "string" ? { question: compactDecisionQuestion((child as Record<string, string>).question) } : {} }
    : child;
  if (decision.disposition === "refine") return { ...decision, child: normalizeChild(decision.child) };
  if (decision.disposition === "split" && Array.isArray(decision.children)) return { ...decision, children: decision.children.map(normalizeChild) };
  return value;
}

function parseDetailDecision(value: unknown, state: ProgressiveLodState): DetailDecision {
  const parsed = DetailDecisionSchema.parse(normalizeDetailDecision(value));
  if (parsed.disposition === "refine" || parsed.disposition === "split") {
    const forbidden = lineageNodeIds(state);
    const children = parsed.disposition === "refine" ? [parsed.child] : parsed.children;
    if (children.some((child) => child.dependencies.some((dependency) => forbidden.has(dependency)))) throw new Error("Detail decision child cannot depend on itself or an ancestor concern");
  }
  return parsed;
}

function lineageNodeIds(state: ProgressiveLodState, nodeId = state.activeNodeId): Set<string> {
  const byId = new Map(state.plan.map((node) => [node.id, node]));
  const ids = new Set<string>();
  let cursor = nodeId ? byId.get(nodeId) : undefined;
  while (cursor) { ids.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
  return ids;
}

function relevantNodeIds(state: ProgressiveLodState): Set<string> {
  const ids = lineageNodeIds(state);
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  for (const id of active?.dependencies ?? []) { ids.add(id); for (const leaf of dependencyLeaves(state, id)) ids.add(leaf.id); }
  return ids;
}

function dependencyLeaves(state: ProgressiveLodState, id: string, seen = new Set<string>()): PlanNode[] {
  if (seen.has(id)) return [];
  const node = state.plan.find((item) => item.id === id);
  if (!node || node.status === "removed") return [];
  if (node.status !== "expanded") return node.leaf ? [node] : [];
  return state.plan.filter((item) => item.parentId === id && item.status !== "removed").flatMap((child) => dependencyLeaves(state, child.id, new Set([...seen, id])));
}

export function branchProjection(state: ProgressiveLodState): Record<string, unknown> {
  const ids = relevantNodeIds(state);
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  const dependencyIds = new Set(active?.dependencies ?? []);
  const evidenceIds = new Set(state.plan.filter((node) => ids.has(node.id) || dependencyIds.has(node.id)).flatMap((node) => node.evidenceIds));
  for (const item of state.research?.evidence ?? []) evidenceIds.add(item.id);
  const currentEvidence = new Set(state.research?.evidence.map((item) => item.id) ?? []);
  const facts = state.evidence.filter((item) => evidenceIds.has(item.id)).sort((left, right) => {
    const current = Number(currentEvidence.has(right.id)) - Number(currentEvidence.has(left.id));
    const grounded = Number(right.kind === "repository") - Number(left.kind === "repository");
    return current || grounded || Number(right.id.slice(1)) - Number(left.id.slice(1));
  }).slice(0, 12);
  const constraints = state.constraints.filter((item) => !item.nodeId || ids.has(item.nodeId)).sort((left, right) => {
    const user = Number(right.source === "user") - Number(left.source === "user");
    const activeScope = Number(right.nodeId === active?.id) - Number(left.nodeId === active?.id);
    return user || activeScope || Number(right.id.slice(1)) - Number(left.id.slice(1));
  }).filter((item, index, items) => items.findIndex((candidate) => candidate.text.trim().replace(/\s+/g, " ") === item.text.trim().replace(/\s+/g, " ")) === index).slice(0, 12);
  return {
    task: state.originalTask,
    concern: active ? { id: active.id, title: active.title, questions: active.depth === 0 && state.profile?.questions?.length ? state.profile.questions : [active.description] } : undefined,
    ancestry: state.plan.filter((node) => lineageNodeIds(state).has(node.id) && node.id !== active?.id).map(({ id, title }) => ({ id, title })),
    facts: facts.map(({ id, claim, source, kind, confidence }) => ({ id, text: claim, source, kind, confidence })),
    unknowns: state.research?.unknowns ?? [],
    constraints: constraints.map(({ text, source }) => ({ text, source })),
    issues: state.plan.filter((node) => ids.has(node.id)).flatMap((node) => node.replanIssues ?? []).slice(-4),
    dependencies: state.plan.filter((node) => dependencyIds.has(node.id)).map(({ id, title, status }) => ({ id, title, status, leaves: dependencyLeaves(state, id).map((leaf) => ({ id: leaf.id, title: leaf.title, contract: leaf.leaf, result: state.implementationResults[leaf.id]?.summary })) })),
    siblings: state.plan.filter((node) => node.parentId === active?.parentId && node.id !== active?.id).map(({ id, title, status }) => ({ id, title, status })),
    humanAnswer: state.humanAnswer || undefined,
  };
}

function leafPayload(state: ProgressiveLodState, node: PlanNode): Record<string, unknown> {
  const ids = lineageNodeIds(state, node.id);
  for (const id of node.dependencies) { ids.add(id); for (const leaf of dependencyLeaves(state, id)) ids.add(leaf.id); }
  const evidenceIds = new Set(state.plan.filter((item) => ids.has(item.id)).flatMap((item) => item.evidenceIds));
  return {
    task: state.originalTask, leafId: node.id, contract: node.leaf,
    grounding: state.evidence.filter((item) => evidenceIds.has(item.id) && item.kind === "repository").slice(-8).reverse().map(({ claim, source }) => ({ text: claim, source, kind: "repository" })),
    issues: state.plan.filter((item) => ids.has(item.id)).flatMap((item) => item.replanIssues ?? []).slice(-4),
    constraints: state.constraints.filter((item) => !item.nodeId || ids.has(item.nodeId)).slice(-12).map(({ text }) => text),
    dependencies: node.dependencies.map((id) => { const dependency = state.plan.find((item) => item.id === id); return { id, title: dependency?.title, leaves: dependencyLeaves(state, id).map((leaf) => { const result = state.implementationResults[leaf.id]; return { id: leaf.id, title: leaf.title, contract: leaf.leaf, artifacts: result ? { changedFiles: result.changedFiles, checks: result.checks } : undefined }; }) }; }),
  };
}

function sessionDirective(sessionId: string | undefined, strategy: AgentSessionDirective["strategy"] | undefined, turns = 0): AgentSessionDirective {
  if (!sessionId || turns >= 32) return { strategy: "fresh" };
  return { strategy: strategy ?? "continue", sessionId };
}

function resumableSession(sessionId: string | undefined, resumeFromAbortedSession: boolean | undefined): AgentSessionDirective {
  if (!sessionId) return { strategy: "fresh" };
  return { strategy: resumeFromAbortedSession ? "fork" : "continue", sessionId };
}

function groundedResearch(raw: z.infer<typeof ResearchSchema>, result: AgentCallResult) {
  const inspected = (result.tools ?? []).flatMap(({ title, input }) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return [title, record.filePath, record.path].filter((value): value is string => typeof value === "string").map((value) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""));
  });
  return { unknowns: raw.unknowns, constraints: raw.constraints, evidence: raw.facts.map((item) => {
    const sources = item.source.split(/\s*;\s*/).map((source) => source.replaceAll("\\", "/").replace(/:\d+(?::\d+)?(?:-\d+)?$/, "").replace(/^\.\//, "")).filter(Boolean);
    const grounded = sources.length > 0 && sources.every((source) => inspected.some((value) => value === source || value.endsWith(`/${source}`) || source.startsWith(`${value}/`)));
    return { claim: item.text, source: item.source, excerpt: "", kind: grounded ? "repository" as const : "inference" as const, confidence: grounded ? 1 : .6 };
  }) };
}

function withoutKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const removed = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !removed.has(key)));
}

function isolatedPayload(value: unknown, state: ProgressiveLodState): string {
  const roots = [...new Set([path.resolve(state.worktree), path.resolve(state.directory)])].filter((root) => root !== path.parse(root).root).sort((left, right) => right.length - left.length);
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") return roots.reduce((text, root) => text.replaceAll(root, ".").replaceAll(root.replaceAll("\\", "/"), "."), item);
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  return JSON.stringify(scrub(value));
}

function withReplanIssues(plan: PlanNode[], nodeIds: string[], issues: PlanNode["replanIssues"]): PlanNode[] {
  const targets = new Set(nodeIds);
  return plan.map((node) => targets.has(node.id) ? { ...node, replanIssues: [...(node.replanIssues ?? []), ...(issues ?? [])] } : node);
}

function implementationResult(raw: z.infer<typeof ImplementationResultSchema>): ImplementationResult {
  const passed = raw.checks.filter((check) => check.passed).length;
  const summary = raw.status === "blocked" ? `Blocked: ${raw.blocker ?? "missing prerequisite"}` : `Changed ${raw.changedFiles.length} file${raw.changedFiles.length === 1 ? "" : "s"}; ${passed}/${raw.checks.length} reported checks passed.`;
  return { ...raw, blocker: raw.blocker ?? "", summary };
}

function madeMutation(result: AgentCallResult): boolean {
  return (result.tools ?? []).some((trace) => ["edit", "write", "apply_patch"].includes(trace.tool));
}

function verificationResult(raw: z.infer<typeof VerificationSchema>, leafCount: number): VerificationOutput {
  if (raw.verdict === "pass") return { passed: true, summary: `Verified ${leafCount} implementation ${leafCount === 1 ? "leaf" : "leaves"}.`, checks: raw.checks, failedNodeIds: [], repairable: false, architecturalMismatch: false };
  const checks = raw.findings.map((finding) => ({ name: finding.leafId, passed: false, evidence: `${finding.problem}${finding.evidence ? ` — ${finding.evidence}` : ""}` }));
  return { passed: false, summary: raw.findings.map((finding) => `${finding.leafId}: ${finding.problem}`).join("; "), checks, failedNodeIds: [...new Set(raw.findings.map((finding) => finding.leafId))], repairable: raw.verdict === "repair", architecturalMismatch: raw.verdict === "replan" };
}

function callGrantKey(role: PendingBudget["role"], nodeId?: string): string {
  return `call:${role}${nodeId ? `:${nodeId}` : ""}`;
}

function grantedCallLimits(state: ProgressiveLodState, role: PendingBudget["role"], _nodeId?: string) {
  return state.roleLimits[role];
}

const MAX_AUTOMATIC_CONTINUATIONS: Record<PendingBudget["role"], number> = { scout: 1, decider: 0, implementer: 2, verifier: 1, repair: 1 };
function canResumeCall(state: ProgressiveLodState, role: PendingBudget["role"], nodeId?: string): boolean {
  return (state.budgetGrants[callGrantKey(role, nodeId)] ?? 0) < MAX_AUTOMATIC_CONTINUATIONS[role];
}

function resumeAfterCallBudget(state: ProgressiveLodState, role: PendingBudget["role"], nodeId?: string) {
  const grantKey = callGrantKey(role, nodeId);
  return {
    budgetGrants: { ...state.budgetGrants, [grantKey]: (state.budgetGrants[grantKey] ?? 0) + 1 },
    pendingBudget: undefined, resumeFromAbortedSession: true, resumeRole: role, phase: `resuming-${role}`,
  };
}

function globalBudgetStop(state: ProgressiveLodState): string | undefined {
  const checks: Array<[string, number, number]> = [
    ["calls", state.callsUsed, state.budget.calls], ["turns", state.usage.turns, state.budget.maxTurns],
    ["input tokens", state.usage.input, state.budget.maxInputTokens], ["cache-read tokens", state.usage.cacheRead, state.budget.maxCacheReadTokens],
    ["cost", state.usage.cost, state.budget.maxCost], ["minutes", (Date.now() - state.startedAt) / 60_000, state.budget.minutes],
  ];
  const exceeded = checks.find(([, used, limit]) => used >= limit);
  return exceeded ? `${exceeded[0]} ${exceeded[1]}/${exceeded[2]}` : undefined;
}

function progress(state: ProgressiveLodState): GraphProgressSnapshot {
  return {
    phase: state.phase, scope: state.profile?.scope, activeNodeId: state.activeNodeId ?? state.activeLeafId, callsUsed: state.callsUsed, callBudget: state.budget.calls, costBudget: state.budget.maxCost,
    summary: state.verification?.summary ?? state.profile?.goal, usage: state.usage,
    nodes: state.plan.map((node) => ({ id: node.id, parentId: node.parentId, title: node.title, level: node.level, depth: node.depth, status: node.status, dependencies: node.dependencies, evidence: node.evidenceIds.length, confidence: node.confidence, agents: node.agents })),
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
      const result = await runtime(config).call({ agent: classifier, node: "classify", state, limits: state.roleLimits.classifier, schema: z.toJSONSchema(ClassificationSchema) as Record<string, unknown>, validateStructured: (value) => ClassificationSchema.parse(value), prompt: JSON.stringify({ task: state.originalTask }) });
      if (result.budgetStop) throw new Error(`Classifier exceeded ${result.budgetStop.metric} budget`);
      const classified = structured(result, ClassificationSchema, "classify");
      const profile = classified.route === "planned_change" ? classified : { ...classified, questions: undefined };
      return { profile, budget: budgets[profile.scope], phase: "classified", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result.usage) };
    })
    .addNode("answer", agentNode<ProgressiveLodState>({ node: "answer", agent: answer, prompt: (state) => JSON.stringify({ task: state.originalTask }), output: (text, state, result) => ({ result: text, phase: "completed", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result.usage) }) }))
    .addNode("acquire", async (_state: ProgressiveLodState, config?: RunnableConfig) => { const acquire = config?.configurable?.langgraphAcquireWorktree as (() => Promise<void>) | undefined; if (acquire) await acquire(); return {}; })
    .addNode("initialize", (state: ProgressiveLodState) => ({
      ...(state.profile?.route === "direct_change" ? { phase: "implementing", activeNodeId: undefined, activeLeafId: "p1", resumeRole: "implementer" as const } : { phase: "scouting", activeNodeId: "p1", activeLeafId: undefined, resumeRole: "scout" as const }), nextId: 2,
      plan: [{ id: "p1", title: state.profile?.goal ?? state.originalTask, description: state.originalTask, level: state.profile?.goal ?? state.originalTask, depth: 0, status: state.profile?.route === "direct_change" ? "implementing" as const : "active" as const, dependencies: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0, agents: [classifier], scoutSessionMode: "fresh" as const, scoutTurns: 0, ...(state.profile?.route === "direct_change" ? { leaf: { objective: state.profile.goal, targets: ["Files required by the request"], acceptanceCriteria: [state.originalTask], verification: ["Run focused checks appropriate to the requested change"] } } : {}) }],
    }))
    .addNode("guard", (state: ProgressiveLodState) => {
      if (state.result || state.phase === "failed") return {};
      const globalStop = globalBudgetStop(state);
      if (globalStop) return { resumeRole: undefined, phase: "failed", result: `Stopped automatically at the ${state.profile?.scope ?? "unknown"} run budget: ${globalStop}.` };
      const active = state.plan.find((node) => node.id === state.activeNodeId);
      if (active && active.contextCycles >= state.budget.contextCyclesPerNode) return { resumeRole: undefined, phase: "failed", result: `Planning stopped after ${active.contextCycles} context cycles for ${active.id}; no bounded implementation contract was reached.` };
      return {};
    })
    .addNode("scout", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const active = state.plan.find((node) => node.id === state.activeNodeId); if (!active) throw new Error("Scout requires an active branch");
      const result = await runtime(config).call({
        agent: options.scoutAgent, node: `scout:${active.id}`, state, limits: grantedCallLimits(state, "scout", active.id),
        session: state.resumeFromAbortedSession
          ? resumableSession(active.scoutSessionId, true)
          : sessionDirective(active.scoutSessionId, active.scoutSessionMode, active.scoutTurns), schema: z.toJSONSchema(ResearchSchema) as Record<string, unknown>, validateStructured: (value) => ResearchSchema.parse(value),
        prompt: JSON.stringify(branchProjection(state)),
      });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      const plan = state.plan.map((node) => node.id === active.id ? { ...node, scoutSessionId: result.sessionId, scoutSessionMode: "continue" as const, scoutTurns: (node.scoutTurns ?? 0) + (result.usage?.turns ?? 0) } : node);
      if (result.budgetStop) return canResumeCall(state, "scout", active.id)
        ? { plan, usage, callsUsed, ...resumeAfterCallBudget(state, "scout", active.id) }
        : { plan, usage, callsUsed, resumeRole: undefined, phase: "failed", result: `Scout ${active.id} exhausted its automatic scheduling quanta without returning evidence.` };
      const merged = mergeResearch({ ...state, plan }, groundedResearch(structured(result, ResearchSchema, "scout"), result));
      return { ...merged, plan, usage, callsUsed, resumeFromAbortedSession: false, resumeRole: "decider" as const, phase: "deciding" };
    })
    .addNode("decide", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const active = state.plan.find((node) => node.id === state.activeNodeId); if (!active) throw new Error("Decider requires an active branch");
      const result = await runtime(config).call({
        agent: options.deciderAgent, node: `decide:${active.id}`, state, limits: grantedCallLimits(state, "decider", active.id),
        session: resumableSession(state.deciderSessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(DetailDecisionSchema) as Record<string, unknown>, validateStructured: (value) => parseDetailDecision(value, state),
        prompt: JSON.stringify(branchProjection(state)),
      });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      if (result.budgetStop) return canResumeCall(state, "decider", active.id)
        ? { usage, callsUsed, deciderSessionId: result.sessionId, ...resumeAfterCallBudget(state, "decider", active.id) }
        : { usage, callsUsed, deciderSessionId: undefined, resumeRole: undefined, phase: "failed", result: `Decider ${active.id} exhausted its scheduling quantum without a valid disposition.` };
      return { decision: parseDetailDecision(result.structured ?? JSON.parse(result.text), state), deciderSessionId: undefined, resumeFromAbortedSession: false, usage, callsUsed, phase: "merging" };
    })
    .addNode("merge", (state: ProgressiveLodState) => {
      if (!state.decision) throw new Error("Merge requires a detail decision");
      const merged = applyDecision(state, state.decision, options.deciderAgent);
      const constraints = state.humanAnswer ? [...state.constraints, { id: `c${state.constraints.length + 1}`, text: `User decision: ${state.humanAnswer}`, source: "user", nodeId: state.activeNodeId }] : state.constraints;
      return { ...merged, constraints, decision: undefined, research: undefined, humanAnswer: "", humanQuestion: merged.humanQuestion, resumeRole: merged.activeNodeId ? "scout" as const : "implementer" as const, phase: merged.humanQuestion ? "waiting-human" : merged.activeNodeId ? "scouting" : "selecting-leaf" };
    })
    .addNode("human", (state: ProgressiveLodState) => {
      const response = interrupt({ kind: "decision", question: state.humanQuestion, activeNodeId: state.activeNodeId, plan: progress(state) });
      const answer = typeof response === "string" ? response : JSON.stringify(response);
      return { humanAnswer: answer, humanQuestion: "", resumeRole: "decider" as const, phase: "deciding" };
    })
    .addNode("budget_interrupt", (state: ProgressiveLodState) => {
      const pending = state.pendingBudget; if (!pending) throw new Error("Budget interrupt requires a pending budget");
      const response = interrupt({ kind: "budget", role: pending.role, nodeId: pending.nodeId, metric: pending.stop.metric, used: pending.stop.used, limit: pending.stop.limit, choices: ["continue", "narrow: …", "stop"] });
      const answer = String(response).trim();
      if (answer.toLowerCase() === "stop") return { pendingBudget: undefined, resumeRole: undefined, phase: "failed", result: `Stopped at the ${pending.role} ${pending.stop.metric} budget (${pending.stop.used}/${pending.stop.limit}).` };
      const constraints = answer.toLowerCase().startsWith("narrow:") ? [...state.constraints, { id: `c${state.constraints.length + 1}`, text: answer.slice(7).trim(), source: "user budget decision", nodeId: pending.nodeId }] : state.constraints;
      const grantKey = pending.scope === "global" ? "global" : pending.scope === "node" && pending.nodeId ? `context:${pending.nodeId}` : pending.scope === "call" ? callGrantKey(pending.role, pending.nodeId) : undefined;
      const budgetGrants = grantKey ? { ...state.budgetGrants, [grantKey]: (state.budgetGrants[grantKey] ?? 0) + 1 } : state.budgetGrants;
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
      const result = await runtime(config).call({ agent: options.implementerAgent, node: `implement:${leaf.id}`, state, limits: grantedCallLimits(state, "implementer", leaf.id), session: resumableSession(existing, state.resumeFromAbortedSession), schema: z.toJSONSchema(ImplementationResultSchema) as Record<string, unknown>, validateStructured: (value) => ImplementationResultSchema.parse(value), prompt: JSON.stringify(leafPayload(state, leaf)) });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1; const sessions = { ...state.implementationSessions, [leaf.id]: result.sessionId ?? existing };
      if (result.budgetStop && madeMutation(result) && canResumeCall(state, "implementer", leaf.id)) return { usage, callsUsed, implementationSessions: sessions, ...resumeAfterCallBudget(state, "implementer", leaf.id) };
      if (result.budgetStop && madeMutation(result)) return { usage, callsUsed, implementationSessions: sessions, resumeRole: undefined, phase: "failed", result: `Implementer ${leaf.id} exhausted its automatic scheduling quanta after making partial changes; inspect the leaf session before continuing.` };
      if (result.budgetStop) {
        const output = implementationResult({ status: "blocked", changedFiles: [], checks: [], blocker: `Implementer exhausted ${result.budgetStop.metric} without producing a mutation; the contract requires replanning.` });
        return { usage, callsUsed, implementationSessions: sessions, implementationResults: { ...state.implementationResults, [leaf.id]: output }, resumeFromAbortedSession: false, activeLeafId: undefined, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: "failed" as const } : node), phase: "implementation-blocked" };
      }
      const output = implementationResult(structured(result, ImplementationResultSchema, "implement"));
      return { usage, callsUsed, implementationSessions: sessions, implementationResults: { ...state.implementationResults, [leaf.id]: output }, resumeFromAbortedSession: false, activeLeafId: undefined, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: output.status === "completed" ? "implemented" as const : "failed" as const } : node), phase: output.status === "completed" ? "selecting-leaf" : "implementation-blocked" };
    })
    .addNode("reopen_blocker", (state: ProgressiveLodState) => {
      const failed = state.plan.filter((node) => node.status === "failed").map((node) => node.id); const reopened = reopenFailedPlan(state.plan, failed, state.budget.reopens);
      const issues = failed.map((id) => ({ source: "implementation" as const, leafId: id, text: state.implementationResults[id]?.blocker || "Implementation reported a missing prerequisite." }));
      const executionOnlyFailure = issues.every((issue) => issue.text.startsWith("Implementer exhausted"));
      return { plan: withReplanIssues(reopened.plan, reopened.reopenedNodeIds, issues), activeNodeId: reopened.activeNodeId, activeLeafId: undefined,
        implementationSessions: withoutKeys(state.implementationSessions, reopened.invalidatedNodeIds), implementationResults: withoutKeys(state.implementationResults, reopened.invalidatedNodeIds),
        resumeRole: reopened.activeNodeId ? executionOnlyFailure ? "decider" as const : "scout" as const : undefined, phase: reopened.activeNodeId ? executionOnlyFailure ? "deciding" : "scouting" : "failed", research: undefined, decision: undefined };
    })
    .addNode("verify", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const leaves = state.plan.filter((node) => node.leaf && (node.status === "implemented" || node.status === "failed")).map((node) => ({ leafId: node.id, contract: node.leaf, artifacts: state.implementationResults[node.id] ? { changedFiles: state.implementationResults[node.id].changedFiles, checks: state.implementationResults[node.id].checks } : undefined }));
      const prepare = config?.configurable?.langgraphPrepareVerifierWorkspace as ((runId: string, worktree: string, existing?: string) => Promise<string>) | undefined;
      const release = config?.configurable?.langgraphReleaseVerifierWorkspace as ((runId: string) => Promise<void>) | undefined;
      if (!prepare || !release) throw new Error("Progressive LOD verifier requires an isolated-workspace runtime");
      const workspace = await prepare(state.runId, state.worktree, state.verifierWorkspace);
      let retainWorkspace = false;
      try {
        const relevant = new Set<string>();
        for (const leaf of leaves) {
          for (const id of lineageNodeIds(state, leaf.leafId)) relevant.add(id);
          const node = state.plan.find((item) => item.id === leaf.leafId);
          for (const dependency of node?.dependencies ?? []) { relevant.add(dependency); for (const item of dependencyLeaves(state, dependency)) relevant.add(item.id); }
        }
        const result = await runtime(config).call({ agent: verifier, node: "verify", state, directory: workspace, worktree: workspace, limits: grantedCallLimits(state, "verifier"), session: resumableSession(state.verifierSessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(VerificationSchema) as Record<string, unknown>, validateStructured: (value) => VerificationSchema.parse(value), prompt: isolatedPayload({ task: state.originalTask, constraints: state.constraints.filter((item) => !item.nodeId || relevant.has(item.nodeId)).map(({ text }) => text), leaves }, state) });
        const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
        if (result.budgetStop && canResumeCall(state, "verifier")) {
          retainWorkspace = true;
          return { usage, callsUsed, verifierWorkspace: workspace, verifierSessionId: result.sessionId, ...resumeAfterCallBudget(state, "verifier") };
        }
        if (result.budgetStop) return { usage, callsUsed, verifierWorkspace: undefined, verifierSessionId: undefined, resumeRole: undefined, phase: "failed", result: "Verifier exhausted its automatic scheduling quanta without a verdict." };
        const verification = verificationResult(structured(result, VerificationSchema, "verify"), leaves.length);
        return { usage, callsUsed, verifierWorkspace: undefined, verifierSessionId: undefined, resumeFromAbortedSession: false, verification, plan: applyVerification(state.plan, verification), phase: verification.passed ? "completed" : "verification-failed" };
      } finally {
        if (!retainWorkspace) await release(state.runId);
      }
    })
    .addNode("select_repair", (state: ProgressiveLodState) => {
      const leaf = state.plan.filter((node) => node.status === "failed").sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
      if (!leaf) return { activeLeafId: undefined, verifierSessionId: undefined, resumeRole: "verifier" as const, phase: "verifying" };
      return { activeLeafId: leaf.id, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: "implementing" as const } : node), resumeRole: "repair" as const, phase: "repairing" };
    })
    .addNode("repair", async (state: ProgressiveLodState, config?: RunnableConfig) => {
      const leaf = state.plan.find((node) => node.id === state.activeLeafId); if (!leaf?.leaf) throw new Error("Repair requires one failed leaf");
      const sessionId = state.implementationSessions[leaf.id]; if (!sessionId) throw new Error(`Repair has no implementation session for ${leaf.id}`);
      const findings = state.verification?.checks.filter((check) => check.name === leaf.id).map((check) => check.evidence) ?? [];
      const result = await runtime(config).call({ agent: repairAgent, node: `repair:${leaf.id}`, state, limits: grantedCallLimits(state, "repair", leaf.id), session: resumableSession(sessionId, state.resumeFromAbortedSession), schema: z.toJSONSchema(ImplementationResultSchema) as Record<string, unknown>, validateStructured: (value) => ImplementationResultSchema.parse(value), prompt: JSON.stringify({ leafId: leaf.id, findings }) });
      const usage = addUsage(state.usage, result.usage); const callsUsed = state.callsUsed + 1;
      const sessions = { ...state.implementationSessions, [leaf.id]: result.sessionId ?? sessionId };
      if (result.budgetStop) return canResumeCall(state, "repair", leaf.id)
        ? { usage, callsUsed, implementationSessions: sessions, ...resumeAfterCallBudget(state, "repair", leaf.id) }
        : { usage, callsUsed, implementationSessions: sessions, resumeRole: undefined, phase: "failed", result: `Repair ${leaf.id} exhausted its automatic scheduling quanta.` };
      const output = implementationResult(structured(result, ImplementationResultSchema, "repair"));
      return { usage, callsUsed, implementationSessions: sessions, resumeFromAbortedSession: false, repairAttempts: state.repairAttempts + 1, implementationResults: { ...state.implementationResults, [leaf.id]: output }, activeLeafId: undefined, plan: state.plan.map((node) => node.id === leaf.id ? { ...node, status: output.status === "completed" ? "implemented" as const : "failed" as const } : node), phase: output.status === "completed" ? "selecting-repair" : "implementation-blocked" };
    })
    .addNode("reopen", (state: ProgressiveLodState) => {
      const reopened = reopenFailedPlan(state.plan, state.verification?.failedNodeIds ?? [], state.budget.reopens);
      const failed = new Set(state.verification?.failedNodeIds ?? []);
      const issues = (state.verification?.checks ?? []).filter((check) => failed.has(check.name)).map((check) => ({ source: "verification" as const, leafId: check.name, text: check.evidence }));
      return { plan: withReplanIssues(reopened.plan, reopened.reopenedNodeIds, issues), activeNodeId: reopened.activeNodeId, verifierSessionId: undefined, verification: undefined,
        implementationSessions: withoutKeys(state.implementationSessions, reopened.invalidatedNodeIds), implementationResults: withoutKeys(state.implementationResults, reopened.invalidatedNodeIds),
        research: undefined, decision: undefined, resumeRole: reopened.activeNodeId ? "scout" as const : undefined, phase: reopened.activeNodeId ? "scouting" : "failed" };
    })
    .addNode("finish", (state: ProgressiveLodState) => {
      if (state.result) return {};
      const live = new Set(state.plan.filter((node) => node.status === "verified" || node.status === "implemented" || node.status === "failed").map((node) => node.id));
      const summaries = Object.entries(state.implementationResults).filter(([id]) => live.has(id)).map(([id, item]) => `${id}: ${item.summary}`).join("\n");
      return { phase: state.verification?.passed ? "completed" : "failed", result: state.verification?.passed ? `${summaries}\n\nVerification: ${state.verification.summary}` : `The graph did not reach verified success.\n\n${state.verification?.summary ?? (summaries || "No implementation completed.")}` };
    })
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state: ProgressiveLodState) => state.profile?.route ?? "answer", { answer: "answer", direct_change: "acquire", planned_change: "acquire" })
    .addEdge("answer", END)
    .addConditionalEdges("acquire", (state: ProgressiveLodState) => state.plan.length ? "guard" : "initialize", { guard: "guard", initialize: "initialize" })
    .addEdge("initialize", "guard")
    .addConditionalEdges("guard", (state: ProgressiveLodState) => state.result || state.phase === "failed" ? "finish" : state.pendingBudget ? "budget" : state.resumeRole ?? "scout", { finish: "finish", budget: "budget_interrupt", scout: "scout", decider: "decide", implementer: "implement", verifier: "verify", repair: "repair" })
    .addConditionalEdges("scout", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : "guard", { budget: "budget_interrupt", guard: "guard" })
    .addConditionalEdges("decide", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : state.pendingBudget ? "budget" : state.phase === "resuming-decider" ? "retry" : "merge", { finish: "finish", budget: "budget_interrupt", retry: "guard", merge: "merge" })
    .addConditionalEdges("merge", (state: ProgressiveLodState) => state.humanQuestion ? "human" : state.activeNodeId ? "guard" : "select", { human: "human", guard: "guard", select: "select_leaf" })
    .addEdge("human", "acquire")
    .addConditionalEdges("budget_interrupt", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : "acquire", { finish: "finish", acquire: "acquire" })
    .addConditionalEdges("select_leaf", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : "guard", { finish: "finish", guard: "guard" })
    .addConditionalEdges("implement", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : state.pendingBudget ? "budget" : state.phase === "resuming-implementer" ? "retry" : state.phase === "implementation-blocked" ? "reopen" : "select", { finish: "finish", budget: "budget_interrupt", retry: "guard", reopen: "reopen_blocker", select: "select_leaf" })
    .addConditionalEdges("reopen_blocker", (state: ProgressiveLodState) => state.activeNodeId ? "guard" : "finish", { guard: "guard", finish: "finish" })
    .addConditionalEdges("verify", (state: ProgressiveLodState) => state.pendingBudget ? "budget" : state.phase === "resuming-verifier" ? "retry" : state.verification?.passed ? "finish" : state.verification?.architecturalMismatch ? "reopen" : state.verification?.repairable && state.repairAttempts < state.budget.repairs ? "repair" : "finish", { budget: "budget_interrupt", retry: "guard", finish: "finish", reopen: "reopen", repair: "select_repair" })
    .addConditionalEdges("select_repair", (state: ProgressiveLodState) => state.resumeRole === "repair" ? "guard" : "guard", { guard: "guard" })
    .addConditionalEdges("repair", (state: ProgressiveLodState) => state.phase === "failed" ? "finish" : state.pendingBudget ? "budget" : state.phase === "resuming-repair" ? "retry" : state.phase === "implementation-blocked" ? "reopen" : "next", { finish: "finish", budget: "budget_interrupt", retry: "guard", reopen: "reopen_blocker", next: "select_repair" })
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
