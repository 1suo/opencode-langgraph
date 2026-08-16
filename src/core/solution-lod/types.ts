import { z } from "zod";
import type { AgentCallLimits, AgentUsage } from "../types.js";

export type Capability = "inspect" | "synthesize" | "implement" | "verify" | "present";
export type RegionEdge = "root" | "refines" | "partOf";
export type RegionStatus = "unformed" | "superposed" | "collapsed" | "actionable" | "implementing" | "implemented" | "verified" | "contradiction" | "blocked";
export type CandidateStatus = "possible" | "eliminated" | "selected" | "equivalent";

export interface ConditionalRegionDefinition {
  key: string;
  objective: string;
  edge: Exclude<RegionEdge, "root">;
  delivery?: "answer" | "change";
  allowedVariables: string[];
  acceptanceCriteria: string[];
}

export interface SolutionCandidate {
  id: string;
  regionId: string;
  key: string;
  proposition: string;
  status: CandidateStatus;
  evidenceIds: string[];
  eliminationReasons: string[];
  nextLod: ConditionalRegionDefinition[];
}

export interface SolutionRegion {
  id: string;
  key: string;
  parentId?: string;
  parentCandidateId?: string;
  edge: RegionEdge;
  lod: number;
  objective: string;
  delivery: "answer" | "change";
  allowedVariables: string[];
  acceptanceCriteria: string[];
  status: RegionStatus;
  candidateIds: string[];
  selectedCandidateIds: string[];
  constraintIds: string[];
  evidenceIds: string[];
  activationIds: string[];
  artifactIds: string[];
  answer?: string;
  contradiction?: string;
}

export interface SolutionEvidence {
  id: string;
  text: string;
  source: string;
  kind: "repository" | "tool" | "inference" | "user";
  fingerprint: string;
}

export type ConstraintKind = "requires" | "excludes" | "supports" | "refutes" | "equivalent" | "acceptance" | "permission";
export interface SolutionConstraint {
  id: string;
  kind: ConstraintKind;
  subject: string;
  target: string;
  reason: string;
  sourceActivationId: string;
}

export interface SolutionArtifact {
  id: string;
  regionId: string;
  kind: "file" | "check" | "answer";
  path?: string;
  summary: string;
  passed?: boolean;
  activationId: string;
}

export interface Activation {
  id: string;
  capability: Capability;
  regionId: string;
  request: string;
  expectedDelta: string;
  contextRefs: string[];
  wakeCondition?: { ref: string; revisionAfter: number };
  senderActivationId?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  basisRevision: number;
  sessionId?: string;
  error?: string;
}

export interface SolutionNetwork {
  revision: number;
  nextRegionId: number;
  nextEvidenceId: number;
  nextConstraintId: number;
  nextActivationId: number;
  nextArtifactId: number;
  regions: SolutionRegion[];
  candidates: SolutionCandidate[];
  constraints: SolutionConstraint[];
  evidence: SolutionEvidence[];
  activations: Activation[];
  artifacts: SolutionArtifact[];
}

export interface SolutionRoleLimits {
  inspect: AgentCallLimits;
  synthesize: AgentCallLimits;
  implement: AgentCallLimits;
  verify: AgentCallLimits;
  present: AgentCallLimits;
}

export const DEFAULT_SOLUTION_ROLE_LIMITS: SolutionRoleLimits = {
  inspect: { maxTurns: 32, maxContextTokens: 160_000 },
  synthesize: { maxTurns: 8, maxContextTokens: 96_000 },
  implement: { maxTurns: 32, maxContextTokens: 160_000 },
  verify: { maxTurns: 16, maxContextTokens: 96_000 },
  present: { maxTurns: 4, maxContextTokens: 48_000 },
};

const ConditionalRegionSchema = z.object({
  key: z.string().min(1), objective: z.string().min(1), edge: z.enum(["refines", "partOf"]).describe("'refines' for a finer decision about the same candidate; 'partOf' for an independent deliverable piece."),
  delivery: z.enum(["answer", "change"]).optional(), allowedVariables: z.array(z.string()).default([]), acceptanceCriteria: z.array(z.string()).default([]),
});

export const SolutionDeltaSchema = z.object({
  region: z.object({
    objective: z.string().optional(), delivery: z.enum(["answer", "change"]).optional(),
    allowedVariables: z.array(z.string()).optional(), acceptanceCriteria: z.array(z.string()).optional(),
  }).optional(),
  evidence: z.array(z.object({ text: z.string().min(1), source: z.string().min(1), kind: z.enum(["repository", "tool", "inference", "user"]).default("inference") })).default([]),
  candidates: z.array(z.object({
    key: z.string().min(1), proposition: z.string().min(1), outcome: z.enum(["possible", "eliminated", "selected", "equivalent"]).default("possible"),
    reasons: z.array(z.string()).default([]), evidenceRefs: z.array(z.string()).default([]), nextLod: z.array(ConditionalRegionSchema).default([]).describe("Follow-up work this candidate still needs: 'refines' for a decision that can only be made once it is chosen, 'partOf' for an independent deliverable piece. Never list routine steps, files, tests, or verification — those run automatically after the work is implemented."),
  })).default([]).describe("Mutually exclusive alternatives to the same goal — exactly one is chosen. Coexisting deliverables that all must be built are NOT candidates; attach them as 'partOf' follow-up pieces to the winning candidate."),
  constraints: z.array(z.object({ kind: z.enum(["requires", "excludes", "supports", "refutes", "equivalent", "acceptance", "permission"]), subject: z.string().min(1), target: z.string().min(1), reason: z.string().default("") })).default([]).describe("Dependencies between candidates: 'requires' (one needs another), 'excludes' (mutually incompatible), 'supports' (one strengthens another), 'refutes' (one contradicts another), 'equivalent' (interchangeable)."),
  select: z.array(z.string()).default([]),
  actionable: z.boolean().optional(),
  answer: z.string().optional(),
  resolvedAnswer: z.object({
    answer: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    evidenceRefs: z.array(z.string()).default([]),
  }).optional(),
  activations: z.array(z.object({
    capability: z.enum(["inspect", "synthesize", "implement", "verify", "present"]), regionId: z.string().optional(),
    request: z.string().min(1), expectedDelta: z.string().min(1), contextRefs: z.array(z.string()).default([]),
    wakeCondition: z.object({ ref: z.string(), revisionAfter: z.number().int().nonnegative() }).optional(),
  })).default([]),
});
export type SolutionDelta = z.infer<typeof SolutionDeltaSchema>;

export const ImplementationOutputSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string().default("") })).default([]),
  blocker: z.string().optional(),
  activations: SolutionDeltaSchema.shape.activations,
});
export type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;

export const VerificationOutputSchema = z.object({
  verdict: z.enum(["pass", "repair", "reopen", "fail"]),
  summary: z.string().default(""),
  findings: z.array(z.object({ criterion: z.string(), regionId: z.string(), problem: z.string(), evidence: z.string().default("") })).default([]),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string().default("") })).default([]),
  activations: SolutionDeltaSchema.shape.activations,
});
export type VerificationOutput = z.infer<typeof VerificationOutputSchema>;

export const PresentationOutputSchema = z.object({ answer: z.string().min(1) });

export interface SolutionLodState extends Record<string, unknown> {
  stateVersion: 3;
  runId: string;
  originalTask: string;
  conversationContext: string;
  directory: string;
  worktree: string;
  phase: string;
  activeActivationId?: string;
  network: SolutionNetwork;
  usage: AgentUsage;
  callsUsed: number;
  startedAt: number;
  worktreeAcquired: boolean;
  result: string;
}
