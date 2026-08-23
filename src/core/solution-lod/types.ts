import { z } from "zod";
import type { AgentCallLimits, AgentUsage } from "../types.js";

export type Capability = "inspect" | "synthesize" | "refine" | "implement" | "verify" | "present";
export type RegionEdge = "root" | "refines" | "partOf";
export type RegionStatus = "unformed" | "superposed" | "unrefined" | "collapsed" | "actionable" | "implementing" | "implemented" | "verified" | "contradiction" | "blocked" | "stalled";
export type CandidateStatus = "possible" | "eliminated" | "selected" | "equivalent";

export interface ChildRegionDefinition {
  key: string;
  objective: string;
  edge: Exclude<RegionEdge, "root">;
  delivery?: "answer" | "change";
  allowedVariables: string[];
  acceptanceCriteria: string[];
  coveredCriteria: number[];
}

export interface SolutionCandidate {
  id: string;
  regionId: string;
  key: string;
  proposition: string;
  status: CandidateStatus;
  /** Authored disposition. `status` is recomputed from this on every propagation pass. */
  declaredStatus?: CandidateStatus;
  evidenceIds: string[];
  declaredEvidenceIds?: string[];
  eliminationReasons: string[];
  declaredEliminationReasons?: string[];
  /** Positions this move takes on shared decision variables. */
  stances: CandidateStance[];
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
  /** Contentless reopens accumulated since the last genuinely new evidence/artifact content. */
  reopens: number;
  /** Content fingerprint of the region's evidence and artifacts at the last counted reopen. */
  reopenFingerprint: string | null;
  candidateIds: string[];
  selectedCandidateIds: string[];
  constraintIds: string[];
  evidenceIds: string[];
  activationIds: string[];
  artifactIds: string[];
  answer?: string;
  contradiction?: string;
  coveredCriteria?: number[];
}

export interface SolutionEvidence {
  id: string;
  text: string;
  source: string;
  kind: "repository" | "tool" | "inference" | "user";
  fingerprint: string;
}

export type ConstraintKind = "requires" | "excludes" | "supports" | "refutes" | "equivalent";
export type ConstraintSource = "user-task" | "repo-evidence" | "model-inference";
export type StanceRelation = "requires" | "excludes" | "prefers";
export interface DecisionVariable {
  id: string;
  name: string;
  ownerRegionId: string;
  /** Known options at declaration time; new options may still appear later. Canonical spellings. */
  seedLabels: string[];
}
export interface CandidateStance {
  variableId: string;
  relation: StanceRelation;
  valueLabel: string;
}
export interface SolutionConstraint {
  id: string;
  kind: ConstraintKind;
  subject: string;
  target: string;
  reason: string;
  sourceActivationId: string;
  sourceKind: ConstraintSource;
  /** Resolved evidence ids backing this statement; coordinate-targeted refutations must be non-empty. */
  evidenceRefs: string[];
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
  senderActivationId?: string;
  status: "queued" | "running" | "completed" | "failed" | "superseded";
  basisRevision: number;
  sessionId?: string;
  error?: string;
}

/** One entry of the manifest `schedule` writes for the batch it dispatched. */
export interface ActiveBatchEntry {
  activationId: string;
  regionId: string;
  capability: Capability;
  basisRevision: number;
}

/** The network effect of one finished activation task, or null when the task errored. */
export type ActivationNetworkDelta =
  | { kind: "delta"; delta: SolutionDelta }
  | { kind: "refinement"; output: RefinementOutput }
  | { kind: "implementation"; output: ImplementationOutput; changedFiles: string[] }
  | { kind: "verification"; output: VerificationOutput }
  | { kind: "presentation"; answer: string };

/** The append-only per-task record a parallel `activate` task writes to `results`. */
export interface ActivationTaskResult {
  activationId: string;
  regionId: string;
  capability: Capability;
  basisRevision: number;
  startedAt: number;
  finishedAt: number;
  sessionId?: string;
  usage: AgentUsage;
  outcome: "applied" | "deferred" | "error";
  error?: string;
  changedFiles?: string[];
  networkDelta: ActivationNetworkDelta | null;
}

/** The unified snapshot a `Send` carries into one parallel `activate` task. */
export interface ActivationTaskInput {
  kind: "activation-task";
  activation: Activation;
  snapshot: {
    stateVersion: 7;
    runId: string;
    originalTask: string;
    conversationContext: string;
    directory: string;
    worktree: string;
    phase: string;
    network: SolutionNetwork;
  };
}

export interface SolutionNetwork {
  revision: number;
  nextRegionId: number;
  nextEvidenceId: number;
  nextConstraintId: number;
  nextActivationId: number;
  nextArtifactId: number;
  nextVariableId: number;
  regions: SolutionRegion[];
  candidates: SolutionCandidate[];
  constraints: SolutionConstraint[];
  evidence: SolutionEvidence[];
  activations: Activation[];
  artifacts: SolutionArtifact[];
  variables: DecisionVariable[];
}

export interface SolutionRoleLimits {
  inspect: AgentCallLimits;
  synthesize: AgentCallLimits;
  refine: AgentCallLimits;
  implement: AgentCallLimits;
  verify: AgentCallLimits;
  present: AgentCallLimits;
}

export const DEFAULT_SOLUTION_ROLE_LIMITS: SolutionRoleLimits = {
  inspect: { maxTurns: 32, maxContextTokens: 160_000 },
  synthesize: { maxTurns: 8, maxContextTokens: 96_000 },
  refine: { maxTurns: 8, maxContextTokens: 96_000 },
  implement: { maxTurns: 32, maxContextTokens: 160_000 },
  verify: { maxTurns: 16, maxContextTokens: 96_000 },
  present: { maxTurns: 4, maxContextTokens: 48_000 },
};

const ChildRegionSchema = z.object({
  key: z.string().min(1).describe("A short stable name for this child."),
  objective: z.string().min(1).describe("What this child must decide or deliver."),
  edge: z.enum(["refines", "partOf"]).describe("Use 'refines' for a choice that becomes meaningful only after choosing the parent. Use 'partOf' for an independent required deliverable."),
  delivery: z.enum(["answer", "change"]).optional().describe("Use 'answer' only when this child must answer a question without changing files. Otherwise use 'change'."),
  allowedVariables: z.array(z.string()).default([]).describe("The only aspects this child may choose."),
  acceptanceCriteria: z.array(z.string()).default([]).describe("Observable conditions that prove this child is complete."),
  coveredCriteria: z.array(z.number().int().nonnegative()).default([]).describe("Positions (0-based) of the parent success criteria this child addresses."),
});

export const SolutionDeltaSchema = z.object({
  region: z.object({
    objective: z.string().optional().describe("The goal to decide or deliver. Inspectors must omit this field entirely — never restate the assigned goal."),
    delivery: z.enum(["answer", "change"]).optional().describe("Use 'answer' only when the user needs an answer without file changes. Otherwise use 'change'."),
    allowedVariables: z.array(z.string()).optional().describe("The only aspects that may be chosen here."),
    acceptanceCriteria: z.array(z.string()).optional().describe("Observable conditions that prove the goal is complete."),
  }).optional().describe("Use only to clarify the current goal or its success criteria."),
  evidence: z.array(z.object({ text: z.string().min(1), source: z.string().min(1), kind: z.enum(["repository", "tool", "inference", "user"]).default("inference") })).default([]).describe("Facts used in this result. State each fact plainly and identify where it came from."),
  variables: z.array(z.object({
    name: z.string().min(1).describe("A short stable name for a new shared choice that several moves depend on, e.g. 'http-client'. Declare it only when moves genuinely differ on it; reuse the established name instead of inventing a variant."),
    seedLabels: z.array(z.string()).default([]).describe("Options already known for this choice, stated exactly. Informational; new options may still appear later."),
  })).default([]).describe("New shared choices declared at this decision level. Leave empty unless one is genuinely needed."),
  candidates: z.array(z.object({
    key: z.string().min(1).describe("A short stable name for this alternative."),
    proposition: z.string().min(1).describe("The complete approach this alternative proposes."),
    outcome: z.enum(["possible", "eliminated", "selected"]).default("possible").describe("Whether this alternative remains possible, is rejected, or is chosen. Interchangeability is derived from 'equivalent' constraints, never declared here."),
    reasons: z.array(z.string()).default([]).describe("For a rejected alternative, explain why it should not be chosen. Do not put supporting facts here."),
    evidenceRefs: z.array(z.string()).default([]).describe("References to facts that justify the stated outcome."),
    stances: z.array(z.object({
      variable: z.string().min(1).describe("Name of a shared choice declared for this goal or inherited from an earlier one."),
      relation: z.enum(["requires", "excludes", "prefers"]).describe("'requires' = this move is viable only with that option. 'excludes' = this move cannot coexist with that option. 'prefers' = when nothing else distinguishes moves, favor that option."),
      valueLabel: z.string().min(1).describe("The option itself. Reuse the exact established spelling of an existing option instead of paraphrasing it."),
    })).default([]).describe("How this move positions on shared choices. Omit when the move touches none."),
  })).default([]).describe("Complete alternatives to the same choice. They must not be combined, and exactly one should be chosen. Put independent deliverables under the chosen alternative as 'partOf' children, not as competing alternatives."),
  constraints: z.array(z.object({
    kind: z.enum(["requires", "excludes", "supports", "refutes", "equivalent"]),
    subject: z.string().min(1).describe("Key or reference of the item this statement is about."),
    target: z.string().min(1).describe("Key or reference of the related item. For 'refutes' this may also be a shared choice with an option, written as choiceName:option."),
    reason: z.string().default("").describe("Why this relationship is true, using supplied facts."),
    evidenceRefs: z.array(z.string()).default([]).describe("Facts backing this statement. Required when refuting a shared choice option; an uncited refutation of a shared choice is rejected."),
    sourceKind: z.enum(["user-task", "repo-evidence", "model-inference"]).default("model-inference").describe("Where this relationship comes from: stated by the user, grounded in repository facts, or inferred while comparing alternatives."),
  })).default([]).describe("Relationships between referenced items: 'requires' means one needs another; 'excludes' means they cannot coexist; 'supports' means one strengthens another; 'refutes' means one contradicts another; 'equivalent' means they are interchangeable."),
  select: z.array(z.string()).default([]).describe("Keys or references of the chosen alternative. Choose one, except that interchangeable alternatives may be selected together."),
  answer: z.string().optional().describe("Answer text for a goal already marked as answer-only."),
  resolvedAnswer: z.object({
    answer: z.string().min(1).describe("The complete answer to give the user."),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).describe("Conditions showing that this answer fully satisfies the request."),
    evidenceRefs: z.array(z.string()).default([]).describe("References to facts that support the answer. Cite at least one existing fact or a fact supplied with this result; an uncited answer is rejected."),
  }).optional().describe("Use only when the user's request can be fully answered without changing files."),
  activations: z.array(z.object({
    capability: z.enum(["inspect", "synthesize", "refine", "implement", "verify", "present"]).describe("The kind of help needed."),
    regionId: z.string().optional().describe("The supplied goal reference. Omit it to use the current goal."),
    request: z.string().min(1).describe("One specific task for the requested helper."),
    expectedDelta: z.string().min(1).describe("A short stable name for the expected new information or work. It prevents duplicate requests."),
    contextRefs: z.array(z.string()).default([]).describe("References the helper needs to see."),
  })).default([]).describe("Requests for another helper. Leave empty unless one missing fact or proven conflict prevents your assigned work."),
});
export type SolutionDelta = z.infer<typeof SolutionDeltaSchema>;

export const RefinementOutputSchema = z.object({
  evidence: SolutionDeltaSchema.shape.evidence,
  children: z.array(ChildRegionSchema).default([]).describe("Next conditional work regions that together cover every criterion."),
  activations: SolutionDeltaSchema.shape.activations,
}).strict();
export type RefinementOutput = z.infer<typeof RefinementOutputSchema>;

export const ImplementationOutputSchema = z.object({
  status: z.enum(["completed", "already-satisfied", "blocked"]),
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
  stateVersion: 7;
  runId: string;
  originalTask: string;
  conversationContext: string;
  directory: string;
  worktree: string;
  phase: string;
  activeActivationId?: string;
  activeBatch: ActiveBatchEntry[];
  network: SolutionNetwork;
  results: ActivationTaskResult[];
  usage: AgentUsage;
  callsUsed: number;
  startedAt: number;
  result: string;
}
