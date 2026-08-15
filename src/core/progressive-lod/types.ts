import { z } from "zod";
import type { AgentBudgetStop, AgentCallLimits, AgentUsage } from "../types.js";

export const ScopeSchema = z.enum(["local", "subsystem", "architectural", "unknown"]);
export type TaskScope = z.infer<typeof ScopeSchema>;
export type PlanStatus = "pending" | "active" | "expanded" | "ready" | "implementing" | "implemented" | "verified" | "failed" | "removed";

export interface TaskProfile {
  route: "answer" | "change";
  scope: TaskScope;
  summary: string;
  planningFrame: string;
  readOnly: boolean;
  risks: string[];
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
export interface Constraint { id: string; text: string; source: string }
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
  leaf?: LeafContract;
  scoutSessionId?: string;
  scoutSessionMode?: "continue" | "fork" | "fresh";
  scoutTurns?: number;
}

export interface ResearchPacket {
  summary: string;
  evidence: Evidence[];
  constraints: Constraint[];
  unresolved: string[];
}

export interface DecisionOption { id: string; label: string; rationale: string; tradeoff: string }
export interface DecisionChild {
  key: string;
  title: string;
  description: string;
  level: string;
  dependencies: string[];
}
export interface DetailDecision {
  disposition: "ready" | "refine" | "split" | "remove" | "reopen_parent" | "interrupt";
  summary: string;
  options: DecisionOption[];
  selectedOption: string;
  confidence: number;
  question: string;
  children: DecisionChild[];
  leaf?: LeafContract;
}

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
  scout: { maxTurns: 8, maxInputTokens: 64_000, maxCacheReadTokens: 400_000, maxContextTokens: 48_000 },
  decider: { maxTurns: 2, maxInputTokens: 20_000, maxCacheReadTokens: 100_000, maxContextTokens: 48_000 },
  implementer: { maxTurns: 32, maxInputTokens: 180_000, maxCacheReadTokens: 2_000_000, maxContextTokens: 96_000 },
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
  route: z.enum(["answer", "change"]), scope: ScopeSchema, summary: z.string().min(1).max(500),
  planningFrame: z.string().min(1), readOnly: z.boolean(), risks: z.array(z.string().max(500)).max(8).default([]),
});

const EvidenceSchema = z.object({
  claim: z.string().min(1).max(700), source: z.string().min(1).max(500), excerpt: z.string().max(500).default(""),
  kind: z.enum(["repository", "tool", "inference"]), confidence: z.number().min(0).max(1),
});
export const ResearchSchema = z.object({
  summary: z.string().min(1).max(1200), evidence: z.array(EvidenceSchema).max(12).default([]),
  constraints: z.array(z.object({ text: z.string().min(1).max(700), source: z.string().min(1).max(500) })).max(12).default([]),
  unresolved: z.array(z.string().max(500)).max(8).default([]),
});

const LeafSchema = z.object({
  objective: z.string().min(1).max(1200), targets: z.array(z.string().min(1).max(500)).min(1).max(20),
  acceptanceCriteria: z.array(z.string().min(1).max(700)).min(1).max(12),
  verification: z.array(z.string().min(1).max(500)).min(1).max(12),
});
export const DetailDecisionSchema = z.object({
  disposition: z.enum(["ready", "refine", "split", "remove", "reopen_parent", "interrupt"]),
  summary: z.string().min(1).max(1200),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(160), rationale: z.string().max(400), tradeoff: z.string().max(400) })).max(3).default([]),
  selectedOption: z.string().max(40).default(""), confidence: z.number().min(0).max(1), question: z.string().max(700).default(""),
  children: z.array(z.object({ key: z.string().min(1).max(80), title: z.string().min(1).max(300), description: z.string().min(1).max(1200), level: z.string().min(1), dependencies: z.array(z.string().max(80)).max(12).default([]) })).max(8).default([]),
  leaf: LeafSchema.optional(),
});

export const ImplementationResultSchema = z.object({
  status: z.enum(["completed", "blocked"]), summary: z.string().min(1).max(2000),
  changedFiles: z.array(z.string().max(500)).max(50).default([]),
  checks: z.array(z.object({ name: z.string().max(500), passed: z.boolean(), evidence: z.string().max(1000) })).max(30).default([]),
  blocker: z.string().max(1500).default(""),
});

export const VerificationSchema = z.object({
  passed: z.boolean(), summary: z.string().min(1).max(2000),
  checks: z.array(z.object({ name: z.string().max(500), passed: z.boolean(), evidence: z.string().max(1000) })).max(30).default([]),
  failedNodeIds: z.array(z.string().max(80)).max(30).default([]), repairable: z.boolean(), architecturalMismatch: z.boolean(),
});

export interface PendingBudget {
  scope: "call" | "global";
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
  humanQuestion: string; humanAnswer: string; result: string;
}
