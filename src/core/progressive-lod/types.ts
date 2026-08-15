import { z } from "zod";

export const ScopeSchema = z.enum(["local", "subsystem", "architectural", "unknown"]);
export type TaskScope = z.infer<typeof ScopeSchema>;
export type PlanStatus = "pending" | "active" | "ready" | "implementing" | "verified" | "failed" | "removed";

export interface TaskProfile {
  route: "answer" | "change";
  scope: TaskScope;
  summary: string;
  planningFrame: string;
  readOnly: boolean;
  risks: string[];
}

export interface Evidence { id: string; claim: string; source: string; kind: "repository" | "tool" | "inference" | "user"; confidence: number }
export interface Constraint { id: string; text: string; source: string }
export interface PlanNode {
  id: string;
  parentId?: string;
  title: string;
  description: string;
  level: string;
  depth: number;
  status: PlanStatus;
  dependencies: string[];
  files: string[];
  evidenceIds: string[];
  confidence: number;
  contextCycles: number;
  reopenCount: number;
}

export interface CandidateRefinement {
  action: "refine" | "split" | "remove" | "reopen_parent";
  title: string;
  description: string;
  level: string;
  implementable: boolean;
  dependencies: string[];
  files: string[];
}

export interface Candidate { name: string; rationale: string; refinements: CandidateRefinement[] }
export interface Evaluation {
  selected: number;
  confidence: number;
  needsMoreContext: boolean;
  needsHuman: boolean;
  question: string;
}

export interface Budget {
  calls: number;
  nodes: number;
  candidates: number;
  contextCyclesPerNode: number;
  reopens: number;
  repairs: number;
  minutes: number;
  reservedCalls: number;
}

export const SCOPE_BUDGETS: Record<TaskScope, Budget> = {
  local: { calls: 12, nodes: 8, candidates: 2, contextCyclesPerNode: 2, reopens: 1, repairs: 1, minutes: 15, reservedCalls: 2 },
  subsystem: { calls: 24, nodes: 16, candidates: 2, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 30, reservedCalls: 3 },
  architectural: { calls: 40, nodes: 24, candidates: 3, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 60, reservedCalls: 3 },
  unknown: { calls: 40, nodes: 24, candidates: 3, contextCyclesPerNode: 3, reopens: 2, repairs: 2, minutes: 60, reservedCalls: 3 },
};

export const ClassificationSchema = z.object({
  route: z.enum(["answer", "change"]), scope: ScopeSchema, summary: z.string().min(1),
  planningFrame: z.string().min(1),
  readOnly: z.boolean(), risks: z.array(z.string().max(500)).max(12).default([]),
});

const RefinementSchema = z.object({
  action: z.enum(["refine", "split", "remove", "reopen_parent"]), title: z.string().min(1),
  description: z.string().min(1).max(4000), level: z.string().min(1),
  implementable: z.boolean(), dependencies: z.array(z.string()).max(20).default([]),
  files: z.array(z.string()).max(40).default([]),
});

export const AnalysisSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.object({ claim: z.string().min(1).max(1000), source: z.string().min(1).max(1000), kind: z.enum(["repository", "tool", "inference"]), confidence: z.number().min(0).max(1) })).max(20).default([]),
  constraints: z.array(z.object({ text: z.string().min(1).max(1000), source: z.string().min(1).max(1000) })).max(20).default([]),
  candidates: z.array(z.object({ name: z.string().min(1), rationale: z.string().max(2000), refinements: z.array(RefinementSchema).min(1).max(10) })).min(1).max(3),
  evaluation: z.object({ selected: z.number().int().nonnegative(), confidence: z.number().min(0).max(1), needsMoreContext: z.boolean(), needsHuman: z.boolean(), question: z.string().default("") }),
});
export type AnalysisOutput = z.infer<typeof AnalysisSchema>;

export const VerificationSchema = z.object({
  passed: z.boolean(), summary: z.string().min(1), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string() })).default([]),
  failedNodeIds: z.array(z.string()).default([]), repairable: z.boolean(), architecturalMismatch: z.boolean(),
});
export type VerificationOutput = z.infer<typeof VerificationSchema>;

export interface ProgressiveLodState extends Record<string, unknown> {
  runId: string; originalTask: string; directory: string; worktree: string;
  phase: string; profile?: TaskProfile; budget: Budget;
  plan: PlanNode[]; activeNodeId?: string; evidence: Evidence[]; constraints: Constraint[];
  analysis?: AnalysisOutput; discoveries: string[]; callsUsed: number; nextId: number;
  startedAt: number; repairAttempts: number; humanQuestion: string; humanAnswer: string;
  implementation: string; verification?: VerificationOutput; result: string;
}
