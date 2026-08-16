import { z } from "zod";
import type { AgentBudgetStop, AgentCallLimits, AgentUsage } from "../types.js";

export const ScopeSchema = z.enum(["local", "subsystem", "architectural", "unknown"]);
export type TaskScope = z.infer<typeof ScopeSchema>;
export type PlanStatus = "pending" | "active" | "expanded" | "ready" | "implementing" | "implemented" | "verified" | "failed" | "removed";

export interface TaskProfile {
  route: "answer" | "direct_change" | "planned_change";
  scope: TaskScope;
  goal: string;
  questions?: string[];
}

export interface Evidence {
  id: string;
  claim: string;
  source: string;
  excerpt: string;
  fingerprint: string;
  kind: "repository" | "tool" | "inference" | "user";
  confidence: number;
}
export interface Constraint { id: string; text: string; source: string; nodeId?: string }
export interface ReplanIssue { source: "implementation" | "verification" | "decision"; leafId?: string; text: string; evidence?: string }
export interface LeafContract {
  objective: string;
  targets: string[];
  acceptanceCriteria: string[];
  verification: string[];
}
export interface PlanNode {
  id: string;
  parentId?: string;
  title: string;
  description: string;
  level: string;
  depth: number;
  status: PlanStatus;
  dependencies: string[];
  evidenceIds: string[];
  confidence: number;
  contextCycles: number;
  reopenCount: number;
  agents?: string[];
  leaf?: LeafContract;
  scoutSessionId?: string;
  scoutSessionMode?: "continue" | "fork" | "fresh";
  scoutTurns?: number;
  replanIssues?: ReplanIssue[];
}

export interface ResearchPacket {
  evidence: Evidence[];
  constraints: Constraint[];
  unknowns: string[];
}

export interface DecisionChild {
  key: string;
  title: string;
  question: string;
  dependencies: string[];
}
export type DetailDecision =
  | ({ disposition: "ready" } & LeafContract)
  | { disposition: "refine"; child: DecisionChild }
  | { disposition: "split"; children: DecisionChild[] }
  | { disposition: "remove"; reason?: string }
  | { disposition: "reopen_parent"; reason?: string }
  | { disposition: "interrupt"; question: string };

export interface CheckResult { name: string; passed: boolean; evidence: string }
export interface ImplementationResult {
  status: "completed" | "blocked";
  summary: string;
  changedFiles: string[];
  checks: CheckResult[];
  blocker: string;
}

export interface VerificationOutput {
  passed: boolean;
  summary: string;
  checks: CheckResult[];
  failedNodeIds: string[];
  repairable: boolean;
  architecturalMismatch: boolean;
}

export interface ScopeBudget {
  calls: number;
  nodes: number;
  contextCyclesPerNode: number;
  reopens: number;
  repairs: number;
  minutes: number;
  maxTurns: number;
  maxInputTokens: number;
  maxCacheReadTokens: number;
  maxCost: number;
}

export interface ProgressiveRoleLimits {
  classifier: AgentCallLimits;
  scout: AgentCallLimits;
  decider: AgentCallLimits;
  implementer: AgentCallLimits;
  verifier: AgentCallLimits;
  repair: AgentCallLimits;
}

export const DEFAULT_ROLE_LIMITS: ProgressiveRoleLimits = {
  classifier: { maxTurns: 2, maxInputTokens: 16_000, maxCacheReadTokens: 64_000, maxContextTokens: 48_000 },
  scout: { maxTurns: 16, maxInputTokens: 128_000, maxCacheReadTokens: 800_000, maxContextTokens: 96_000 },
  decider: { maxTurns: 2, maxInputTokens: 20_000, maxCacheReadTokens: 100_000, maxContextTokens: 48_000 },
  implementer: { maxTurns: 8, maxInputTokens: 90_000, maxCacheReadTokens: 800_000, maxContextTokens: 64_000 },
  verifier: { maxTurns: 12, maxInputTokens: 90_000, maxCacheReadTokens: 800_000, maxContextTokens: 64_000 },
  repair: { maxTurns: 12, maxInputTokens: 90_000, maxCacheReadTokens: 800_000, maxContextTokens: 96_000 },
};

export const SCOPE_BUDGETS: Record<TaskScope, ScopeBudget> = {
  local: { calls: 12, nodes: 6, contextCyclesPerNode: 2, reopens: 1, repairs: 1, minutes: 15, maxTurns: 24, maxInputTokens: 100_000, maxCacheReadTokens: 1_000_000, maxCost: .03 },
  subsystem: { calls: 24, nodes: 12, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 30, maxTurns: 48, maxInputTokens: 250_000, maxCacheReadTokens: 3_000_000, maxCost: .08 },
  architectural: { calls: 40, nodes: 16, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 60, maxTurns: 80, maxInputTokens: 500_000, maxCacheReadTokens: 6_000_000, maxCost: .15 },
  unknown: { calls: 40, nodes: 16, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 60, maxTurns: 80, maxInputTokens: 500_000, maxCacheReadTokens: 6_000_000, maxCost: .15 },
};

export const ClassificationSchema = z.object({
  route: z.enum(["answer", "direct_change", "planned_change"]), scope: ScopeSchema,
  goal: z.string().min(1).max(500), questions: z.array(z.string().min(1).max(500)).min(1).max(6).optional(),
}).superRefine((value, context) => {
  if (value.route === "planned_change" && !value.questions?.length) context.addIssue({ code: "custom", path: ["questions"], message: "planned_change requires scouting questions" });
});

export const ResearchSchema = z.object({
  facts: z.array(z.object({ text: z.string().min(1).max(700), source: z.string().min(1).max(500) })).max(12).default([]),
  constraints: z.array(z.object({ text: z.string().min(1).max(700), source: z.string().min(1).max(500) })).max(12).default([]),
  unknowns: z.array(z.string().max(500)).max(8).default([]),
});

const LeafFields = {
  objective: z.string().min(1).max(500), targets: z.array(z.string().min(1).max(500)).min(1).max(5),
  acceptanceCriteria: z.array(z.string().min(1).max(700)).min(1).max(5),
  verification: z.array(z.string().min(1).max(500)).min(1).max(5),
};
const DecisionChildSchema = z.object({ key: z.string().min(1).max(80), title: z.string().min(1).max(300), question: z.string().min(1).max(700), dependencies: z.array(z.string().max(80)).max(12).default([]) });
export const DetailDecisionSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("ready"), ...LeafFields }),
  z.object({ disposition: z.literal("refine"), child: DecisionChildSchema }),
  z.object({ disposition: z.literal("split"), children: z.array(DecisionChildSchema).min(2).max(8) }),
  z.object({ disposition: z.literal("remove"), reason: z.string().max(500).optional() }),
  z.object({ disposition: z.literal("reopen_parent"), reason: z.string().max(500).optional() }),
  z.object({ disposition: z.literal("interrupt"), question: z.string().min(1).max(700) }),
]);

export const ImplementationResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  changedFiles: z.array(z.string().max(500)).max(50).default([]),
  checks: z.array(z.object({ name: z.string().max(500), passed: z.boolean(), evidence: z.string().max(1000) })).max(30).default([]),
  blocker: z.string().max(1500).optional(),
});

const FindingSchema = z.object({ leafId: z.string().min(1).max(80), problem: z.string().min(1).max(700), evidence: z.string().max(1000) });
export const VerificationSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("pass"), checks: z.array(z.object({ name: z.string().max(500), passed: z.literal(true), evidence: z.string().max(1000) })).max(30).default([]) }),
  z.object({ verdict: z.enum(["repair", "replan", "fail"]), findings: z.array(FindingSchema).min(1).max(30) }),
]);

export interface PendingBudget {
  scope: "call" | "global" | "node";
  role: "scout" | "decider" | "implementer" | "verifier" | "repair";
  nodeId?: string;
  stop: AgentBudgetStop;
  sessionId?: string;
}

export interface ProgressiveLodState extends Record<string, unknown> {
  stateVersion: 2;
  runId: string; originalTask: string; directory: string; worktree: string; phase: string;
  profile?: TaskProfile; budget: ScopeBudget; roleLimits: ProgressiveRoleLimits;
  plan: PlanNode[]; activeNodeId?: string; activeLeafId?: string;
  evidence: Evidence[]; constraints: Constraint[]; research?: ResearchPacket; decision?: DetailDecision;
  decisions: Record<string, string>; usage: AgentUsage; callsUsed: number; nextId: number; startedAt: number;
  deciderSessionId?: string; implementationSessions: Record<string, string>; verifierSessionId?: string;
  implementationResults: Record<string, ImplementationResult>; verification?: VerificationOutput;
  repairAttempts: number; pendingBudget?: PendingBudget; budgetGrants: Record<string, number>;
  resumeRole?: PendingBudget["role"];
  resumeFromAbortedSession?: boolean;
  verifierWorkspace?: string;
  humanQuestion: string; humanAnswer: string; result: string;
}
