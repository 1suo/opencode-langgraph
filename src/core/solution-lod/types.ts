import { z } from "zod";
import type { AgentCallLimits, AgentRetryTrace, AgentToolTrace, AgentUsage } from "../types.js";

export type Capability = "inspect" | "synthesize" | "refine" | "implement" | "verify" | "present";
export type SynthesisOperation = "generate-domain" | "challenge-domain" | "select-candidate";
export type DomainPhase = "ungenerated" | "inspecting" | "challenging" | "selecting" | "selected" | "blocked";
export type ChallengeVerdict = "accept" | "counterexample" | "needs-fact";
export type ScopeId = `scope:${string}`;
export type CriterionId = `criterion:${string}`;
export type RequirementId = `requirement:${string}`;
export type ContextRefKind = "task" | "region" | "candidate" | "evidence" | "constraint" | "artifact" | "activation" | "coordinate";
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
  requirementIds?: RequirementId[];
  dependencyScopeIds?: ScopeId[];
  mutationResources?: string[];
  unresolvedVariable?: string;
}

export interface LeafCheck {
  criterionId: CriterionId;
  commandOrObservation: string;
}

export interface CertifiedLeaf {
  criterionIds: CriterionId[];
  implementationScope: string;
  evidenceRefs: string[];
  mutationResources: string[];
  checks: LeafCheck[];
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
  createdRevision?: number;
  sourceActivationId?: string;
  historical?: boolean;
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
  scopeId: ScopeId;
  criterionIds: CriterionId[];
  domainPhase: DomainPhase;
  domainFingerprint: string | null;
  acceptedFingerprint: string | null;
  cegarRound: number;
  challengeVerdict: ChallengeVerdict | null;
  noProgressFingerprint: string | null;
  noProgressCount: number;
  blockedReason?: string;
  certifiedLeaf?: CertifiedLeaf;
  requirementIds?: RequirementId[];
  dependencyScopeIds?: ScopeId[];
  mutationResources?: string[];
  definitionFingerprint?: string;
  selectionAge?: number;
  convergenceCycles?: SemanticCycleRecord[];
  blockedDetails?: { kind: string; fingerprints?: string[]; unresolvedCriterionIds?: CriterionId[]; unresolvedScopeIds?: ScopeId[] };
}

export type SemanticCycleKind = "present" | "repair" | "verify" | "reopen";
export interface SemanticCycleRecord {
  kind: SemanticCycleKind;
  inputFingerprint: string;
  outputFingerprint: string;
  unresolvedCriterionIds: CriterionId[];
  revision: number;
}

export interface MaterialRequirement {
  id: RequirementId;
  key: string;
  text: string;
  scopeId: ScopeId;
  criterionId: CriterionId;
}

export type TaskDispositionKind = "conflicting" | "external" | "speculative";
export interface TaskDisposition {
  key: string;
  request: string;
  disposition: TaskDispositionKind;
  reason: string;
  evidenceRefs: string[];
}

export interface SolutionEvidence {
  id: string;
  text: string;
  source: string;
  kind: "repository" | "tool" | "inference" | "user";
  /** Inference starts as a hypothesis; only confirmed evidence may justify pruning. */
  status?: "hypothesis" | "confirmed" | "rejected";
  validationKind?: "repository-evidence" | "tool-evidence" | "user-confirmation";
  validationEvidenceRefs?: string[];
  validationReason?: string;
  fingerprint: string;
  createdRevision?: number;
}

export interface ClaimValidation {
  claimRef: string;
  verdict: "confirmed" | "rejected" | "unresolved";
  evidenceRefs: string[];
  reason: string;
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
  historical?: boolean;
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
  createdRevision?: number;
  historical?: boolean;
}

export interface SolutionArtifact {
  id: string;
  regionId: string;
  kind: "file" | "check" | "answer" | "completion-review";
  path?: string;
  summary: string;
  passed?: boolean;
  activationId: string;
  createdRevision?: number;
  historical?: boolean;
  implementationOutcome?: "changed" | "already-satisfied";
  criterionIds?: CriterionId[];
  focusedTests?: string[];
  fullChecks?: string[];
  todoDisposition?: string;
  findings?: CorrectnessReviewFinding[];
}

export interface CorrectnessReviewFinding {
  criterionId: CriterionId;
  regionId: string;
  severity: "low" | "medium" | "high";
  files: string[];
  problem: string;
  regressionCriterion: string;
  evidence: string;
  repairRegionId?: string;
}

export interface ActivationReadRef {
  ref: string;
  kind: ContextRefKind;
  revision: number;
  fingerprint: string;
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
  operation?: SynthesisOperation;
  domainFingerprint?: string | null;
  idempotencyKey?: string;
  readRefs?: ActivationReadRef[];
  mutationResources?: string[];
  queuedAt?: number;
  recovery?: {
    sessionId: string;
    strategy: "continue" | "fork";
    attempts: number;
    failureKind: "transport" | "inactivity";
    contextFingerprint: string;
    retryTrace: AgentRetryTrace[];
  };
  historical?: boolean;
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
  | { kind: "synthesis"; output: SynthesisOutput }
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
  /** Cheap prompt/repair telemetry recorded without another model call. */
  promptChars?: number;
  validationFailures?: string[];
  operation?: SynthesisOperation;
  domainSize?: number;
  failureKind?: "startup" | "transport" | "inactivity" | "schema" | "semantic";
  tools?: AgentToolTrace[];
  progressText?: string;
  retryable?: boolean;
  retries?: number;
  retryTrace?: AgentRetryTrace[];
}

/** The unified snapshot a `Send` carries into one parallel `activate` task. */
export interface ActivationTaskInput {
  kind: "activation-task";
  activation: Activation;
  snapshot: {
    stateVersion: 8;
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
  materialRequirements?: MaterialRequirement[];
  taskDispositions?: TaskDisposition[];
  telemetry?: SolutionTelemetry;
}

export interface RegionTelemetry {
  operationCalls: Partial<Record<Capability | SynthesisOperation, number>>;
  promptChars: number;
  validationFailures: number;
  repairAttempts: number;
  retries: number;
  domainSizes: number[];
  noProgressFingerprints: string[];
  elapsedMs: number;
  queueMs: number;
  roleMs: Partial<Record<Capability, number>>;
  blockedReasons: string[];
}

export interface SolutionTelemetry {
  activations: number;
  operationCalls: Partial<Record<Capability | SynthesisOperation, number>>;
  counterexampleRepairs: number;
  retries: number;
  reopens: number;
  cycles: number;
  candidates: number;
  regionCount: number;
  promptChars: number;
  projectedContextChars: number;
  validationFailures: number;
  elapsedMs: number;
  queueMs: number;
  roleMs: Partial<Record<Capability, number>>;
  implementationMs: number;
  verificationMs: number;
  usage: AgentUsage;
  blockedReasons: string[];
  regions: Record<string, RegionTelemetry>;
}

export interface SolutionRunLimits {
  maxElapsedMs?: number;
  maxCost?: number;
  maxRetries?: number;
  maxReopens?: number;
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
  requirementIds: z.array(z.string()).optional(),
  dependencyScopeIds: z.array(z.string()).optional(),
  mutationResources: z.array(z.string()).optional(),
  unresolvedVariable: z.string().optional().describe("Required for refines: the exact supplied allowed variable that remains unresolved in this child."),
});

const EvidenceSchema = z.object({
  text: z.string().min(1), source: z.string().min(1), kind: z.enum(["repository", "tool", "inference", "user"]).default("inference"),
}).strict();
const StanceSchema = z.object({
  variable: z.string().min(1), relation: z.enum(["requires", "excludes", "prefers"]), valueLabel: z.string().min(1),
}).strict();
const GeneratedCandidateSchema = z.object({
  key: z.string().min(1), proposition: z.string().min(1), evidenceRefs: z.array(z.string()).default([]), stances: z.array(StanceSchema).default([]),
}).strict();
const ConstraintSchema = z.object({
  kind: z.enum(["requires", "excludes", "supports", "refutes", "equivalent"]), subject: z.string().min(1), target: z.string().min(1), reason: z.string().default(""), evidenceRefs: z.array(z.string()).default([]), sourceKind: z.enum(["user-task", "repo-evidence", "model-inference"]).default("model-inference"),
}).strict();
const ActivationRequestSchema = z.object({
  capability: z.enum(["inspect", "synthesize", "refine", "implement", "verify", "present"]), regionId: z.string().optional(), request: z.string().min(1), expectedDelta: z.string().min(1), contextRefs: z.array(z.string()).default([]),
}).strict();

export const DomainGenerationOutputSchema = z.object({
  operation: z.literal("generate-domain"),
  evidence: z.array(EvidenceSchema).default([]),
  variables: z.array(z.object({ name: z.string().min(1), seedLabels: z.array(z.string()).default([]) }).strict()).default([]),
  candidates: z.array(GeneratedCandidateSchema).min(2).max(7),
  constraints: z.array(ConstraintSchema).default([]),
}).strict();
export type DomainGenerationOutput = z.infer<typeof DomainGenerationOutputSchema>;

export const DomainChallengeOutputSchema = z.discriminatedUnion("verdict", [
  z.object({ operation: z.literal("challenge-domain"), verdict: z.literal("accept"), domainFingerprint: z.string().min(1), viableCandidateIds: z.array(z.string()).min(1) }).strict(),
  z.object({ operation: z.literal("challenge-domain"), verdict: z.literal("counterexample"), domainFingerprint: z.string().min(1), candidate: GeneratedCandidateSchema, reason: z.string().min(1), evidenceRefs: z.array(z.string()).default([]) }).strict(),
  z.object({ operation: z.literal("challenge-domain"), verdict: z.literal("needs-fact"), domainFingerprint: z.string().min(1), request: z.string().min(1), expectedDelta: z.string().min(1), contextRefs: z.array(z.string()).default([]) }).strict(),
]);
export type DomainChallengeOutput = z.infer<typeof DomainChallengeOutputSchema>;

const PreferenceValueSchema = z.enum(["preferred", "neutral", "disfavored"]);
export const CandidateSelectionOutputSchema = z.object({
  operation: z.literal("select-candidate"),
  domainFingerprint: z.string().min(1),
  basis: z.enum(["only-viable", "lexicographic", "needs-fact", "hard-constraint"]),
  comparisons: z.array(z.object({
    candidateId: z.string().min(1), userPreference: PreferenceValueSchema, repositoryCompatibility: PreferenceValueSchema, changeScope: PreferenceValueSchema, irreversibleRisk: PreferenceValueSchema, evidenceRefs: z.array(z.string()).default([]),
  }).strict()).min(1),
  selectedCandidateId: z.string().optional(),
  hardConstraints: z.array(ConstraintSchema).default([]),
  inspectionRequest: z.object({ request: z.string().min(1), expectedDelta: z.string().min(1), contextRefs: z.array(z.string()).default([]) }).strict().optional(),
}).strict();
export type CandidateSelectionOutput = z.infer<typeof CandidateSelectionOutputSchema>;
export type SynthesisOutput = DomainGenerationOutput | DomainChallengeOutput | CandidateSelectionOutput;

export const SolutionDeltaSchema = z.object({
  region: z.object({
    objective: z.string().optional().describe("The goal to decide or deliver. Inspectors must omit this field entirely — never restate the assigned goal."),
    delivery: z.enum(["answer", "change"]).optional().describe("Only settable together with a complete resolvedAnswer, and only after every implementation alternative is settled; a change goal may not be quietly downgraded to Q&A."),
    allowedVariables: z.array(z.string()).optional().describe("The only aspects that may be chosen here."),
    acceptanceCriteria: z.array(z.string()).optional().describe("Observable conditions that prove the goal is complete."),
  }).optional().describe("Use only to clarify the current goal or its success criteria."),
  evidence: z.array(z.object({
    text: z.string().min(1), source: z.string().min(1), kind: z.enum(["repository", "tool", "inference", "user"]).default("inference"),
  })).default([]).describe("New claims used in this result. Inference always enters as an unconfirmed hypothesis. Only inspection may report repository/tool observations, which enter as confirmed evidence. Model output may not create user evidence; cite the immutable task reference instead."),
  factIds: z.array(z.string().min(1)).default([]).describe("Existing supplied graph fact IDs relevant to this result. Reuse these instead of repeating their text and source in evidence."),
  validations: z.array(z.object({
    claimRef: z.string().min(1).describe("Existing hypothesis id being checked."),
    verdict: z.enum(["confirmed", "rejected", "unresolved"]),
    evidenceRefs: z.array(z.string()).default([]).describe("Confirmed repository/tool/user evidence proving confirmed or rejected. Use existing ids or sources supplied in this result."),
    reason: z.string().min(1),
  })).optional().describe("Kernel-checked validation results for existing hypotheses. Confirmed/rejected require independent evidence; unresolved has no effect."),
  variables: z.array(z.object({
    name: z.string().min(1).describe("A short stable name for a new shared choice that several moves depend on, e.g. 'http-client'. Declare it only when moves genuinely differ on it; reuse the established name instead of inventing a variant."),
    seedLabels: z.array(z.string()).default([]).describe("Options already known for this choice, stated exactly. Informational; new options may still appear later."),
  })).default([]).describe("New shared choices declared at this decision level. Leave empty unless one is genuinely needed."),
  candidates: z.array(z.object({
    key: z.string().min(1).describe("A short stable name for this alternative."),
    proposition: z.string().min(1).describe("The complete approach this alternative proposes."),
    outcome: z.enum(["possible", "eliminated", "selected"]).default("possible").describe("Legacy proposed disposition. 'selected' is rejected outside select-candidate. Use 'eliminated' only with a confirmed-evidence refutation; the kernel stores the candidate as possible and derives elimination."),
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
  select: z.array(z.string()).default([]).describe("Legacy transport field. Model-authored selection is rejected; only select-candidate may commit a family."),
  answer: z.string().optional().describe("Answer text for a goal already marked as answer-only."),
  resolvedAnswer: z.object({
    answer: z.string().min(1).describe("The complete answer to give the user."),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).describe("Conditions showing that this answer fully satisfies the request."),
    evidenceRefs: z.array(z.string()).default([]).describe("References to facts that support the answer. Cite at least one existing fact or a fact supplied with this result; an uncited answer is rejected."),
  }).optional().describe("Use only when the user's request can be fully answered without changing files. On a change goal, first settle the solution space through select-candidate or evidence-backed elimination and cite the task reference in evidenceRefs."),
  taskScopes: z.array(z.object({
    key: z.string().min(1), objective: z.string().min(1), delivery: z.enum(["answer", "change"]).default("change"), allowedVariables: z.array(z.string()).default([]), acceptanceCriteria: z.array(z.string().min(1)).min(1), requirementKeys: z.array(z.string()).optional(), dependencyScopeIds: z.array(z.string()).optional(), mutationResources: z.array(z.string()).optional(),
  }).strict()).optional().describe("Inspector-only root AND decomposition for two or more independently verifiable material tasks."),
  taskDispositions: z.array(z.object({ key: z.string().min(1), request: z.string().min(1), disposition: z.enum(["conflicting", "external", "speculative"]), reason: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1) }).strict()).optional().describe("Explicit evidence-backed disposition only for requested items that cannot become aligned root partOf scopes. Never use this to choose a subset of aligned deliverables."),
  materialRequirements: z.array(z.object({ key: z.string().min(1), text: z.string().min(1), criterion: z.string().min(1) }).strict()).optional().describe("Immutable typed inventory of material root requirements, each bound to one exact observable criterion, authored once during root inspection."),
  certifiedVerdict: z.object({ proposition: z.string().min(1), implementationScope: z.string().min(1), evidenceRefs: z.array(z.string()).min(1), mutationResources: z.array(z.string().min(1)).min(1) }).strict().optional().describe("Mechanically fixed small correction whose exact repository evidence, implementation scope, and mutation paths leave no genuine solution choice."),
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
  certifiedLeaf: z.object({
    implementationScope: z.string().min(1),
    criterionIds: z.array(z.string().min(1)).min(1),
    evidenceRefs: z.array(z.string()).default([]),
    mutationResources: z.array(z.string().min(1)).default([]),
    checks: z.array(z.object({ criterionId: z.string().min(1), commandOrObservation: z.string().min(1) }).strict()).min(1),
  }).strict().optional(),
  activations: SolutionDeltaSchema.shape.activations,
}).strict();
export type RefinementOutput = z.infer<typeof RefinementOutputSchema>;

export const ImplementationOutputSchema = z.object({
  status: z.enum(["completed", "already-satisfied", "blocked"]),
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string().default("") })).default([]),
  todoDisposition: z.string().optional(),
  blocker: z.string().optional(),
  activations: SolutionDeltaSchema.shape.activations,
});
export type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;

export const VerificationOutputSchema = z.object({
  verdict: z.enum(["pass", "repair", "reopen", "fail"]),
  summary: z.string().default(""),
  findings: z.array(z.object({ criterionId: z.string().min(1), regionId: z.string(), severity: z.enum(["low", "medium", "high"]), files: z.array(z.string().min(1)).min(1), problem: z.string(), regressionCriterion: z.string().min(1), evidence: z.string().min(1), repairRegionId: z.string().min(1).optional() }).strict()).default([]),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string().default("") })).default([]),
  completionEvidence: z.object({ implementationOutcome: z.enum(["changed", "already-satisfied"]).optional(), implementation: z.string().min(1), directTest: z.string().min(1), correctnessReview: z.string().min(1), releaseGate: z.string().min(1), changedFiles: z.array(z.string().min(1)), focusedTests: z.array(z.string().min(1)).min(1), fullChecks: z.array(z.string().min(1)).min(1), criterionIds: z.array(z.string().min(1)).optional(), inspectionEvidenceRefs: z.array(z.string().min(1)).default([]), todoDisposition: z.string().optional() }).strict().optional(),
  activations: SolutionDeltaSchema.shape.activations,
});
export type VerificationOutput = z.infer<typeof VerificationOutputSchema>;

export const PresentationOutputSchema = z.object({ answer: z.string().min(1) });

export interface SolutionLodState extends Record<string, unknown> {
  stateVersion: 8;
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
