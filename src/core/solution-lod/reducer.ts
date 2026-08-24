import { createHash } from "node:crypto";
import type { Activation, ActivationReadRef, ActivationTaskResult, CandidateSelectionOutput, Capability, CandidateStance, ContextRefKind, CriterionId, DecisionVariable, DomainChallengeOutput, DomainGenerationOutput, ImplementationOutput, RefinementOutput, RequirementId, ScopeId, SemanticCycleKind, SolutionCandidate, SolutionConstraint, SolutionDelta, SolutionLodState, SolutionNetwork, SolutionRegion, SolutionTelemetry, StanceRelation, SynthesisOperation, SynthesisOutput, VerificationOutput } from "./types.js";

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const slug = (value: string) => normalize(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "candidate";
const propositionSignature = (value: string) => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const SAME_REVISION_RETRY_POLICY = { maxAttempts: 3 } as const;
export const MAX_CEGAR_ROUNDS = 2;
export const MAX_DOMAIN_CANDIDATES = 7;
export const MAX_NO_PROGRESS_CYCLES = 2;
export const MAX_SEMANTIC_CYCLES = 2;
const DEFERRED_WORK = /\b(?:estimate|eta|hours?|days?|weeks?|later|defer(?:red)?|follow[- ]?up|future work|optional(?:ly)?)\b/i;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const EMPTY_USAGE = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const emptyTelemetry = (): SolutionTelemetry => ({ activations: 0, operationCalls: {}, counterexampleRepairs: 0, retries: 0, reopens: 0, cycles: 0, candidates: 0, regionCount: 0, promptChars: 0, projectedContextChars: 0, validationFailures: 0, elapsedMs: 0, queueMs: 0, roleMs: {}, implementationMs: 0, verificationMs: 0, usage: { ...EMPTY_USAGE }, blockedReasons: [], regions: {} });
function rejectUnrequestedDeferredWork(state: Pick<SolutionLodState, "originalTask">, values: Array<string | undefined>): void {
  if (/\b(?:estimate|eta|how long|time|effort|hours?|days?|weeks?)\b/i.test(state.originalTask)) return;
  const rejected = values.find((value) => value && DEFERRED_WORK.test(value));
  if (rejected) throw new Error(`Unrequested estimate, optionalization, or deferred work is not a valid authored result: "${normalize(rejected)}".`);
}
export const taskReferencesTodo = (task: string) => /\bTODO\b/.test(task);

export function initialNetwork(task: string): SolutionNetwork {
  return {
    revision: 0, nextRegionId: 2, nextEvidenceId: 1, nextConstraintId: 1, nextActivationId: 2, nextArtifactId: 1, nextVariableId: 1,
    regions: [{ id: "r1", key: "root", edge: "root", lod: 0, objective: task, delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: [], status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: ["a1"], artifactIds: [], scopeId: "scope:r1", criterionIds: [], domainPhase: "inspecting", domainFingerprint: null, acceptedFingerprint: null, cegarRound: 0, challengeVerdict: null, noProgressFingerprint: null, noProgressCount: 0, requirementIds: [], dependencyScopeIds: [], mutationResources: [], selectionAge: 0 }],
    candidates: [], constraints: [], evidence: [], artifacts: [],
    activations: [{ id: "a1", capability: "inspect", regionId: "r1", request: "Find repository facts needed to distinguish the broad solution types. Investigate lower-level details when they affect that choice, but do not turn them into choices yet.", expectedDelta: "coarse-domain:r1", contextRefs: ["r1"], status: "queued", basisRevision: 0, idempotencyKey: hash(["inspect", "", "r1", "coarse-domain:r1"]), readRefs: [], mutationResources: [], queuedAt: Date.now() }],
    variables: [], materialRequirements: [], taskDispositions: [], telemetry: emptyTelemetry(),
  };
}

function cloneNetwork(network: SolutionNetwork): SolutionNetwork {
  return {
    ...network,
    regions: network.regions.map((item) => ({ ...item, allowedVariables: [...item.allowedVariables], acceptanceCriteria: [...item.acceptanceCriteria], criterionIds: [...(item.criterionIds ?? [])], candidateIds: [...item.candidateIds], selectedCandidateIds: [...item.selectedCandidateIds], constraintIds: [...item.constraintIds], evidenceIds: [...item.evidenceIds], activationIds: [...item.activationIds], artifactIds: [...item.artifactIds], coveredCriteria: item.coveredCriteria ? [...item.coveredCriteria] : undefined, requirementIds: [...(item.requirementIds ?? [])], dependencyScopeIds: [...(item.dependencyScopeIds ?? [])], mutationResources: [...(item.mutationResources ?? [])], convergenceCycles: item.convergenceCycles?.map((cycle) => ({ ...cycle, unresolvedCriterionIds: [...cycle.unresolvedCriterionIds] })), blockedDetails: item.blockedDetails ? structuredClone(item.blockedDetails) : undefined, certifiedLeaf: item.certifiedLeaf ? { ...item.certifiedLeaf, criterionIds: [...item.certifiedLeaf.criterionIds], evidenceRefs: [...item.certifiedLeaf.evidenceRefs] } : undefined })),
    candidates: network.candidates.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds], declaredEvidenceIds: item.declaredEvidenceIds ? [...item.declaredEvidenceIds] : undefined, eliminationReasons: [...item.eliminationReasons], declaredEliminationReasons: item.declaredEliminationReasons ? [...item.declaredEliminationReasons] : undefined, stances: (item.stances ?? []).map((stance) => ({ ...stance })) })),
    constraints: network.constraints.map((item) => ({ ...item })), evidence: network.evidence.map((item) => ({ ...item, validationEvidenceRefs: item.validationEvidenceRefs ? [...item.validationEvidenceRefs] : undefined })), activations: network.activations.map((item) => ({ ...item, contextRefs: [...item.contextRefs], readRefs: item.readRefs?.map((ref) => ({ ...ref })), mutationResources: [...(item.mutationResources ?? [])], recovery: item.recovery ? { ...item.recovery, retryTrace: item.recovery.retryTrace?.map((trace) => ({ ...trace })) } : undefined })), artifacts: network.artifacts.map((item) => ({ ...item })),
    variables: network.variables.map((item) => ({ ...item, seedLabels: [...(item.seedLabels ?? [])] })), materialRequirements: network.materialRequirements?.map((item) => ({ ...item })) as SolutionNetwork["materialRequirements"], taskDispositions: network.taskDispositions?.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] })), telemetry: network.telemetry ? structuredClone(network.telemetry) : emptyTelemetry(),
  };
}

function candidateId(regionId: string, key: string): string {
  const normalized = normalize(key);
  return normalized.startsWith(`${regionId}:`) ? `${regionId}:${slug(normalized.slice(regionId.length + 1))}` : `${regionId}:${slug(normalized)}`;
}
function candidateRef(network: SolutionNetwork, regionId: string, ref: string): string {
  if (knownRef(network, ref)) return ref;
  return candidateId(regionId, ref);
}

function candidateSignature(proposition: string, stances: readonly CandidateStance[]): string {
  return JSON.stringify([
    propositionSignature(proposition),
    stances.map((stance) => [stance.variableId, stance.relation, slug(stance.valueLabel)]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]);
}

/** Unconditional hard consequences. Commitment-dependent excludes/refutes belong to propagation, not domain viability. */
function hardEliminations(network: SolutionNetwork): Map<string, Set<string>> {
  const eliminated = new Map<string, Set<string>>();
  const refutedCoordinates = new Map<string, Set<string>>();
  const candidateIds = new Set(network.candidates.map((item) => item.id));
  const confirmed = (ref: string) => ref === "task" || isConfirmedEvidence(network, ref);
  const grounded = (constraint: SolutionConstraint) => constraint.evidenceRefs.every(confirmed)
    && (!network.evidence.some((item) => item.id === constraint.subject) || confirmed(constraint.subject));
  const add = (id: string, reason: string) => {
    if (!candidateIds.has(id)) return;
    if (!eliminated.has(id)) eliminated.set(id, new Set());
    eliminated.get(id)!.add(reason);
  };
  for (const constraint of network.constraints) {
    if (constraint.kind !== "refutes" || candidateIds.has(constraint.subject) || !grounded(constraint)) continue;
    const reason = constraint.reason || "refuted by confirmed evidence";
    const coordinate = coordinateOf(network, constraint.target);
    if (!coordinate) add(constraint.target, reason);
    else {
      if (!constraint.evidenceRefs.length) continue;
      const key = `${coordinate.variableId}\0${slug(coordinate.valueLabel)}`;
      if (!refutedCoordinates.has(key)) refutedCoordinates.set(key, new Set());
      refutedCoordinates.get(key)!.add(reason);
    }
  }
  for (const candidate of network.candidates) {
    for (const stance of candidate.stances ?? []) {
      if (stance.relation !== "requires") continue;
      const reasons = refutedCoordinates.get(`${stance.variableId}\0${slug(stance.valueLabel)}`);
      for (const reason of reasons ?? []) add(candidate.id, reason);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const constraint of network.constraints) {
      if (constraint.kind !== "requires" || !eliminated.has(constraint.target) || eliminated.has(constraint.subject)) continue;
      add(constraint.subject, constraint.reason || `requires ${constraint.target}, which is unavailable`);
      changed = true;
    }
  }
  return eliminated;
}

export function domainFingerprint(network: SolutionNetwork, regionId: string): string | null {
  const region = network.regions.find((item) => item.id === regionId);
  if (!region || !region.candidateIds.length) return null;
  const hardEliminated = hardEliminations(network);
  const evidenceToken = (id: string) => id === "task" ? "task" : (() => { const item = network.evidence.find((entry) => entry.id === id); return item ? `${item.fingerprint}:${item.status ?? (item.kind === "inference" ? "hypothesis" : "confirmed")}:${item.kind}` : `missing:${id}`; })();
  const candidates = region.candidateIds.map((id) => network.candidates.find((item) => item.id === id)).filter((item): item is SolutionCandidate => Boolean(item)).map((item) => ({
    id: item.id,
    proposition: propositionSignature(item.proposition),
    stances: [...(item.stances ?? [])].map((stance) => [stance.variableId, stance.relation, slug(stance.valueLabel)]).sort(),
    evidence: [...new Set((item.declaredEvidenceIds ?? item.evidenceIds).map(evidenceToken))].sort(),
    viable: !hardEliminated.has(item.id),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const localCandidateIds = new Set(region.candidateIds);
  const constraints = network.constraints.filter((item) => region.constraintIds.includes(item.id) || localCandidateIds.has(item.subject) || localCandidateIds.has(item.target)).map((item) => ({ kind: item.kind, subject: network.evidence.some((evidence) => evidence.id === item.subject) ? evidenceToken(item.subject) : item.subject, target: item.target, reason: normalize(item.reason), sourceKind: item.sourceKind, evidenceRefs: [...item.evidenceRefs].map(evidenceToken).sort() })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify({ boundary: { objective: normalize(region.objective), allowedVariables: [...region.allowedVariables].sort(), criteria: [...region.acceptanceCriteria].map(normalize).sort() }, candidates, constraints })).digest("hex").slice(0, 24);
}

function accepted(network: SolutionNetwork, region: SolutionRegion): boolean {
  const fingerprint = domainFingerprint(network, region.id);
  return Boolean(fingerprint && region.acceptedFingerprint === fingerprint);
}

const LEGAL_REGION_TRANSITIONS: Record<SolutionRegion["status"], SolutionRegion["status"][]> = {
  unformed: ["unformed", "superposed", "collapsed", "actionable", "implemented", "contradiction", "blocked", "stalled"], superposed: ["unformed", "superposed", "unrefined", "collapsed", "actionable", "implemented", "contradiction", "blocked", "stalled"], unrefined: ["unformed", "unrefined", "collapsed", "actionable", "implemented", "superposed", "contradiction", "blocked", "stalled"], collapsed: ["unformed", "collapsed", "superposed", "verified", "contradiction", "blocked", "stalled"], actionable: ["unformed", "actionable", "implementing", "implemented", "superposed", "contradiction", "blocked", "stalled"], implementing: ["unformed", "implementing", "implemented", "actionable", "superposed", "contradiction", "blocked", "stalled"], implemented: ["unformed", "implemented", "verified", "actionable", "superposed", "contradiction", "blocked", "stalled"], verified: ["unformed", "verified", "actionable", "superposed", "contradiction", "blocked", "stalled"], contradiction: ["unformed", "contradiction", "superposed", "unrefined", "collapsed", "actionable", "implemented", "blocked", "stalled"], blocked: ["blocked", "superposed", "unformed", "actionable", "contradiction", "stalled"], stalled: ["stalled", "superposed", "unformed", "contradiction"],
};

/** The only production authority for region lifecycle changes. */
function transitionRegion(region: SolutionRegion, phase: SolutionRegion["domainPhase"], blockedReason?: string, status?: SolutionRegion["status"]): void {
  const nextStatus = status ?? (phase === "blocked" ? "blocked" : undefined);
  if (nextStatus && !LEGAL_REGION_TRANSITIONS[region.status].includes(nextStatus)) throw new Error(`Illegal region transition ${region.id}: ${region.status} -> ${nextStatus}`);
  region.domainPhase = phase;
  if (nextStatus) region.status = nextStatus;
  region.blockedReason = blockedReason;
  if (phase === "blocked") {
    region.contradiction = blockedReason;
    region.blockedDetails ??= { kind: "workflow", fingerprints: [region.noProgressFingerprint].filter((item): item is string => Boolean(item)), unresolvedCriterionIds: [...region.criterionIds] };
  }
}

function refreshDomainControls(network: SolutionNetwork): boolean {
  let changed = false;
  for (const region of network.regions) {
    const fingerprint = domainFingerprint(network, region.id);
    if (region.domainFingerprint !== fingerprint) { region.domainFingerprint = fingerprint; changed = true; }
    if (region.acceptedFingerprint && region.acceptedFingerprint !== fingerprint) {
      region.acceptedFingerprint = null;
      region.challengeVerdict = null;
      const resolvedAnswer = network.candidates.find((item) => item.regionId === region.id && item.key === "resolved-answer" && region.delivery === "answer");
      transitionRegion(region, resolvedAnswer ? "selected" : region.candidateIds.length ? "challenging" : "ungenerated");
      region.selectedCandidateIds = resolvedAnswer ? [resolvedAnswer.id] : [];
      for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.declaredStatus === "selected" && item.id !== resolvedAnswer?.id)) { candidate.declaredStatus = "possible"; candidate.status = "possible"; }
      purgeDescendants(network, region.id);
      changed = true;
    }
  }
  for (const activation of network.activations) {
    if (activation.status !== "queued" || activationAdmitted(network, activation)) continue;
    activation.status = "superseded";
    activation.error = `Superseded: ${activation.operation ?? activation.capability} no longer matches its typed read-set, current phase, or fingerprint.`;
    changed = true;
  }
  return changed;
}
function knownRef(network: SolutionNetwork, ref: string): boolean {
  return Boolean(resolveContextReference(network, ref));
}

export interface ResolvedContextReference { ref: string; kind: ContextRefKind; revision: number; fingerprint: string; value: unknown }

export function resolveContextReference(network: SolutionNetwork, ref: string): ResolvedContextReference | undefined {
  let kind: ContextRefKind; let value: unknown; let revision = network.revision;
  if (ref === "task") { kind = "task"; value = { id: "task" }; revision = 0; }
  else {
    const region = network.regions.find((item) => item.id === ref);
    const candidate = network.candidates.find((item) => item.id === ref && !item.historical);
    const evidence = network.evidence.find((item) => item.id === ref);
    const constraint = network.constraints.find((item) => item.id === ref && !item.historical);
    const artifact = network.artifacts.find((item) => item.id === ref);
    const activation = network.activations.find((item) => item.id === ref && !item.historical);
    const coordinate = coordinateOf(network, ref);
    if (region) { kind = "region"; value = { id: region.id, objective: region.objective, criteria: region.acceptanceCriteria, candidateIds: region.candidateIds, constraintIds: region.constraintIds, evidenceIds: region.evidenceIds, artifactIds: region.artifactIds, domainFingerprint: region.domainFingerprint, acceptedFingerprint: region.acceptedFingerprint }; }
    else if (candidate) { kind = "candidate"; value = candidate; revision = candidate.createdRevision ?? network.revision; }
    else if (evidence) { kind = "evidence"; value = evidence; revision = evidence.createdRevision ?? network.revision; }
    else if (constraint) { kind = "constraint"; value = constraint; revision = constraint.createdRevision ?? network.revision; }
    else if (artifact) { kind = "artifact"; value = artifact; revision = artifact.createdRevision ?? network.revision; }
    else if (activation) { kind = "activation"; value = { id: activation.id, capability: activation.capability, operation: activation.operation, status: activation.status, expectedDelta: activation.expectedDelta }; }
    else if (coordinate) { kind = "coordinate"; value = coordinate; }
    else return undefined;
  }
  return { ref, kind, revision, value, fingerprint: hash(value) };
}

function activationReadRefs(network: SolutionNetwork, refs: string[]): ActivationReadRef[] {
  return [...new Set(refs)].sort().map((ref) => { const resolved = resolveContextReference(network, ref); if (!resolved) throw new Error(`Unknown activation context reference ${ref}.`); return { ref, kind: resolved.kind, revision: resolved.revision, fingerprint: resolved.fingerprint }; });
}

function activationReadsCurrent(network: SolutionNetwork, activation: Activation): boolean {
  return (activation.readRefs ?? activationReadRefs(network, activation.contextRefs)).every((read) => {
    const current = resolveContextReference(network, read.ref);
    return current?.kind === read.kind && current.revision === read.revision && current.fingerprint === read.fingerprint;
  });
}

export function activationContextFingerprint(activation: Pick<Activation, "idempotencyKey" | "readRefs">): string {
  return hash([activation.idempotencyKey ?? "", activation.readRefs ?? []]);
}

export function activationRecovery(matches: Activation[], operation: SynthesisOperation | undefined, idempotencyKey: string, readRefs: ActivationReadRef[]): Activation["recovery"] {
  if (operation === "challenge-domain") return undefined;
  const recovery = matches.find((item) => item.status === "failed" && item.recovery && item.idempotencyKey === idempotencyKey && item.recovery.contextFingerprint === activationContextFingerprint({ idempotencyKey, readRefs }))?.recovery;
  return recovery ? { ...recovery, retryTrace: recovery.retryTrace.map((trace) => ({ ...trace })) } : undefined;
}

/** A shared choice with an option, written `choiceName:option` or `vN:option` — the coordinate a refutation can target. */
export function knownCoordinate(network: SolutionNetwork, ref: string): boolean {
  return Boolean(coordinateOf(network, ref));
}

export interface SolutionCoordinate { variableId: string; variableName: string; valueLabel: string }

function coordinateOf(network: SolutionNetwork, ref: string): SolutionCoordinate | undefined {
  const index = ref.indexOf(":");
  if (index <= 0) return undefined;
  const variable = findVariable(network, ref.slice(0, index));
  const valueLabel = normalize(ref.slice(index + 1));
  if (!variable || !valueLabel) return undefined;
  return { variableId: variable.id, variableName: variable.name, valueLabel };
}

function findVariable(network: SolutionNetwork, ref: string): DecisionVariable | undefined {
  const name = slug(ref);
  return network.variables.find((item) => !item.historical && (item.id === ref || (name.length > 0 && item.name === name)));
}

function regionAncestryIds(network: SolutionNetwork, regionId: string): Set<string> {
  const ids = new Set<string>();
  let cursor = network.regions.find((item) => item.id === regionId);
  while (cursor) { ids.add(cursor.id); cursor = cursor.parentId ? network.regions.find((item) => item.id === cursor?.parentId) : undefined; }
  return ids;
}

/** Reject paraphrased duplicates of an established option so pruning cannot silently miss near-spellings. */
function canonicalLabel(network: SolutionNetwork, variableId: string, rawLabel: string): string {
  const normalized = normalize(rawLabel);
  if (!normalized) throw new Error("A shared-choice option must be stated plainly instead of left empty.");
  const variable = network.variables.find((item) => item.id === variableId);
  for (const established of variable?.seedLabels ?? []) {
    if (slug(established) === slug(normalized) && established !== normalized)
      throw new Error(`Reuse the established option spelling "${established}" instead of "${rawLabel}" — near-duplicate spellings would split one option into two.`);
  }
  for (const candidate of network.candidates) {
    for (const stance of candidate.stances ?? []) {
      if (stance.variableId !== variableId) continue;
      if (slug(stance.valueLabel) === slug(normalized) && stance.valueLabel !== normalized)
        throw new Error(`Reuse the established option spelling "${stance.valueLabel}" instead of "${rawLabel}" — near-duplicate spellings would split one option into two.`);
    }
  }
  return normalized;
}

/** Resolve authored stances against declared shared choices, enforcing visibility and canonical labels. */
function resolveStances(network: SolutionNetwork, regionId: string, stances: ReadonlyArray<{ variable: string; relation: StanceRelation; valueLabel: string }>): CandidateStance[] {
  const ancestry = regionAncestryIds(network, regionId);
  return stances.map((stance) => {
    const variable = findVariable(network, stance.variable);
    if (!variable) throw new Error(`Unknown shared choice "${stance.variable}". Declare it in this result's 'variables' field first, or use an established choice name.`);
    if (!ancestry.has(variable.ownerRegionId)) throw new Error(`Shared choice "${variable.name}" was declared at ${variable.ownerRegionId} and is not visible here — regions couple only through choices declared at or above them.`);
    return { variableId: variable.id, relation: stance.relation, valueLabel: canonicalLabel(network, variable.id, stance.valueLabel) };
  });
}

type ActivationInput = Omit<Activation, "id" | "status" | "basisRevision" | "idempotencyKey" | "readRefs"> & Partial<Pick<Activation, "idempotencyKey">>;

function addActivation(network: SolutionNetwork, input: ActivationInput): Activation | undefined {
  const contextRefs = [...new Set([input.regionId, ...input.contextRefs])];
  const readRefs = activationReadRefs(network, contextRefs);
  const idempotencyKey = input.idempotencyKey ?? hash([input.capability, input.operation ?? "", input.regionId, normalize(input.expectedDelta)]);
  const matches = network.activations.filter((item) => item.idempotencyKey === idempotencyKey || !item.idempotencyKey && hash([item.capability, item.operation ?? "", item.regionId, normalize(item.expectedDelta)]) === idempotencyKey);
  // Only activations whose outcome actually landed (or is still in flight) occupy their
  // signature. Failed and superseded attempts produced nothing, so they must free the
  // slot — otherwise a killed-and-resumed run deadlocks behind its own superseded record.
  const duplicate = matches.some((item) => item.status !== "failed" && item.status !== "superseded");
  const failedAttempts = network.activations.filter((item) => item.regionId === input.regionId && item.capability === input.capability && item.status === "failed" && item.basisRevision === network.revision).length;
  const region = network.regions.find((item) => item.id === input.regionId);
  if (duplicate || failedAttempts >= SAME_REVISION_RETRY_POLICY.maxAttempts || !region || input.contextRefs.some((ref) => !knownRef(network, ref)) || input.capability === "synthesize" && !input.operation) return undefined;
  if (input.capability === "implement" && region.status !== "actionable" || input.capability === "verify" && region.status !== "implemented" || input.capability === "present" && (region.status !== "actionable" || region.delivery !== "answer") || input.capability === "refine" && region.status !== "unrefined" || input.capability === "synthesize" && !["unformed", "superposed", "contradiction"].includes(region.status)) return undefined;
  const recovery = activationRecovery(matches, input.operation, idempotencyKey, readRefs);
  const activation: Activation = { ...input, id: `a${network.nextActivationId++}`, contextRefs, readRefs, idempotencyKey, mutationResources: [...new Set(input.mutationResources ?? region.mutationResources ?? [])].sort(), queuedAt: Date.now(), status: "queued", basisRevision: network.revision, ...(recovery ? { recovery: { ...recovery, retryTrace: recovery.retryTrace.map((trace) => ({ ...trace })) } } : {}) };
  network.activations.push(activation);
  network.regions.find((region) => region.id === input.regionId)?.activationIds.push(activation.id);
  return activation;
}

export function purgeDescendants(network: SolutionNetwork, regionId: string): boolean {
  const descendants = new Set<string>(); let expanded = true;
  while (expanded) { expanded = false; for (const item of network.regions) if (item.parentId && (item.parentId === regionId || descendants.has(item.parentId)) && !descendants.has(item.id)) { descendants.add(item.id); expanded = true; } }
  if (!descendants.size) return false;
  network.regions = network.regions.filter((item) => !descendants.has(item.id));
  const survivingRegionIds = new Set(network.regions.map((item) => item.id));
  network.candidates = network.candidates.filter((item) => survivingRegionIds.has(item.regionId));
  network.artifacts = network.artifacts.map((item) => survivingRegionIds.has(item.regionId) ? item : { ...item, historical: true });
  // Shared choices owned by removed regions die with them; nothing outside their subtree could see them anyway.
  network.variables = network.variables.filter((item) => survivingRegionIds.has(item.ownerRegionId));
  // Live activations of removed regions stay visible but can no longer land: their region is gone.
  network.activations = network.activations.map((item) => survivingRegionIds.has(item.regionId) ? item : { ...item, historical: true, status: item.status === "queued" || item.status === "running" ? "superseded" as const : item.status, error: item.error ?? `Historical activation: region ${item.regionId} was removed from the current solution.` });
  network.materialRequirements = network.materialRequirements?.filter((requirement) => network.regions.some((item) => item.scopeId === requirement.scopeId));
  const survivingEndpoint = (ref: string) => ref === "task" || survivingRegionIds.has(ref) || network.candidates.some((item) => item.id === ref) || network.evidence.some((item) => item.id === ref) || network.artifacts.some((item) => item.id === ref) || knownCoordinate(network, ref);
  network.constraints = network.constraints.filter((item) => survivingEndpoint(item.subject) && survivingEndpoint(item.target));
  return true;
}

function equivalenceClasses(network: SolutionNetwork): Map<string, string> {
  const adjacent = new Map<string, string[]>();
  for (const candidate of network.candidates) adjacent.set(candidate.id, []);
  for (const constraint of network.constraints) {
    if (constraint.kind !== "equivalent" || !adjacent.has(constraint.subject) || !adjacent.has(constraint.target)) continue;
    adjacent.get(constraint.subject)!.push(constraint.target);
    adjacent.get(constraint.target)!.push(constraint.subject);
  }
  const classes = new Map<string, string>();
  for (const start of adjacent.keys()) {
    if (classes.has(start)) continue;
    const stack = [start]; classes.set(start, start);
    while (stack.length) {
      const current = stack.pop()!;
      for (const next of adjacent.get(current)!) if (!classes.has(next)) { classes.set(next, start); stack.push(next); }
    }
  }
  return classes;
}

function hasSelectedImplementationFamily(network: SolutionNetwork, region: SolutionRegion): boolean {
  if (!region.selectedCandidateIds.length || !accepted(network, region)) return false;
  const classes = equivalenceClasses(network);
  const selected = region.selectedCandidateIds.map((id) => network.candidates.find((item) => item.id === id));
  return selected.every((item) => item?.regionId === region.id && item.status === "selected")
    && new Set(region.selectedCandidateIds.map((id) => classes.get(id) ?? id)).size === 1;
}

/**
 * The primal variable graph joins two shared choices whenever one move takes stances on both.
 * It must stay an acyclic forest: cycles would let sibling subtrees constrain each other through
 * hidden paths, breaking locality and making the sweeps' guarantees unverifiable.
 */
export function assertAcyclicPrimalGraph(network: SolutionNetwork): void {
  const parent = new Map<string, string>();
  const find = (id: string): string => { let root = id; while (parent.get(root) !== root) root = parent.get(root)!; while (parent.get(id) !== id) { const next = parent.get(id)!; parent.set(id, root); id = next; } return root; };
  const union = (left: string, right: string): boolean => { for (const id of [left, right]) if (!parent.has(id)) parent.set(id, id); const a = find(left); const b = find(right); if (a === b) return false; parent.set(a, b); return true; };
  const nameOf = new Map(network.variables.map((item) => [item.id, item.name]));
  const edgeLabel = (left: string, right: string) => `${nameOf.get(left) ?? left} + ${nameOf.get(right) ?? right}`;
  // Parallel edges (the same variable pair coupled again by another move or statement) are
  // legal; only an edge joining vertices already connected through other edges closes a cycle.
  const knownEdges = new Set<string>();
  const edgeKey = (left: string, right: string) => (left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`);
  const registerEdge = (left: string, right: string): boolean => {
    const key = edgeKey(left, right);
    if (knownEdges.has(key)) return true;
    if (!union(left, right)) return false;
    knownEdges.add(key);
    return true;
  };
  for (const constraint of network.constraints) {
    const left = coordinateOf(network, constraint.subject); const right = coordinateOf(network, constraint.target);
    if (left && right && !registerEdge(left.variableId, right.variableId)) throw new Error(`Shared choices "${edgeLabel(left.variableId, right.variableId)}" are already coupled — this statement would close a cycle between regions.`);
  }
  for (const candidate of network.candidates) {
    const touched = [...new Set((candidate.stances ?? []).map((stance) => stance.variableId))];
    for (let i = 0; i < touched.length; i += 1) {
      for (let j = i + 1; j < touched.length; j += 1) {
        if (!registerEdge(touched[i]!, touched[j]!)) throw new Error(`"${candidate.key}" positions on already-coupled shared choices (${edgeLabel(touched[i]!, touched[j]!)}) and would close a coupling cycle. Split the move or merge the choices.`);
      }
    }
  }
}

export function isConfirmedEvidence(network: SolutionNetwork, id: string): boolean {
  if (id === "task") return true;
  const item = network.evidence.find((entry) => entry.id === id);
  if (!item || (item.status ?? (item.kind === "inference" ? "hypothesis" : "confirmed")) !== "confirmed") return false;
  if (item.kind !== "inference") return true;
  return Boolean(item.validationEvidenceRefs?.length && item.validationEvidenceRefs.every((ref) => ref === "task" || network.evidence.some((ground) => ground.id === ref && ground.kind !== "inference" && (ground.status ?? "confirmed") === "confirmed")));
}

export function propagateNetwork(input: SolutionNetwork): SolutionNetwork {
  const network = cloneNetwork(input);
  refreshDomainControls(network);
  const confirmedEvidence = (id: string) => isConfirmedEvidence(network, id);
  const derivedSnapshot = (value: SolutionNetwork) => JSON.stringify({
    candidates: value.candidates.map(({ id, status, evidenceIds, eliminationReasons }) => ({ id, status, evidenceIds, eliminationReasons })),
    regions: value.regions.map(({ id, status, selectedCandidateIds, contradiction, domainPhase, domainFingerprint, acceptedFingerprint, challengeVerdict }) => ({ id, status, selectedCandidateIds, contradiction, domainPhase, domainFingerprint, acceptedFingerprint, challengeVerdict })),
    waiting: value.activations.filter((item) => item.status === "queued").map(({ id, status }) => ({ id, status })),
  });
  const beforeDerived = derivedSnapshot(network);
  // Derived statuses never become new solver input. Rebuild the domain from the
  // authored dispositions before applying the complete constraint set.
  for (const candidate of network.candidates) {
    const region = network.regions.find((item) => item.id === candidate.regionId);
    const directAnswer = candidate.key === "resolved-answer" && region?.delivery === "answer";
    if (candidate.declaredStatus === "selected" && !directAnswer && (!region || !accepted(network, region))) candidate.declaredStatus = "possible";
    candidate.status = candidate.declaredStatus ?? candidate.status;
    candidate.declaredEvidenceIds ??= [...candidate.evidenceIds];
    candidate.evidenceIds = [...candidate.declaredEvidenceIds];
    candidate.eliminationReasons = [...(candidate.declaredEliminationReasons ?? (candidate.status === "eliminated" ? candidate.eliminationReasons : []))];
  }
  const equivalence = equivalenceClasses(network);
  let changed = true;
  let anyChange = false;
  while (changed) {
    changed = false;
    const select = (id: string, reason: string) => {
      const candidate = network.candidates.find((item) => item.id === id);
      const region = candidate && network.regions.find((item) => item.id === candidate.regionId);
      if (!candidate || !region || !accepted(network, region) || candidate.status === "eliminated" || candidate.status === "selected") return;
      candidate.status = "selected"; candidate.eliminationReasons = candidate.eliminationReasons.filter((item) => item !== reason); changed = anyChange = true;
    };
    const eliminate = (id: string, reason: string) => {
      const candidate = network.candidates.find((item) => item.id === id);
      if (!candidate || candidate.status === "eliminated") return;
      candidate.status = "eliminated"; candidate.eliminationReasons = [...new Set([...candidate.eliminationReasons, reason])]; changed = anyChange = true;
    };
    for (const [id, reasons] of hardEliminations(network)) for (const reason of reasons) eliminate(id, reason);
    // Two-stage synchronous pass. Stage 1 applies fact-based kills (refutations, unavailable
    // requirements) — facts override commitments. Stage 2 then evaluates commitment-based rules
    // (excludes / requires-selection / equivalents) against the post-fact snapshot, so premise
    // validity never depends on constraint array order.
    const statusAtPassStart = new Map(network.candidates.map((item) => [item.id, item.status]));
    const isRegionSubject = (ref: string) => network.regions.some((item) => item.id === ref);
    const runConstraintSweeps = (statuses: Map<string, SolutionCandidate["status"]>, kinds: "facts" | "commitments") => {
      const pendingElims = new Map<string, Set<string>>();
      const pendingSelects = new Map<string, string>();
      const snapSelected = (ref: string) => statuses.get(ref) === "selected" || isRegionSubject(ref);
      const snapActive = (ref: string) => !statuses.has(ref) || statuses.get(ref) === "selected";
      const snapKnown = (ref: string) => statuses.has(ref);
      const queueEliminate = (id: string, reason: string) => {
        if (!statuses.has(id)) return;
        if (!pendingElims.has(id)) pendingElims.set(id, new Set());
        pendingElims.get(id)!.add(reason);
      };
      const effectivelyEliminated = (ref: string) => snapKnown(ref) && (statuses.get(ref) === "eliminated" || pendingElims.has(ref));
      const effectivelySelected = (ref: string) => snapSelected(ref) && !pendingElims.has(ref);
      for (let sweep = 0; sweep < 16; sweep += 1) {
        const eliminationsBefore = [...pendingElims.values()].reduce((total, reasons) => total + reasons.size, 0);
        const selectsBefore = pendingSelects.size;
        for (const constraint of network.constraints) {
          if (kinds === "facts") {
            if (constraint.kind === "refutes" && network.candidates.some((item) => item.id === constraint.subject) && snapActive(constraint.subject) && constraint.evidenceRefs.every(confirmedEvidence) && snapKnown(constraint.target)) queueEliminate(constraint.target, constraint.reason || constraint.kind);
            continue;
          }
          if (constraint.kind === "supports") {
            const candidate = network.candidates.find((item) => item.id === constraint.target);
            if (candidate && network.evidence.some((item) => item.id === constraint.subject) && !candidate.evidenceIds.includes(constraint.subject)) { candidate.evidenceIds.push(constraint.subject); changed = anyChange = true; }
            continue;
          }
          if (constraint.kind === "equivalent") {
            if (effectivelySelected(constraint.subject)) { const right = network.candidates.find((item) => item.id === constraint.target); if (right && !effectivelyEliminated(constraint.target)) pendingSelects.set(constraint.target, constraint.reason || "equivalent"); }
            if (effectivelySelected(constraint.target)) { const left = network.candidates.find((item) => item.id === constraint.subject); if (left && !effectivelyEliminated(constraint.subject)) pendingSelects.set(constraint.subject, constraint.reason || "equivalent"); }
            continue;
          }
          if (constraint.kind === "requires") {
            if (effectivelySelected(constraint.subject) && snapKnown(constraint.target) && !effectivelyEliminated(constraint.target)) pendingSelects.set(constraint.target, constraint.reason || constraint.kind);
            continue;
          }
          // excludes (both directions premised on live commitments)
          if (effectivelySelected(constraint.subject) && snapKnown(constraint.target)) queueEliminate(constraint.target, constraint.reason || "mutually exclusive alternatives");
          if (effectivelySelected(constraint.target) && snapKnown(constraint.subject)) queueEliminate(constraint.subject, constraint.reason || "mutually exclusive alternatives");
        }
        const eliminationsAfter = [...pendingElims.values()].reduce((total, reasons) => total + reasons.size, 0);
        if (eliminationsAfter === eliminationsBefore && pendingSelects.size === selectsBefore) break;
      }
      return { pendingElims, pendingSelects };
    };
    // Stage order matters: stance-facts (overlay) settle BEFORE commitment rules evaluate, so a
    // doomed commitment can never fire excludes/requires against its siblings on the way out.
const factStage = runConstraintSweeps(statusAtPassStart, "facts");
    for (const [id, reasons] of factStage.pendingElims) {
      for (const reason of reasons) eliminate(id, reason);
      // Fact-killed commitments release: facts override authored selections.
      const killed = network.candidates.find((item) => item.id === id);
      if (killed?.declaredStatus === "selected") killed.declaredStatus = "possible";
    }
    if (refreshDomainControls(network)) changed = anyChange = true;
    for (const candidate of network.candidates) {
      const region = network.regions.find((item) => item.id === candidate.regionId);
      if (candidate.status === "selected" && region && candidate.key !== "resolved-answer" && !accepted(network, region)) candidate.status = "possible";
    }
    // Shared-choice coordinates: cited refutations prune requiring moves everywhere visible;
    // committed selections bind options and prune excluding/requiring-other moves. prefers never eliminates.
    // Kills derive on a pure overlay to a fixed point first — a dead binder releases its binding
    // before anything else is killed off it — and only settled kills apply stickily.
    const refuted = new Set<string>();
    for (const constraint of network.constraints) {
      if (constraint.kind !== "refutes") continue;
      const coordinate = coordinateOf(network, constraint.target);
      if (!coordinate || !constraint.evidenceRefs?.length) continue;
      if (!constraint.evidenceRefs.every(confirmedEvidence)) continue;
      const subjectCandidate = network.candidates.find((item) => item.id === constraint.subject);
      if (subjectCandidate && subjectCandidate.status !== "selected") continue;
      refuted.add(`${coordinate.variableId}\u0000${slug(coordinate.valueLabel)}`);
    }
    const holders = network.candidates.filter((candidate) => (candidate.stances ?? []).length > 0);
    if (holders.length && (refuted.size > 0 || holders.some((holder) => holder.status === "selected"))) {
      const variableById = new Map(network.variables.map((item) => [item.id, item]));
      const baseDead = new Set(holders.filter((holder) => holder.status === "eliminated").map((holder) => holder.id));
      // Contested bindings: two live commitments demanding different options of one shared
      // choice is a contradiction to surface, never a silent first-writer-wins choice.
      const selectedStances = new Map<string, Array<{ variableId: string; valueLabel: string }>>();
      for (const holder of holders) {
        if (holder.status !== "selected" || baseDead.has(holder.id)) continue;
        // Only requires-stances are demands. An excludes-stance states incompatibility, not
        // commitment — counting it here made a lone holder contest itself against its own
        // exclusions and locked the region forever.
        selectedStances.set(holder.id, (holder.stances ?? []).filter((stance) => stance.relation === "requires").map((stance) => ({ variableId: stance.variableId, valueLabel: stance.valueLabel })));
      }
      const contestedVariables = new Set<string>();
      const contestedRegionIds = new Set<string>();
      {
        const labelsByVariable = new Map<string, Map<string, string>>();
        const regionByHolder = new Map<string, string>();
        for (const [holderId, stances] of selectedStances) {
          const holder = holders.find((item) => item.id === holderId)!;
          regionByHolder.set(holderId, holder.regionId);
          for (const stance of stances) {
            const slugLabel = slug(stance.valueLabel);
            if (!labelsByVariable.has(stance.variableId)) labelsByVariable.set(stance.variableId, new Map());
            labelsByVariable.get(stance.variableId)!.set(slugLabel, stance.valueLabel);
          }
        }
        for (const [variableId, labels] of labelsByVariable) {
          if (labels.size <= 1) continue;
          contestedVariables.add(variableId);
          for (const [holderId, stances] of selectedStances) if (stances.some((stance) => stance.variableId === variableId)) contestedRegionIds.add(regionByHolder.get(holderId)!);
        }
      }
      // Stale conflict locks clear themselves once the commitments that caused them are gone.
      for (const region of network.regions) {
        if (!region.contradiction?.startsWith("Commitments conflict")) continue;
        if (!contestedRegionIds.has(region.id)) { region.contradiction = undefined; changed = anyChange = true; }
      }
      for (const regionId of contestedRegionIds) {
        const region = network.regions.find((item) => item.id === regionId);
        const name = variableById.get([...contestedVariables][0]!)?.name ?? "shared choice";
        void name;
        if (region && !region.contradiction?.startsWith("Commitments conflict")) {
          transitionRegion(region, region.domainPhase, undefined, "contradiction");
          region.contradiction = "Commitments conflict on shared choice: committed moves demand different options.";
          changed = anyChange = true;
        }
      }
      // Iterate the decreasing operator K ← conflicts(bindings(selected ∖ baseDead ∖ K)):
      // a kill must never outlive the binder that caused it. Contested variables are excluded
      // from binding entirely — their conflict is surfaced above instead of resolved silently.
      // Kill grounds are collected for every stance-holder, dead ones included: a candidate
      // felled early by one rule must still record the grounds that arise later in the same
      // derivation (e.g. a binding materialized by this pass's forced selection), otherwise
      // the next pass revives and re-kills it with a different reason and idempotence breaks.
      let excluded: Set<string> = new Set();
      let killed = new Map<string, Set<string>>();
      let fingerprint = "";
      for (let iteration = 0; iteration < 16; iteration += 1) {
        killed = new Map<string, Set<string>>();
        const boundLabels = new Map<string, string>();
        const boundBy = new Map<string, string>();
        for (const holder of holders) {
          if (holder.status !== "selected" || baseDead.has(holder.id) || excluded.has(holder.id)) continue;
          for (const stance of holder.stances ?? []) {
            if (stance.relation !== "requires" || contestedVariables.has(stance.variableId)) continue;
            const key = `${stance.variableId}\u0000${slug(stance.valueLabel)}`;
            if (!boundLabels.has(key)) { boundLabels.set(key, stance.valueLabel); boundBy.set(key, holder.id); }
            else if (holder.id.localeCompare(boundBy.get(key)!) < 0) boundBy.set(key, holder.id);
          }
        }
        const boundsPerVariable = new Map<string, Array<[string, string, string]>>();
        for (const [key, label] of boundLabels) {
          const variableId = key.split("\u0000")[0]!;
          if (!boundsPerVariable.has(variableId)) boundsPerVariable.set(variableId, []);
          boundsPerVariable.get(variableId)!.push([key, label, boundBy.get(key)!]);
        }
        for (const entries of boundsPerVariable.values()) entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        for (const holder of holders) {
          for (const stance of holder.stances ?? []) {
            const variable = variableById.get(stance.variableId);
            if (!variable || stance.relation === "prefers") continue;
            const labelKey = `${stance.variableId}\u0000${slug(stance.valueLabel)}`;
            let reason: string | undefined;
            if (stance.relation === "requires") {
              if (refuted.has(labelKey)) reason = `shared choice ${variable.name}="${stance.valueLabel}" was refuted by cited evidence`;
              else for (const [key, label, by] of boundsPerVariable.get(stance.variableId) ?? []) {
                if (key === labelKey) continue;
                reason = `requires ${variable.name}="${stance.valueLabel}" but ${by} bound it to "${label}"`;
                break;
              }
            } else if (stance.relation === "excludes" && boundLabels.has(labelKey)) {
              reason = `move excludes ${variable.name}="${stance.valueLabel}", which was bound to that option by ${boundBy.get(labelKey)}`;
            }
            if (reason) {
              if (!killed.has(holder.id)) killed.set(holder.id, new Set());
              killed.get(holder.id)!.add(reason);
            }
          }
        }
        const fingerprintNow = [...killed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, reasons]) => `${id}:${[...reasons].sort().join("|")}`).join(";");
        if (fingerprintNow === fingerprint) break;
        fingerprint = fingerprintNow;
        excluded = new Set(killed.keys());
      }
      for (const [id, reasons] of killed) {
        const candidate = network.candidates.find((item) => item.id === id);
        for (const reason of reasons) if (candidate && !candidate.eliminationReasons.includes(reason)) { candidate.eliminationReasons.push(reason); changed = anyChange = true; }
        if (candidate && reasons.size && candidate.status !== "eliminated") candidate.status = "eliminated";
        if (candidate?.declaredStatus === "selected") candidate.declaredStatus = "possible";
      }
    } else {
      // A previously contested region can lose every stance-holding commitment between
      // activations. Conflict locks are derived state, so absence of live contestants
      // must clear them even when there is no remaining holder to enter the overlay.
      for (const region of network.regions) {
        if (!region.contradiction?.startsWith("Commitments conflict")) continue;
        region.contradiction = undefined;
        changed = anyChange = true;
      }
    }
    // Commitment rules (excludes / requires-selection / equivalents / supports) evaluate only
    // after stance-facts have settled above.
    const postOverlayStatuses = new Map(network.candidates.map((item) => [item.id, item.status]));
    for (const constraint of network.constraints) {
      if (constraint.kind !== "requires" || postOverlayStatuses.get(constraint.subject) === "eliminated" || postOverlayStatuses.get(constraint.target) !== "eliminated") continue;
      const subjectCandidate = network.candidates.find((item) => item.id === constraint.subject);
      eliminate(constraint.subject, constraint.reason || `requires ${constraint.target}, which is unavailable`);
      if (subjectCandidate?.declaredStatus === "selected") subjectCandidate.declaredStatus = "possible";
    }
    const commitmentStage = runConstraintSweeps(postOverlayStatuses, "commitments");
    for (const [id, reasons] of commitmentStage.pendingElims) for (const reason of reasons) eliminate(id, reason);
    for (const [id, reason] of commitmentStage.pendingSelects) select(id, reason);
    for (const region of network.regions) {
      const domain = region.candidateIds.map((id) => network.candidates.find((item) => item.id === id)).filter((item): item is SolutionCandidate => Boolean(item));
      const viable = domain.filter((item) => item.status !== "eliminated");
      let selected = viable.filter((item) => item.status === "selected");
      if (domain.length && !viable.length) {
        if (region.selectedCandidateIds.length) { region.selectedCandidateIds = []; changed = anyChange = true; }
        if (region.status !== "contradiction") { transitionRegion(region, region.domainPhase, undefined, "contradiction"); region.contradiction = "Every candidate was eliminated."; changed = anyChange = true; }
        continue;
      }
      if (!accepted(network, region) && selected.some((candidate) => candidate.key !== "resolved-answer")) {
        for (const candidate of selected) candidate.status = "possible";
        selected = [];
      }
      if (selected.length) {
        const equivalent = (left: string, right: string) => equivalence.get(left) === equivalence.get(right);
        if (selected.some((candidate, index) => selected.slice(index + 1).some((other) => !equivalent(candidate.id, other.id)))) {
          const contradiction = "Multiple incompatible alternatives were chosen. Choose one complete approach.";
          if (region.status !== "contradiction" || region.contradiction !== contradiction) { transitionRegion(region, region.domainPhase, undefined, "contradiction"); region.contradiction = contradiction; changed = anyChange = true; }
          continue;
        }
        for (const candidate of viable) if (!selected.some((item) => item.id === candidate.id) && !selected.every((item) => equivalent(item.id, candidate.id))) eliminate(candidate.id, "a different non-equivalent approach was chosen");
        selected = viable.filter((item) => item.status === "selected" || selected.every((choice) => equivalent(choice.id, item.id)));
        const ids = selected.map((item) => item.id);
        if (region.selectedCandidateIds.join("\0") !== ids.join("\0")) { region.selectedCandidateIds = ids; changed = anyChange = true; }
        const children = network.regions.filter((item) => item.parentId === region.id);
        const status = children.length ? "collapsed" : region.certifiedLeaf ? "actionable" : "unrefined";
        transitionRegion(region, "selected");
        const conflictLocked = region.status === "contradiction" && Boolean(region.contradiction?.startsWith("Commitments conflict"));
        if (!conflictLocked && region.status !== status && !["implementing", "implemented", "verified", "blocked", "stalled"].includes(region.status)) { transitionRegion(region, "selected", undefined, status); changed = anyChange = true; }
      } else {
        if (region.selectedCandidateIds.length) { region.selectedCandidateIds = []; changed = anyChange = true; }
        if (domain.length && region.status !== "superposed" && region.status !== "stalled" && region.status !== "blocked") { transitionRegion(region, region.domainPhase, undefined, "superposed"); changed = anyChange = true; }
      }
    }
    // Coordinate excludes from live commitments: once the excluding move is selected, every
    // other move requiring that exact option dies. Evaluated AFTER the region block so this
    // pass's forced selections are visible — the outcome never depends on intra-pass ordering.
    const forbiddenBy = new Map<string, string>();
    for (const constraint of network.constraints) {
      if (constraint.kind !== "excludes") continue;
      const coordinate = coordinateOf(network, constraint.target);
      if (!coordinate) continue;
      const subjectCandidate = network.candidates.find((item) => item.id === constraint.subject);
      // Authoritative commitments only: derived forced-singletons would make this rule
      // order-dependent across permutations of the same facts. Structurally unsatisfiable
      // commitments (same-region requires toward a different sibling) release instead of firing.
      if (!subjectCandidate || subjectCandidate.declaredStatus !== "selected" || subjectCandidate.status !== "selected") continue;
      const ownRegionId = subjectCandidate.regionId;
      const structurallyUnsatisfiable = network.constraints.some((constraint) => constraint.kind === "requires" && constraint.subject === subjectCandidate.id && constraint.target !== subjectCandidate.id && constraint.target.startsWith(`${ownRegionId}:`));
      if (structurallyUnsatisfiable) continue;
      const key = `${coordinate.variableId}\u0000${slug(coordinate.valueLabel)}`;
      if (!forbiddenBy.has(key)) forbiddenBy.set(key, subjectCandidate.id);
    }
    if (forbiddenBy.size) {
      const variableByIdAfter = new Map(network.variables.map((item) => [item.id, item]));
      for (const candidate of network.candidates) {
        if (candidate.status === "eliminated") continue;
        for (const stance of candidate.stances ?? []) {
          if (stance.relation !== "requires") continue;
          const variable = variableByIdAfter.get(stance.variableId);
          if (!variable) continue;
          const sourceId = forbiddenBy.get(`${stance.variableId}\u0000${slug(stance.valueLabel)}`);
          if (sourceId && sourceId !== candidate.id) {
            eliminate(candidate.id, `another committed move rules out shared choice ${variable.name}="${stance.valueLabel}"`);
            break;
          }
        }
      }
    }
  }
  refreshDomainControls(network);
  network.revision = input.revision + (derivedSnapshot(network) === beforeDerived ? 0 : 1);
  return network;
}

function mergeEvidence(network: SolutionNetwork, region: SolutionRegion, items: SolutionDelta["evidence"]): Map<string, string> {
  const localEvidence = new Map<string, string>();
  for (const item of items) {
    const fingerprint = createHash("sha256").update(`${normalize(item.text)}\0${normalize(item.source)}`).digest("hex").slice(0, 16);
    let evidence = network.evidence.find((existing) => existing.fingerprint === fingerprint);
    const status = item.kind === "inference" ? "hypothesis" : "confirmed";
    if (!evidence) { evidence = { ...item, status, text: normalize(item.text), source: normalize(item.source), id: `e${network.nextEvidenceId++}`, fingerprint, createdRevision: network.revision + 1 }; network.evidence.push(evidence); }
    region.evidenceIds = [...new Set([...region.evidenceIds, evidence.id])]; localEvidence.set(item.source, evidence.id);
  }
  return localEvidence;
}

export function validateSolutionDelta(state: SolutionLodState, regionId: string, capabilityOrDelta: Capability | SolutionDelta, maybeDelta?: SolutionDelta): void {
  const capability: Capability = typeof capabilityOrDelta === "string" ? capabilityOrDelta : capabilityOrDelta.resolvedAnswer ? "inspect" : "synthesize";
  const delta = normalizeDelta(typeof capabilityOrDelta === "string" ? maybeDelta! : capabilityOrDelta);
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  rejectUnrequestedDeferredWork(state, [delta.region?.objective, ...(delta.region?.acceptanceCriteria ?? []), ...(delta.taskScopes ?? []).flatMap((item) => [item.objective, ...item.acceptanceCriteria]), ...(delta.materialRequirements ?? []).map((item) => item.text), delta.certifiedVerdict?.proposition, delta.certifiedVerdict?.implementationScope, ...delta.candidates.map((item) => item.proposition)]);
  if (capability === "inspect") {
    if (delta.candidates.length || delta.constraints.length || delta.select.length || delta.variables?.length)
      throw new Error("Inspection may report sourced facts or a complete answer, but may not propose, reject, constrain, select solution alternatives, or declare shared choices.");
    if (delta.taskScopes?.length) {
      if (region.edge !== "root" || delta.taskScopes.length < 2) throw new Error("Root AND decomposition requires at least two independently verifiable task scopes and is valid only at the root.");
      const keys = delta.taskScopes.map((item) => slug(item.key));
      if (new Set(keys).size !== keys.length) throw new Error("Every root task scope requires a unique typed identity.");
      const proposedScopes = new Set(delta.taskScopes.map((item) => `scope:${region.id}:${slug(item.key)}`));
      for (const scope of delta.taskScopes) for (const dependency of scope.dependencyScopeIds ?? []) if (!proposedScopes.has(dependency) && !state.network.regions.some((item) => item.scopeId === dependency)) throw new Error(`Task scope ${scope.key} cites unknown semantic dependency ${dependency}.`);
      if (delta.materialRequirements?.length) {
        const requirementKeys = delta.materialRequirements.map((item) => slug(item.key));
        if (new Set(requirementKeys).size !== requirementKeys.length) throw new Error("Every material root requirement requires a unique typed identity.");
        const criteria = new Set(delta.taskScopes.flatMap((scope) => scope.acceptanceCriteria.map(normalize)));
        for (const requirement of delta.materialRequirements) if (!criteria.has(normalize(requirement.criterion))) throw new Error(`Material requirement ${requirement.key} cites criterion "${requirement.criterion}" that no task scope owns.`);
        const owners = new Map(requirementKeys.map((key) => [key, 0]));
        for (const scope of delta.taskScopes) for (const key of scope.requirementKeys ?? []) {
          const normalized = slug(key);
          if (!owners.has(normalized)) throw new Error(`Task scope ${scope.key} cites unknown material requirement ${key}.`);
          owners.set(normalized, owners.get(normalized)! + 1);
        }
        const invalid = [...owners].filter(([, count]) => count !== 1);
        if (invalid.length) throw new Error(`Every material root requirement must have exactly one task-scope owner: ${invalid.map(([key, count]) => `${key}=${count}`).join(", ")}.`);
      }
      const suppliedSources = new Set(delta.evidence.filter((item) => item.kind === "repository" || item.kind === "tool").map((item) => item.source));
      for (const disposition of delta.taskDispositions ?? []) {
        if (!normalize(disposition.reason)) throw new Error("Every non-scope task disposition requires an explicit reason.");
        if (!disposition.evidenceRefs.every((ref) => ref === "task" || isConfirmedEvidence(state.network, ref) || suppliedSources.has(ref))) throw new Error(`Task disposition ${disposition.key} requires task or confirmed repository/tool evidence.`);
      }
    }
    if (delta.materialRequirements?.length && region.edge !== "root") throw new Error("Material requirement inventory may be authored only once at the root.");
    if (delta.materialRequirements?.length && state.network.materialRequirements?.length) throw new Error("The typed root material-requirement inventory is immutable once established.");
    if (delta.certifiedVerdict) {
      if (region.delivery !== "change" || delta.candidates.length || delta.constraints.length || delta.taskScopes?.length) throw new Error("A certified supplied verdict is valid only for one mechanically fixed change without a competing domain or task split.");
      if (!region.acceptanceCriteria.length && !delta.region?.acceptanceCriteria?.length) throw new Error("A certified supplied verdict requires observable acceptance criteria.");
      const suppliedSources = new Set(delta.evidence.filter((item) => item.kind === "repository" || item.kind === "tool").map((item) => item.source));
      if (!delta.certifiedVerdict.evidenceRefs.every((ref) => isConfirmedEvidence(state.network, ref) || suppliedSources.has(ref))) throw new Error("A certified supplied verdict requires only confirmed repository/tool evidence references.");
      if (delta.certifiedVerdict.evidenceRefs.some((ref) => ref === "task")) throw new Error("A certified supplied verdict requires repository-grounded evidence, not the request alone.");
    }
    if (delta.region?.objective) {
      const sameGoal = slug(delta.region.objective) === slug(region.objective);
      if (!sameGoal)
        throw new Error("Inspection may not rewrite the assigned objective. Omit the optional 'objective' field entirely — never restate, summarize, or paraphrase the goal in your result.");
    }
  } else if (capability === "synthesize" && (delta.taskScopes?.length || delta.taskDispositions?.length || delta.materialRequirements?.length || delta.certifiedVerdict)) throw new Error("Synthesis cannot create or reassign root scopes, dispositions, requirements, or a certified supplied verdict.");
  else if (capability === "synthesize" && delta.region && Object.keys(delta.region).length) {
    const sameCriteria = JSON.stringify([...(delta.region.acceptanceCriteria ?? region.acceptanceCriteria).map((item) => normalize(item))].sort()) === JSON.stringify([...region.acceptanceCriteria.map((item) => normalize(item))].sort());
    const sameVariables = JSON.stringify([...(delta.region.allowedVariables ?? region.allowedVariables)].sort()) === JSON.stringify([...region.allowedVariables].sort());
    const rewrote = (delta.region.objective !== undefined && slug(delta.region.objective) !== slug(region.objective))
      || (delta.region.delivery !== undefined && delta.region.delivery !== region.delivery)
      || !sameCriteria || !sameVariables;
    if (rewrote) throw new Error("Synthesis may compare alternatives, but may not rewrite the objective, delivery type, allowed variables, or success criteria.");
  }
  if (capability === "synthesize" && (delta.select.length || delta.candidates.some((item) => item.outcome === "selected")))
    throw new Error("Synthesis deltas may not author or derive selections. A commitment can be created only by the select-candidate operation after fresh challenge acceptance.");
  if (delta.variables?.length || delta.candidates.some((item) => item.stances?.length)) {
    const declaredNames = new Set(state.network.variables.map((item) => item.name));
    const previewVariables = [...state.network.variables];
    for (const declaration of delta.variables ?? []) {
      const name = slug(declaration.name);
      if (!name || name === "task") continue;
      if (declaredNames.has(name)) throw new Error(`A shared choice named "${name}" already exists — reuse it instead of declaring it again.`);
      declaredNames.add(name);
      const seedLabels: string[] = [];
      for (const raw of declaration.seedLabels ?? []) {
        const label = normalize(raw);
        if (label && !seedLabels.some((existing) => slug(existing) === slug(label))) seedLabels.push(label);
      }
      previewVariables.push({ id: `preview:${name}`, name, ownerRegionId: regionId, seedLabels });
    }
    const preview = { ...state.network, variables: previewVariables } as SolutionNetwork;
    for (const item of delta.candidates) resolveStances(preview, regionId, item.stances ?? []);
  }
  if (delta.candidates.length > MAX_DOMAIN_CANDIDATES) throw new Error("A region may contain at most seven materially distinct current-level alternatives. Refine the decision boundary instead of silently pruning candidates.");
  // Mirror mergeSolutionDelta: an answer is honored only when the delta marks the goal as answer-only.
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  if (delta.region?.delivery && delta.region.delivery !== region.delivery && !resolvedAnswer)
    throw new Error("Delivery type may change only through a complete resolvedAnswer. A standalone delivery rewrite is not a clarification — return resolvedAnswer with the evidence-backed answer instead.");
  if (resolvedAnswer) {
    const known = new Set(["task", ...state.network.evidence.map((item) => item.id)]);
    const suppliedSources = new Set(delta.evidence.map((item) => item.source));
    if (!resolvedAnswer.evidenceRefs.some((ref) => known.has(ref) || suppliedSources.has(ref)))
      throw new Error("A resolved answer must cite at least one real fact: an existing evidence id or the source of a fact supplied with this result. An answer without evidence is a guess, not a resolution.");
    if (region.delivery !== "answer") {
      const open = state.network.candidates.filter((item) => item.regionId === regionId && item.status === "possible");
      if (open.length)
        throw new Error(`Resolving to an answer would downgrade this change goal while ${open.length} implementation alternative(s) remain possible. Commit to one approach through select, or eliminate each alternative with a refutes constraint backed by the task reference or confirmed evidence; only a settled solution space may be closed with an answer.`);
      if (!resolvedAnswer.evidenceRefs.includes("task"))
        throw new Error(`Closing a change goal with an answer requires user authority: cite the immutable task reference "task" in resolvedAnswer.evidenceRefs so the resolution is anchored to the original request, not to model preference.`);
    }
    return;
  }
  const statuses = new Map<string, string>();
  for (const candidate of state.network.candidates.filter((item) => item.regionId === regionId)) statuses.set(candidate.id, candidate.status);
  for (const item of delta.candidates) statuses.set(candidateId(regionId, item.key), item.outcome);
  const candidateRefs = new Set(statuses.keys());
  if (delta.evidence.some((item) => item.kind === "user")) throw new Error("Model output cannot create user evidence. User authority is the immutable task reference, cited as evidenceRefs: [\"task\"].");
  if (capability !== "inspect" && delta.evidence.some((item) => item.kind !== "inference")) throw new Error("This tool-free role cannot create confirmed repository/tool evidence. Reuse supplied evidence IDs, return a new inference hypothesis, or request one specific inspection.");
  const evidenceRefs = new Set(["task", ...state.network.evidence.map((item) => item.id), ...delta.evidence.map((item) => item.source)]);
  const confirmedRef = (ref: string) => {
    if (ref === "task") return true;
    const existing = state.network.evidence.find((item) => item.id === ref);
    if (existing) return isConfirmedEvidence(state.network, ref);
    const supplied = delta.evidence.find((item) => item.source === ref);
    return Boolean(supplied && supplied.kind !== "inference" && supplied.kind !== "user");
  };
  const groundingKind = (ref: string) => ref === "task" ? "user" : state.network.evidence.find((item) => item.id === ref)?.kind ?? delta.evidence.find((item) => item.source === ref)?.kind;
  if (capability !== "inspect" && (delta.validations?.length ?? 0) > 0) throw new Error("Only inspection may validate an unresolved claim.");
  for (const validation of delta.validations ?? []) {
    const claim = state.network.evidence.find((item) => item.id === validation.claimRef);
    if (!claim || claim.kind !== "inference" || claim.status === "rejected") throw new Error(`Validation target "${validation.claimRef}" is not a live hypothesis.`);
    if (validation.verdict === "unresolved") {
      if (validation.evidenceRefs.length) throw new Error("An unresolved validation must not attach evidence as if it proved a verdict.");
      continue;
    }
    if (!validation.evidenceRefs.length) throw new Error(`${validation.verdict} validation of "${validation.claimRef}" requires independent repository, tool, or user evidence.`);
    for (const ref of validation.evidenceRefs) {
      if (!confirmedRef(ref) || groundingKind(ref) === "inference") throw new Error(`Validation evidence "${ref}" is not independent confirmed repository/tool/user evidence.`);
    }
  }
  const endpoint = (ref: string) => {
    const canonical = candidateRef(state.network, regionId, ref);
    if (candidateRefs.has(canonical)) return "candidate";
    if (evidenceRefs.has(ref)) return "evidence";
    if (ref === "task") return "task";
    if (state.network.regions.some((item) => item.id === ref)) return "region";
    if (knownCoordinate(state.network, ref)) return "coordinate";
    return "unknown";
  };
  for (const constraint of delta.constraints) {
    const subject = endpoint(constraint.subject); const target = endpoint(constraint.target);
    const valid = constraint.kind === "supports" ? subject === "evidence" && target === "candidate"
      : constraint.kind === "refutes" ? (subject === "evidence" || subject === "candidate" || subject === "task") && (target === "candidate" || target === "coordinate")
      : constraint.kind === "excludes" ? subject === "candidate" && (target === "candidate" || target === "coordinate")
      : subject === "candidate" && target === "candidate";
    if (!valid)
      throw new Error(
        `Invalid ${constraint.kind} endpoints: ${constraint.subject} (${subject}) -> ${constraint.target} (${target}). ` +
        `Allowed shapes: supports = factId -> candidateKey. refutes = factId|task|candidateKey -> candidateKey (or -> choiceName:option when citing why an option dies). requires/excludes/equivalent = candidateKey -> candidateKey within this goal. ` +
        `To say one approach strengthens another, attach its facts as supporting evidenceRefs on the candidate instead.`,
      );
    for (const ref of constraint.evidenceRefs ?? []) {
      if (!evidenceRefs.has(ref)) throw new Error(`Constraint cites unknown fact "${ref}" — cite an established fact id or supply the fact with this result.`);
      if (!confirmedRef(ref)) throw new Error(`Constraint cites unresolved claim "${ref}" — validate it before using it as a constraint.`);
    }
    if (constraint.kind === "refutes" && subject === "evidence" && !confirmedRef(constraint.subject))
      throw new Error(`Refutation source "${constraint.subject}" is unresolved — validate it before using it to eliminate an alternative.`);
    if (constraint.sourceKind === "user-task")
      throw new Error(`Model output cannot assert user-task authority. Use model-inference for your interpretation, or cite confirmed repository/tool evidence with repo-evidence; only trusted controller state may create user-task constraints.`);
    if (constraint.sourceKind === "repo-evidence" && subject !== "evidence" && !(constraint.evidenceRefs ?? []).some((ref) => confirmedRef(ref) && (groundingKind(ref) === "repository" || groundingKind(ref) === "tool")))
      throw new Error(`Constraint claims repository authority but cites no confirmed repository/tool evidence.`);
    if (target === "coordinate") {
      if (!(constraint.evidenceRefs ?? []).length)
        throw new Error(`Refuting shared choice "${constraint.target}" requires at least one cited fact in evidenceRefs — an uncited kill of a shared option is a guess, not a constraint.`);
    }
  }
  if (capability === "synthesize") {
    for (const item of delta.candidates) {
      if (item.outcome === "eliminated") {
        const id = candidateId(regionId, item.key);
        const proof = delta.constraints.some((constraint) => constraint.kind === "refutes" && candidateId(regionId, constraint.target) === id && (confirmedRef(constraint.subject) || constraint.evidenceRefs.some(confirmedRef)));
        if (!proof) throw new Error(`Alternative "${item.key}" cannot be directly eliminated. Return it as possible and provide a refutes constraint backed by the exact task reference or confirmed evidence; keep sourceKind=model-inference for your interpretation of the task. The kernel will derive elimination.`);
      }
    }
  }
  const domain = [...statuses.values()];
  if (domain.length && domain.every((status) => status === "eliminated"))
    throw new Error(`Every alternative for ${regionId} was rejected. Leave at least one alternative possible or chosen. Reject an alternative only for a reason that argues against choosing it; supporting evidence is not a rejection reason.`);
}

/** Direct reducer callers may omit defaulted delta arrays; Zod-normalized graph paths never do. */
function normalizeDelta(delta: SolutionDelta): SolutionDelta {
  return { ...delta, candidates: delta.candidates ?? [], constraints: delta.constraints ?? [], evidence: delta.evidence ?? [], validations: delta.validations ?? [], select: delta.select ?? [], activations: delta.activations ?? [], variables: delta.variables ?? [], taskScopes: delta.taskScopes ?? [], taskDispositions: delta.taskDispositions ?? [] };
}

const synthesisDelta = (output: DomainGenerationOutput, candidateItems = output.candidates): SolutionDelta => ({
  region: {}, evidence: output.evidence, variables: output.variables,
  candidates: candidateItems.map((item) => ({ ...item, outcome: "possible" as const, reasons: [] })),
  constraints: output.constraints, select: [], activations: [], validations: [],
});

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
}

export function validateSynthesisOutput(state: SolutionLodState, activation: Activation, output: SynthesisOutput): void {
  if (activation.capability !== "synthesize" || !activation.operation || activation.operation !== output.operation)
    throw new Error(`Synthesis output operation ${output.operation} does not match activation operation ${activation.operation ?? "missing"}.`);
  const region = state.network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Unknown synthesis region ${activation.regionId}.`);
  rejectUnrequestedDeferredWork(state, output.operation === "generate-domain" ? output.candidates.map((item) => item.proposition) : output.operation === "challenge-domain" ? [output.verdict === "counterexample" ? output.candidate.proposition : undefined, output.verdict === "needs-fact" ? output.request : undefined] : [output.inspectionRequest?.request, ...output.hardConstraints.map((item) => item.reason)]);
  const fingerprint = domainFingerprint(state.network, region.id);
  if (output.operation === "generate-domain") {
    if (region.candidateIds.length) throw new Error(`generate-domain requires an ungenerated region; ${region.id} already has a domain.`);
    if (output.candidates.some((item) => /^(other|something else|miscellaneous|none of the above)$/i.test(normalize(item.proposition)))) throw new Error("A generated candidate must be a concrete material solution family, not a vague residual alternative.");
    if (new Set(output.candidates.map((item) => slug(item.proposition))).size !== output.candidates.length) throw new Error("Generated candidates must be materially distinct; duplicate paraphrases are not separate solution families.");
    validateSolutionDelta(state, region.id, "synthesize", synthesisDelta(output));
    return;
  }
  if (output.domainFingerprint !== fingerprint || activation.domainFingerprint !== fingerprint)
    throw new Error(`Stale ${output.operation} result: expected exact domain fingerprint ${fingerprint ?? "none"}, received ${output.domainFingerprint}.`);
  const viable = region.candidateIds.filter((id) => state.network.candidates.find((item) => item.id === id)?.status !== "eliminated").sort();
  if (output.operation === "challenge-domain") {
    if (output.verdict === "accept" && !exactSet(output.viableCandidateIds, viable)) throw new Error("Challenge acceptance must reference every and only currently viable candidate ID.");
    if (output.verdict === "counterexample") {
      for (const ref of [...output.evidenceRefs, ...output.candidate.evidenceRefs]) if (!isConfirmedEvidence(state.network, ref)) throw new Error(`Counterexample cites unresolved, invented, or stale evidence reference ${ref}.`);
      const stances = resolveStances(state.network, region.id, output.candidate.stances ?? []);
      const id = candidateId(region.id, output.candidate.key);
      if (state.network.candidates.some((item) => item.id === id)) throw new Error(`Challenge counterexample must add one genuinely new candidate ID; ${id} already exists.`);
      const signature = candidateSignature(output.candidate.proposition, stances);
      if (state.network.candidates.some((item) => item.regionId === region.id && candidateSignature(item.proposition, item.stances ?? []) === signature)) throw new Error("Challenge counterexample duplicates an existing candidate by proposition and stance identity.");
    } else if (output.verdict === "needs-fact") {
      for (const ref of output.contextRefs) if (!knownRef(state.network, ref)) throw new Error(`Challenge inspection request cites unknown context reference ${ref}.`);
    }
    return;
  }
  if (!region.acceptedFingerprint || region.acceptedFingerprint !== fingerprint) throw new Error("Candidate selection requires the exact current domain fingerprint to have a fresh accepted challenge verdict.");
  if (!exactSet(output.comparisons.map((item) => item.candidateId), viable)) throw new Error("Candidate selection must compare every and only currently viable candidate ID.");
  if (output.hardConstraints.length) {
    if (output.basis !== "hard-constraint" || output.inspectionRequest) throw new Error("New hard constraints require hard-constraint basis without a simultaneous inspection request.");
    if (output.selectedCandidateId) throw new Error("A newly discovered hard constraint must land without a selection; the changed domain must be challenged again.");
    for (const constraint of output.hardConstraints) {
      if (!["requires", "excludes", "refutes"].includes(constraint.kind)) throw new Error(`Selection hardConstraints may contain only requires, excludes, or refutes; ${constraint.kind} is not a hard elimination rule.`);
      if (!constraint.evidenceRefs.length || constraint.evidenceRefs.some((ref) => !isConfirmedEvidence(state.network, ref))) throw new Error(`Selection hard constraint ${constraint.subject} -> ${constraint.target} requires cited confirmed evidence.`);
    }
    validateSolutionDelta(state, region.id, "synthesize", { region: {}, evidence: [], variables: [], candidates: [], constraints: output.hardConstraints, select: [], activations: [], validations: [] });
    return;
  }
  if (output.basis === "only-viable") {
    if (viable.length !== 1 || output.selectedCandidateId !== viable[0]) throw new Error("only-viable selection must name the sole viable candidate.");
    return;
  }
  if (output.basis === "needs-fact") {
    if (output.selectedCandidateId || !output.inspectionRequest) throw new Error("An unresolved preference tie must request exactly one grounding fact and must not select.");
    for (const ref of output.inspectionRequest.contextRefs) if (!knownRef(state.network, ref)) throw new Error(`Selection inspection request cites unknown context reference ${ref}.`);
    return;
  }
  if (output.basis === "hard-constraint") throw new Error("hard-constraint basis requires at least one new hard constraint.");
  if (output.basis !== "lexicographic" || !output.selectedCandidateId) throw new Error("Selection must use only-viable, lexicographic, needs-fact, or hard-constraint basis consistently.");
  const rank = { preferred: 0, neutral: 1, disfavored: 2 } as const;
  const tuples = output.comparisons.map((item) => ({ id: item.candidateId, tuple: [rank[item.userPreference], rank[item.repositoryCompatibility], rank[item.changeScope], rank[item.irreversibleRisk]] as const }));
  for (const item of output.comparisons) {
    if ((item.userPreference !== "neutral" || item.repositoryCompatibility !== "neutral") && !item.evidenceRefs.length) throw new Error(`Preference claims for ${item.candidateId} require corresponding user or repository references.`);
    if (item.evidenceRefs.some((ref) => !isConfirmedEvidence(state.network, ref))) throw new Error(`Preference comparison for ${item.candidateId} cites an unresolved or stale reference.`);
    if (item.userPreference !== "neutral" && !item.evidenceRefs.some((ref) => ref === "task" || state.network.evidence.find((evidence) => evidence.id === ref)?.kind === "user")) throw new Error(`User-preference comparison for ${item.candidateId} requires a user reference.`);
    if (item.repositoryCompatibility !== "neutral" && !item.evidenceRefs.some((ref) => ["repository", "tool"].includes(state.network.evidence.find((evidence) => evidence.id === ref)?.kind ?? ""))) throw new Error(`Repository-compatibility comparison for ${item.candidateId} requires a repository or tool reference.`);
  }
  tuples.sort((left, right) => { for (let index = 0; index < 4; index++) { const difference = left.tuple[index]! - right.tuple[index]!; if (difference) return difference; } return left.id.localeCompare(right.id); });
  const sameRank = (left: typeof tuples[number], right: typeof tuples[number]) => left.tuple.every((value, index) => value === right.tuple[index]);
  if (tuples[1] && sameRank(tuples[0]!, tuples[1]!)) throw new Error("The earliest applicable preference tier has no unique winner; request one grounding fact.");
  if (output.selectedCandidateId !== tuples[0]?.id) throw new Error(`Lexicographic selection must choose ${tuples[0]?.id}.`);
}

export function mergeSynthesisOutput(state: SolutionLodState, activationId: string, output: SynthesisOutput): SolutionNetwork {
  const activation = state.network.activations.find((item) => item.id === activationId);
  if (!activation) throw new Error(`Unknown activation ${activationId}`);
  validateSynthesisOutput(state, activation, output);
  if (output.operation === "generate-domain") {
    let network = mergeSolutionDelta(state, activationId, synthesisDelta(output));
    const region = network.regions.find((item) => item.id === activation.regionId)!;
    region.cegarRound = 0; region.acceptedFingerprint = null; region.challengeVerdict = null; transitionRegion(region, "challenging");
    refreshDomainControls(network); network.revision++;
    return network;
  }
  let network = cloneNetwork(state.network);
  let region = network.regions.find((item) => item.id === activation.regionId)!;
  if (output.operation === "challenge-domain") {
    region.challengeVerdict = output.verdict;
    if (output.verdict === "accept") { region.acceptedFingerprint = output.domainFingerprint; transitionRegion(region, "selecting"); }
    else if (output.verdict === "counterexample") {
      const diagnostic = JSON.stringify({ key: output.candidate.key, proposition: output.candidate.proposition, stances: output.candidate.stances, reason: output.reason, evidence: { counterexample: output.evidenceRefs, candidate: output.candidate.evidenceRefs } });
      if (region.cegarRound >= MAX_CEGAR_ROUNDS || region.candidateIds.length >= MAX_DOMAIN_CANDIDATES) {
        transitionRegion(region, "blocked", `${region.cegarRound >= MAX_CEGAR_ROUNDS ? "CEGAR repair" : "seven-candidate domain"} bound exceeded: unresolved counterexample ${output.candidate.proposition}; details=${diagnostic}`);
        network.revision++;
        return network;
      }
      const beforeIds = new Set(region.candidateIds);
      const delta: SolutionDelta = { region: {}, evidence: [], variables: [], candidates: [{ ...output.candidate, outcome: "possible", reasons: [] }], constraints: [], select: [], activations: [], validations: [] };
      network = mergeSolutionDelta({ ...state, network } as SolutionLodState, activationId, delta);
      region = network.regions.find((item) => item.id === activation.regionId)!;
      const addedIds = region.candidateIds.filter((id) => !beforeIds.has(id));
      if (addedIds.length !== 1 || addedIds[0] !== candidateId(region.id, output.candidate.key)) throw new Error("Counterexample repair must add exactly one genuinely new candidate ID.");
      region.cegarRound += 1; region.acceptedFingerprint = null; region.noProgressCount = 0; region.noProgressFingerprint = null; transitionRegion(region, "challenging");
    } else {
      transitionRegion(region, "inspecting");
      addActivation(network, { capability: "inspect", regionId: region.id, request: output.request, expectedDelta: output.expectedDelta, contextRefs: output.contextRefs, senderActivationId: activation.id });
    }
    network.revision++; return propagateNetwork(network);
  }
  if (output.hardConstraints.length) {
    const delta: SolutionDelta = { region: {}, evidence: [], variables: [], candidates: [], constraints: output.hardConstraints, select: [], activations: [], validations: [] };
    network = mergeSolutionDelta({ ...state, network } as SolutionLodState, activationId, delta);
    region = network.regions.find((item) => item.id === activation.regionId)!;
    region.acceptedFingerprint = null; region.challengeVerdict = null; region.noProgressCount = 0; region.noProgressFingerprint = null; transitionRegion(region, "challenging"); network.revision++;
    return propagateNetwork(network);
  }
  if (output.basis === "needs-fact") {
    const comparisons = output.comparisons.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs].sort() })).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const request = { request: normalize(output.inspectionRequest!.request), expectedDelta: normalize(output.inspectionRequest!.expectedDelta), contextRefs: [...new Set(output.inspectionRequest!.contextRefs)].sort() };
    const signature = createHash("sha256").update(JSON.stringify({ domainFingerprint: output.domainFingerprint, request, comparisons })).digest("hex").slice(0, 16);
    region.noProgressCount = region.noProgressFingerprint === signature ? region.noProgressCount + 1 : 1;
    region.noProgressFingerprint = signature;
    if (region.noProgressCount >= MAX_NO_PROGRESS_CYCLES) transitionRegion(region, "blocked", `Selection for ${region.id} made no progress for two identical comparison cycles.`);
    else { transitionRegion(region, "inspecting"); addActivation(network, { capability: "inspect", regionId: region.id, request: output.inspectionRequest!.request, expectedDelta: output.inspectionRequest!.expectedDelta, contextRefs: output.inspectionRequest!.contextRefs, senderActivationId: activation.id }); }
    network.revision++; return network;
  }
  const selected = network.candidates.find((item) => item.id === output.selectedCandidateId)!;
  for (const candidate of network.candidates.filter((item) => item.regionId === region.id)) candidate.declaredStatus = candidate.id === selected.id ? "selected" : "possible";
  purgeDescendants(network, region.id);
  region.noProgressCount = 0; region.noProgressFingerprint = null; transitionRegion(region, "selected"); network.revision++;
  return propagateNetwork(network);
}

export function mergeSolutionDelta(state: SolutionLodState, activationId: string, rawDelta: SolutionDelta): SolutionNetwork {
  const delta = normalizeDelta(rawDelta);
  const network = cloneNetwork(state.network);
  const activation = network.activations.find((item) => item.id === activationId);
  if (!activation) throw new Error(`Unknown activation ${activationId}`);
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Unknown activation region ${activation.regionId}`);
  let changed = false;
  if (delta.region) {
    if (delta.region.objective && delta.region.objective !== region.objective) { region.objective = delta.region.objective; changed = true; }
    const mergeResolvedAnswer = delta.region.delivery === "answer" ? delta.resolvedAnswer : undefined;
    if (delta.region.delivery && delta.region.delivery !== region.delivery && !mergeResolvedAnswer) throw new Error(`Delivery rewrite from "${region.delivery}" to "${delta.region.delivery}" is only valid through a complete resolvedAnswer.`);
    if (delta.region.delivery && delta.region.delivery !== region.delivery) { region.delivery = delta.region.delivery; changed = true; }
    if (delta.region.allowedVariables) { region.allowedVariables = [...new Set(delta.region.allowedVariables.map(normalize).filter(Boolean))]; changed = true; }
    if (delta.region.acceptanceCriteria) { region.acceptanceCriteria = [...new Set(delta.region.acceptanceCriteria.map(normalize).filter(Boolean))]; region.criterionIds = region.acceptanceCriteria.map((_, index) => `criterion:${region.scopeId}:${index}` as const); changed = true; }
  }
  if (activation.capability === "inspect" && region.edge === "root" && delta.taskScopes?.length) {
    const taskScopes = delta.taskScopes;
    region.acceptanceCriteria = delta.taskScopes.map((item) => normalize(item.objective));
    region.criterionIds = region.acceptanceCriteria.map((_, index) => `criterion:${region.scopeId}:${index}` as const);
    const requirementDefinitions = delta.materialRequirements?.length ? delta.materialRequirements : taskScopes.map((item) => ({ key: item.key, text: item.objective, criterion: item.acceptanceCriteria[0]! }));
    network.materialRequirements = requirementDefinitions.map((item) => {
      const ownerIndex = taskScopes.findIndex((scope) => scope.acceptanceCriteria.some((criterion) => normalize(criterion) === normalize(item.criterion)));
      const owner = taskScopes[ownerIndex]!;
      const criterionIndex = owner.acceptanceCriteria.findIndex((criterion) => normalize(criterion) === normalize(item.criterion));
      const scopeId = `scope:${region.id}:${slug(owner.key)}` as ScopeId;
      return { id: `requirement:${slug(item.key)}` as RequirementId, key: slug(item.key), text: normalize(item.text), scopeId, criterionId: `criterion:${scopeId}:${criterionIndex}` as CriterionId };
    });
    for (const [index, scope] of delta.taskScopes.entries()) {
      const scopeId = `scope:${region.id}:${slug(scope.key)}` as const;
      if (network.regions.some((item) => item.scopeId === scopeId)) throw new Error(`Duplicate root task scope ownership: ${scopeId}`);
      const childId = `r${network.nextRegionId++}`;
      const requirementKeys = scope.requirementKeys?.length ? scope.requirementKeys.map(slug) : delta.materialRequirements?.length ? [] : [slug(scope.key)];
      const requirementIds = requirementKeys.map((key) => `requirement:${key}` as RequirementId);
      network.regions.push({ id: childId, key: normalize(scope.key), parentId: region.id, edge: "partOf", lod: region.lod + 1, objective: normalize(scope.objective), delivery: scope.delivery, allowedVariables: [...scope.allowedVariables], acceptanceCriteria: [...scope.acceptanceCriteria], coveredCriteria: [index], status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [], scopeId, criterionIds: scope.acceptanceCriteria.map((_, criterionIndex) => `criterion:${scopeId}:${criterionIndex}` as const), domainPhase: "inspecting", domainFingerprint: null, acceptedFingerprint: null, cegarRound: 0, challengeVerdict: null, noProgressFingerprint: null, noProgressCount: 0, requirementIds, dependencyScopeIds: [...(scope.dependencyScopeIds ?? [])] as ScopeId[], mutationResources: [...new Set(scope.mutationResources ?? [])].sort(), selectionAge: 0 });
    }
    region.requirementIds = network.materialRequirements.map((item) => item.id);
    transitionRegion(region, "selected", undefined, "collapsed");
    changed = true;
  } else if (activation.capability === "inspect" && region.edge === "root" && delta.materialRequirements?.length) {
    network.materialRequirements = delta.materialRequirements.map((item) => {
      const criterionIndex = region.acceptanceCriteria.findIndex((criterion) => normalize(criterion) === normalize(item.criterion));
      if (criterionIndex < 0) throw new Error(`Material requirement ${item.key} cites an unknown root criterion.`);
      return { id: `requirement:${slug(item.key)}` as RequirementId, key: slug(item.key), text: normalize(item.text), scopeId: region.scopeId, criterionId: region.criterionIds[criterionIndex]! };
    });
    region.requirementIds = network.materialRequirements.map((item) => item.id);
  }
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  const localEvidence = mergeEvidence(network, region, delta.evidence);
  if (activation.capability === "inspect" && region.edge === "root" && delta.taskDispositions?.length) {
    network.taskDispositions = delta.taskDispositions.map((item) => ({ ...item, key: slug(item.key), request: normalize(item.request), reason: normalize(item.reason), evidenceRefs: [...new Set(item.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref))].sort() }));
    changed = true;
  }
  for (const validation of delta.validations ?? []) {
    const claim = network.evidence.find((item) => item.id === validation.claimRef && item.kind === "inference");
    if (!claim || claim.status === "rejected") continue;
    if (validation.verdict === "unresolved") continue;
    const resolvedRefs = [...new Set(validation.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref))];
    const grounded = resolvedRefs.length > 0 && resolvedRefs.every((ref) => ref === "task" || network.evidence.some((item) => item.id === ref && item.kind !== "inference" && (item.status ?? "confirmed") === "confirmed"));
    if (!grounded) continue;
    claim.status = validation.verdict;
    claim.validationEvidenceRefs = resolvedRefs;
    claim.validationReason = normalize(validation.reason);
    changed = true;
  }
  for (const declaration of delta.variables ?? []) {
    const name = slug(declaration.name);
    if (!name || name === "task" || network.variables.some((item) => item.name === name)) continue;
    const seedLabels: string[] = [];
    for (const raw of declaration.seedLabels ?? []) {
      const label = normalize(raw);
      if (!label || seedLabels.some((existing) => slug(existing) === slug(label))) continue;
      seedLabels.push(label);
    }
    network.variables.push({ id: `v${network.nextVariableId++}`, name, ownerRegionId: region.id, seedLabels });
    changed = true;
  }
  if (activation.capability === "inspect" && delta.certifiedVerdict) {
    const evidenceIds = delta.certifiedVerdict.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((item) => item.id === ref));
    const id = candidateId(region.id, "certified-verdict");
    const candidate: SolutionCandidate = { id, regionId: region.id, key: "certified-verdict", proposition: normalize(delta.certifiedVerdict.proposition), status: "selected", declaredStatus: "selected", evidenceIds, declaredEvidenceIds: evidenceIds, eliminationReasons: [], declaredEliminationReasons: [], stances: [], createdRevision: network.revision + 1, sourceActivationId: activation.id };
    network.candidates = network.candidates.filter((item) => item.regionId !== region.id).concat(candidate);
    region.candidateIds = [id]; region.selectedCandidateIds = [id]; region.mutationResources = [...new Set(delta.certifiedVerdict.mutationResources)].sort();
    region.certifiedLeaf = { criterionIds: [...region.criterionIds], implementationScope: normalize(delta.certifiedVerdict.implementationScope), evidenceRefs: evidenceIds };
    region.domainFingerprint = domainFingerprint(network, region.id); region.acceptedFingerprint = region.domainFingerprint; region.challengeVerdict = "accept";
    transitionRegion(region, "selected", undefined, "actionable");
    changed = true;
  }
  const incomingCandidateIds = new Set<string>();
  for (const item of resolvedAnswer ? [] : delta.candidates) {
    const id = candidateId(region.id, item.key);
    if (incomingCandidateIds.has(id)) throw new Error(`Alternative "${item.key}" duplicates another candidate key in the same result.`);
    incomingCandidateIds.add(id);
  }
  for (const item of resolvedAnswer ? [] : delta.candidates) {
    const id = candidateId(region.id, item.key);
    let candidate = network.candidates.find((existing) => existing.id === id);
    const evidenceIds = item.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    const stances = resolveStances(network, region.id, item.stances ?? []);
    const signature = candidateSignature(item.proposition, stances);
    const duplicate = network.candidates.find((existing) => existing.regionId === region.id && existing.id !== id && candidateSignature(existing.proposition, existing.stances ?? []) === signature);
    if (duplicate) throw new Error(`Alternative "${item.key}" duplicates established candidate "${duplicate.key}" by normalized proposition and stances. Reuse the established candidate key.`);
    // Legacy deltas can describe candidates, but cannot leave a latent commitment for a later acceptance to resurrect.
    const authoredStatus = item.outcome === "eliminated" || item.outcome === "selected" ? "possible" : item.outcome;
    if (!candidate) {
      candidate = { id, regionId: region.id, key: item.key, proposition: normalize(item.proposition), status: authoredStatus, declaredStatus: authoredStatus, evidenceIds, declaredEvidenceIds: evidenceIds, eliminationReasons: [], declaredEliminationReasons: [], stances, createdRevision: network.revision + 1, sourceActivationId: activation.id };
      network.candidates.push(candidate); region.candidateIds.push(id); changed = true;
    } else {
      const serialized = JSON.stringify(candidate);
      candidate.proposition = normalize(item.proposition); candidate.status = authoredStatus; candidate.declaredStatus = authoredStatus; candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])]; candidate.declaredEvidenceIds = [...candidate.evidenceIds]; candidate.eliminationReasons = []; candidate.declaredEliminationReasons = []; candidate.stances = stances;
      if (JSON.stringify(candidate) !== serialized) changed = true;
    }
  }
  if (resolvedAnswer) {
    region.delivery = "answer";
    region.answer = normalize(resolvedAnswer.answer);
    region.acceptanceCriteria = [...new Set(resolvedAnswer.acceptanceCriteria.map(normalize).filter(Boolean))];
    region.criterionIds = region.acceptanceCriteria.map((_, index) => `criterion:${region.scopeId}:${index}` as const);
    const id = candidateId(region.id, "resolved-answer");
    const evidenceIds = resolvedAnswer.evidenceRefs
      .map((ref) => localEvidence.get(ref) ?? ref)
      .filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    let candidate = network.candidates.find((item) => item.id === id);
    if (!candidate) {
      candidate = { id, regionId: region.id, key: "resolved-answer", proposition: region.answer, status: "selected", declaredStatus: "selected", evidenceIds, declaredEvidenceIds: evidenceIds, eliminationReasons: [], declaredEliminationReasons: [], stances: [], createdRevision: network.revision + 1, sourceActivationId: activation.id };
      network.candidates.push(candidate);
      region.candidateIds.push(id);
    } else {
      candidate.proposition = region.answer;
      candidate.status = "selected";
      candidate.declaredStatus = "selected";
      candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])];
      candidate.declaredEvidenceIds = [...candidate.evidenceIds];
    }
    for (const other of network.candidates.filter((item) => item.regionId === region.id && item.id !== id && item.status === "selected")) { other.status = "possible"; other.declaredStatus = "possible"; }
    region.selectedCandidateIds = [id];
    addArtifact(network, region, activation.id, { kind: "answer", summary: region.answer });
    transitionRegion(region, "selected", undefined, "implemented");
    changed = true;
  }
  for (const item of resolvedAnswer ? [] : delta.constraints) {
    if (!["requires", "excludes", "supports", "refutes", "equivalent"].includes(item.kind)) throw new Error(`Unknown constraint kind "${String(item.kind)}".`);
    const coordinate = coordinateOf(network, item.target);
    const subject = localEvidence.get(item.subject) ?? candidateRef(network, region.id, item.subject); const target = localEvidence.get(item.target) ?? (coordinate ? `${coordinate.variableId}:${coordinate.valueLabel}` : candidateRef(network, region.id, item.target));
    if (!knownRef(network, subject) || !knownRef(network, target)) throw new Error(`Constraint ${item.kind} cites unknown endpoint(s): ${item.subject} -> ${item.target}.`);
    const evidenceRefs = [...new Set((item.evidenceRefs ?? []).map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => ref === "task" || network.evidence.some((evidence) => evidence.id === ref)))];
    const incomingSourceKind = item.sourceKind ?? "model-inference";
    const candidatePair = network.candidates.some((candidate) => candidate.id === subject) && network.candidates.some((candidate) => candidate.id === target);
    const symmetric = candidatePair && (item.kind === "excludes" || item.kind === "equivalent");
    const [identitySubject, identityTarget] = symmetric && subject.localeCompare(target) > 0 ? [target, subject] : [subject, target];
    const existing = network.constraints.find((constraint) => {
      if (constraint.kind !== item.kind) return false;
      const existingCandidatePair = network.candidates.some((candidate) => candidate.id === constraint.subject) && network.candidates.some((candidate) => candidate.id === constraint.target);
      const existingSymmetric = existingCandidatePair && (constraint.kind === "excludes" || constraint.kind === "equivalent");
      const [left, right] = existingSymmetric && constraint.subject.localeCompare(constraint.target) > 0 ? [constraint.target, constraint.subject] : [constraint.subject, constraint.target];
      return left === identitySubject && right === identityTarget;
    });
    if (existing) {
      const mergedEvidenceRefs = [...new Set([...existing.evidenceRefs, ...evidenceRefs])].sort();
      const mergedReason = [normalize(existing.reason), normalize(item.reason)].filter(Boolean).sort()[0] ?? "";
      const provenanceRank: Record<SolutionConstraint["sourceKind"], number> = { "model-inference": 0, "repo-evidence": 1, "user-task": 2 };
      const existingSourceKind = existing.sourceKind ?? "model-inference";
      const mergedSourceKind = provenanceRank[incomingSourceKind] > provenanceRank[existingSourceKind] ? incomingSourceKind : existingSourceKind;
      if (existing.evidenceRefs.join("\0") !== mergedEvidenceRefs.join("\0") || existing.reason !== mergedReason || existing.sourceKind !== mergedSourceKind) {
        existing.evidenceRefs = mergedEvidenceRefs;
        existing.reason = mergedReason;
        existing.sourceKind = mergedSourceKind;
        changed = true;
      }
      if (!region.constraintIds.includes(existing.id)) region.constraintIds.push(existing.id);
      continue;
    }
    const constraint = { ...item, subject, target, reason: normalize(item.reason), id: `c${network.nextConstraintId++}`, sourceActivationId: activation.id, sourceKind: incomingSourceKind, evidenceRefs, createdRevision: network.revision + 1 };
    network.constraints.push(constraint); region.constraintIds.push(constraint.id); changed = true;
  }
  if (region.delivery === "answer" && delta.answer && delta.answer !== region.answer) { region.answer = normalize(delta.answer); changed = true; }
  // Formation: facts gathered for an unformed region make it ready for synthesis.
  if (activation.capability === "inspect" && !delta.certifiedVerdict) { transitionRegion(region, region.candidateIds.length ? "challenging" : "ungenerated", undefined, region.status === "unformed" ? "superposed" : undefined); changed = true; }
  assertAcyclicPrimalGraph(network);
  if (changed) network.revision++;
  for (const request of delta.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  return propagateNetwork(network);
}

export function validateRefinementOutput(state: SolutionLodState, regionId: string, output: RefinementOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  rejectUnrequestedDeferredWork(state, [output.certifiedLeaf?.implementationScope, ...output.children.flatMap((item) => [item.objective, ...item.acceptanceCriteria])]);
  if (output.evidence.some((item) => item.kind !== "inference")) throw new Error("Refinement is tool-free and cannot create confirmed repository/tool/user evidence. Reuse supplied facts or request one specific inspection.");
  // Degenerate case: an unauthored criteria list leaves one anonymous implicit criterion.
  // Any child then trivially addresses position 0 — normalize silently instead of demanding
  // impossible mappings, but keep genuine coverage errors loud for authored lists.
  const authoredCount = region.acceptanceCriteria.length;
  const criteriaCount = Math.max(authoredCount, 1);
  const inRange = (value: number) => Number.isInteger(value) && value >= 0 && value < criteriaCount;
  if (Boolean(output.certifiedLeaf) === Boolean(output.children.length)) throw new Error("Refinement must return either one certified leaf contract or one or more children, never both or neither.");
  if (output.certifiedLeaf) {
    if (/\b(?:estimate|later|defer(?:red)?|follow-up)\b/i.test(output.certifiedLeaf.implementationScope)) throw new Error("A certified leaf must name bounded implementable work, not an estimate or deferred follow-up.");
    for (const ref of output.certifiedLeaf.evidenceRefs) if (!knownRef(state.network, ref) || !isConfirmedEvidence(state.network, ref)) throw new Error(`Certified leaf cites unresolved or stale evidence reference ${ref}.`);
    return;
  }
  const covered = new Set<number>();
  const seenKeys = new Set<string>();
  const requirementOwners = new Map((region.requirementIds ?? []).map((id) => [id, 0]));
  const knownScopes = new Set(state.network.regions.map((item) => item.scopeId));
  const proposedScopes = new Set(output.children.map((item) => `scope:${region.id}:${normalize(item.key)}`));
  for (const child of output.children) {
    const key = normalize(child.key);
    if (seenKeys.has(key)) throw new Error(`Two children share the name "${child.key}". Give each child a distinct stable name.`);
    seenKeys.add(key);
    if (!child.acceptanceCriteria.length)
      throw new Error(`Child "${child.key}" carries no success criterion of its own. Give every child at least one observable condition that proves it is done, so the scheduler can tell whether it needs further splitting.`);
    const normalizedCovered = authoredCount === 0 && child.coveredCriteria.length === 0 ? [0] : child.coveredCriteria;
    if (!normalizedCovered.length || !normalizedCovered.every(inRange))
      throw new Error(`Child "${child.key}" does not address any known success criterion. Link it to at least one criterion position of the parent — valid positions here: 0..${criteriaCount - 1}${region.acceptanceCriteria.map((criterion, index) => `; ${index}: ${criterion}`).join("")}.`);
    for (const index of normalizedCovered) covered.add(index);
    for (const index of normalizedCovered) if (output.children.some((other) => other !== child && (authoredCount === 0 && other.coveredCriteria.length === 0 ? [0] : other.coveredCriteria).includes(index))) throw new Error(`Parent criterion ${index} has duplicate child ownership. Every criterion must belong to exactly one typed scope.`);
    for (const requirementId of child.requirementIds ?? []) {
      if (!requirementOwners.has(requirementId as RequirementId)) throw new Error(`Child "${child.key}" cites requirement ${requirementId} outside its parent scope.`);
      requirementOwners.set(requirementId as RequirementId, requirementOwners.get(requirementId as RequirementId)! + 1);
    }
    for (const dependency of child.dependencyScopeIds ?? []) if (!knownScopes.has(dependency as ScopeId) && !proposedScopes.has(dependency)) throw new Error(`Child "${child.key}" cites unknown semantic dependency ${dependency}.`);
    if (child.mutationResources?.some((resource) => !normalize(resource))) throw new Error(`Child "${child.key}" has an empty mutation resource path.`);
  }
  const missing = Array.from({ length: criteriaCount }, (_, index) => index).filter((index) => !covered.has(index));
  if (missing.length)
    throw new Error(`The children do not collectively cover the parent success criteria: no child addresses criterion position(s) ${missing.join(", ")}. Add or extend a child so every criterion is covered.`);
  const invalidRequirements = [...requirementOwners].filter(([, count]) => count !== 1);
  if (invalidRequirements.length) throw new Error(`Every material requirement must have exactly one child owner: ${invalidRequirements.map(([id, count]) => `${id}=${count}`).join(", ")}.`);
}

export function validateImplementationOutput(state: SolutionLodState, regionId: string, output: ImplementationOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) throw new Error(`Unknown implementation region ${regionId}`);
  rejectUnrequestedDeferredWork(state, [output.summary, output.blocker]);
  if (region.delivery === "change" && (!region.certifiedLeaf || !hasSelectedImplementationFamily(state.network, region))) throw new Error(`Implementation requires one accepted selected implementation family and a certified leaf contract for ${regionId}.`);
  if (output.status === "blocked") {
    if (!normalize(output.blocker ?? output.summary)) throw new Error("A blocked implementation must name the concrete missing fact or conflict.");
    return;
  }
  if (!output.checks.length) throw new Error("Implementation completion requires at least one focused check with observable evidence.");
  const failed = output.checks.filter((check) => !check.passed);
  if (failed.length) throw new Error(`Implementation cannot complete while checks fail: ${failed.map((item) => item.name).join(", ")}.`);
  if (output.checks.some((check) => !normalize(check.evidence))) throw new Error("Every implementation check must include observable evidence.");
  if (output.status === "already-satisfied" && output.changedFiles.length) throw new Error("An already-satisfied implementation cannot report changed files.");
  if (taskReferencesTodo(state.originalTask) && !normalize(output.todoDisposition ?? "")) throw new Error("A task that references TODO requires explicit TODO disposition evidence.");
}

export function validateVerificationOutput(state: SolutionLodState, regionId: string, output: VerificationOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) throw new Error(`Unknown verification region ${regionId}`);
  rejectUnrequestedDeferredWork(state, [output.summary, ...output.findings.map((item) => item.problem)]);
  const live = new Map(state.network.regions.map((item) => [item.id, item]));
  const findingKeys = new Set<string>();
  for (const finding of output.findings) {
    const target = live.get(finding.regionId);
    if (!target) throw new Error(`Verification finding references missing region ${finding.regionId}.`);
    if (!target.criterionIds.includes(finding.criterionId as SolutionRegion["criterionIds"][number])) throw new Error(`Verification finding does not name an exact criterion identity of ${finding.regionId}: ${finding.criterionId}`);
    if (!normalize(finding.problem) || !normalize(finding.evidence)) throw new Error("Every verification finding requires a concrete problem and observed evidence.");
    const key = `${finding.regionId}\0${finding.criterionId}`;
    if (findingKeys.has(key)) throw new Error(`Verification contains multiple findings for the same exact criterion ${finding.criterionId}.`);
    findingKeys.add(key);
    if (output.verdict === "repair" && finding.regionId !== regionId) throw new Error("A repair verdict may target only the region being verified; use reopen for an earlier choice.");
  }
  if (output.verdict === "pass") {
    if (output.findings.length) throw new Error("A passing verification cannot contain defect findings.");
    if (!output.checks.length || output.checks.some((check) => !check.passed || !normalize(check.evidence)))
      throw new Error("Verification may pass only with passing checks containing observable evidence.");
    for (const criterion of region.acceptanceCriteria) {
      if (!output.checks.some((check) => normalize(`${check.name} ${check.evidence}`).includes(normalize(criterion))))
        throw new Error(`Verification pass has no criterion-specific evidence for: ${criterion}`);
    }
    const evidence = output.completionEvidence;
    if (region.delivery === "change" && !evidence) throw new Error("Verification pass requires deterministic implementation, direct-test, correctness-review, and release-gate completion evidence.");
    const measuredFiles = region.artifactIds.map((id) => state.network.artifacts.find((item) => item.id === id)).filter((item) => item?.kind === "file" && !item.historical).map((item) => item!.path!);
    if (region.delivery === "change") {
      const criterionIds = evidence!.criterionIds ?? region.criterionIds;
      const implementationOutcome = evidence!.implementationOutcome ?? (measuredFiles.length ? "changed" : "already-satisfied");
      if (JSON.stringify([...new Set(criterionIds)].sort()) !== JSON.stringify([...region.criterionIds].sort())) throw new Error("Verification must confirm every exact criterion identity.");
      if (evidence!.fullChecks.some((check) => !normalize(check))) throw new Error("Every configured release gate requires observable evidence.");
      if (taskReferencesTodo(state.originalTask) && !normalize(evidence!.todoDisposition ?? "")) throw new Error("A task that references TODO requires explicit TODO disposition evidence.");
      if (implementationOutcome === "changed" && (!measuredFiles.length || JSON.stringify([...new Set(evidence!.changedFiles)].sort()) !== JSON.stringify([...new Set(measuredFiles)].sort()))) throw new Error("Changed implementation evidence must exactly match non-empty measured implementation artifacts.");
      if (implementationOutcome === "already-satisfied" && (measuredFiles.length || evidence!.changedFiles.length || (evidence!.inspectionEvidenceRefs?.length ?? 0) > 0 && evidence!.inspectionEvidenceRefs!.some((ref) => !isConfirmedEvidence(state.network, ref)))) throw new Error("Already-satisfied completion requires confirmed inspection evidence, no measured changes, and verifier confirmation of every criterion.");
    }
  } else if (!output.findings.length) throw new Error(`${output.verdict} verification requires at least one criterion-linked finding.`);
  if (output.findings.some((finding) => finding.severity === "high") && output.verdict === "pass") throw new Error("High-severity review findings block completion.");
}

export function validatePresentationAnswer(state: SolutionLodState, regionId: string, answer: string): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region || region.delivery !== "answer") throw new Error(`Unknown answer region ${regionId}.`);
  rejectUnrequestedDeferredWork(state, [answer]);
  if (!normalize(answer)) throw new Error("Presentation requires a non-empty answer.");
}

function retractRegion(network: SolutionNetwork, regionId: string): void {
  purgeDescendants(network, regionId);
  network.regions = network.regions.filter((item) => item.id !== regionId);
  network.candidates = network.candidates.map((item) => item.regionId === regionId ? { ...item, historical: true } : item);
  network.variables = network.variables.map((item) => item.ownerRegionId === regionId ? { ...item, historical: true } : item);
  network.artifacts = network.artifacts.map((item) => item.regionId === regionId ? { ...item, historical: true } : item);
  network.activations = network.activations.map((item) => item.regionId !== regionId ? item : { ...item, historical: true, status: item.status === "queued" || item.status === "running" ? "superseded" : item.status, error: item.error ?? `Historical activation: conditional region ${regionId} was retracted.` });
  const retired = new Set([...network.candidates.filter((item) => item.historical).map((item) => item.id), ...network.variables.filter((item) => item.historical).map((item) => item.id)]);
  network.constraints = network.constraints.map((item) => retired.has(item.subject) || retired.has(item.target) || [...retired].some((ref) => item.subject.startsWith(`${ref}:`) || item.target.startsWith(`${ref}:`)) ? { ...item, historical: true } : item);
  network.materialRequirements = network.materialRequirements?.filter((requirement) => network.regions.some((item) => item.scopeId === requirement.scopeId));
}

function conditionalDefinition(definition: RefinementOutput["children"][number]): string {
  return hash({ key: normalize(definition.key), objective: normalize(definition.objective), edge: definition.edge, delivery: definition.delivery, allowedVariables: [...definition.allowedVariables].map(normalize).sort(), acceptanceCriteria: [...definition.acceptanceCriteria].map(normalize), coveredCriteria: [...definition.coveredCriteria].sort((a, b) => a - b), requirementIds: [...(definition.requirementIds ?? [])].sort(), dependencyScopeIds: [...(definition.dependencyScopeIds ?? [])].sort(), mutationResources: [...(definition.mutationResources ?? [])].map(normalize).sort() });
}

function resetConditionalRegion(network: SolutionNetwork, region: SolutionRegion): void {
  purgeDescendants(network, region.id);
  network.candidates = network.candidates.map((item) => item.regionId === region.id ? { ...item, historical: true } : item);
  network.variables = network.variables.map((item) => item.ownerRegionId === region.id ? { ...item, historical: true } : item);
  network.artifacts = network.artifacts.map((item) => item.regionId === region.id ? { ...item, historical: true } : item);
  network.activations = network.activations.map((item) => item.regionId !== region.id ? item : { ...item, historical: true, status: item.status === "queued" || item.status === "running" ? "superseded" : item.status, error: item.error ?? `Historical activation: conditional definition for ${region.id} changed.` });
  const retired = new Set([...network.candidates.filter((item) => item.historical).map((item) => item.id), ...network.variables.filter((item) => item.historical).map((item) => item.id)]);
  network.constraints = network.constraints.map((item) => retired.has(item.subject) || retired.has(item.target) || [...retired].some((ref) => item.subject.startsWith(`${ref}:`) || item.target.startsWith(`${ref}:`)) ? { ...item, historical: true } : item);
  region.candidateIds = []; region.selectedCandidateIds = []; region.constraintIds = []; region.evidenceIds = []; region.activationIds = []; region.artifactIds = [];
  region.acceptedFingerprint = null; region.domainFingerprint = null; region.challengeVerdict = null; region.certifiedLeaf = undefined; region.answer = undefined; region.reopens = 0; region.reopenFingerprint = null; region.noProgressCount = 0; region.noProgressFingerprint = null; region.convergenceCycles = undefined;
  transitionRegion(region, "inspecting", undefined, "unformed");
}

export function mergeRefinementOutput(networkInput: SolutionNetwork, activationId: string, output: RefinementOutput): SolutionNetwork {
  const network = cloneNetwork(networkInput);
  const activation = network.activations.find((item) => item.id === activationId);
  if (!activation) throw new Error(`Unknown activation ${activationId}`);
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Unknown activation region ${activation.regionId}`);
  activation.status = "completed";
  mergeEvidence(network, region, output.evidence);
  const parentSelection = region.selectedCandidateIds[0];
  if (output.certifiedLeaf) {
    region.certifiedLeaf = { criterionIds: [...region.criterionIds], implementationScope: normalize(output.certifiedLeaf.implementationScope), evidenceRefs: [...new Set(output.certifiedLeaf.evidenceRefs)] };
    transitionRegion(region, "selected", undefined, "actionable");
    network.revision++;
    return propagateNetwork(network);
  }
  const incomingKeys = new Set(output.children.map((item) => normalize(item.key)));
  for (const child of network.regions.filter((item) => item.parentId === region.id)) if (!incomingKeys.has(normalize(child.key))) retractRegion(network, child.id);
  for (const definition of output.children) {
    const key = normalize(definition.key);
    const existing = network.regions.find((item) => item.parentId === region.id && normalize(item.key) === key);
    // Mirror validation's degenerate-criteria normalization so stored children stay consistent.
    const coveredCriteria = region.acceptanceCriteria.length === 0 && definition.coveredCriteria.length === 0 ? [0] : [...definition.coveredCriteria];
    const definitionFingerprint = conditionalDefinition(definition);
    if (existing) {
      if (existing.definitionFingerprint !== definitionFingerprint) resetConditionalRegion(network, existing);
      existing.key = key; existing.objective = normalize(definition.objective); existing.edge = definition.edge; existing.delivery = definition.delivery ?? region.delivery; existing.allowedVariables = [...new Set(definition.allowedVariables.map(normalize).filter(Boolean))].sort(); existing.acceptanceCriteria = definition.acceptanceCriteria.map(normalize); existing.coveredCriteria = coveredCriteria.sort((a, b) => a - b); existing.criterionIds = definition.acceptanceCriteria.map((_, index) => `criterion:${existing.scopeId}:${index}` as const); existing.requirementIds = [...new Set(definition.requirementIds ?? [])].sort() as RequirementId[]; existing.dependencyScopeIds = [...new Set(definition.dependencyScopeIds ?? [])].sort() as ScopeId[]; existing.mutationResources = [...new Set((definition.mutationResources ?? []).map(normalize))].sort(); existing.definitionFingerprint = definitionFingerprint;
      continue;
    }
    network.regions.push({
      id: `r${network.nextRegionId++}`, key, parentId: region.id, parentCandidateId: parentSelection, edge: definition.edge,
      lod: region.lod + 1, objective: normalize(definition.objective), delivery: definition.delivery ?? region.delivery,
      allowedVariables: [...new Set(definition.allowedVariables.map(normalize).filter(Boolean))].sort(), acceptanceCriteria: definition.acceptanceCriteria.map(normalize), coveredCriteria: coveredCriteria.sort((a, b) => a - b),
      status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [], scopeId: `scope:${region.id}:${key}`, criterionIds: definition.acceptanceCriteria.map((_, index) => `criterion:${region.id}:${key}:${index}` as const), domainPhase: "inspecting", domainFingerprint: null, acceptedFingerprint: null, cegarRound: 0, challengeVerdict: null, noProgressFingerprint: null, noProgressCount: 0, requirementIds: [...new Set(definition.requirementIds ?? [])].sort() as RequirementId[], dependencyScopeIds: [...new Set(definition.dependencyScopeIds ?? [])].sort() as ScopeId[], mutationResources: [...new Set((definition.mutationResources ?? []).map(normalize))].sort(), definitionFingerprint, selectionAge: 0,
    });
  }
  transitionRegion(region, "selected", undefined, "collapsed");
  network.revision++;
  return propagateNetwork(network);
}

export function queueActivation(networkInput: SolutionNetwork, capability: Capability, regionId: string, request: string, expectedDelta: string, contextRefs: string[] = []): SolutionNetwork {
  const network = cloneNetwork(networkInput); addActivation(network, { capability, regionId, request, expectedDelta, contextRefs }); return network;
}

function queueSynthesis(networkInput: SolutionNetwork, operation: SynthesisOperation, regionId: string, request: string, expectedDelta: string, contextRefs: string[]): SolutionNetwork {
  const network = cloneNetwork(networkInput);
  const region = network.regions.find((item) => item.id === regionId);
  addActivation(network, { capability: "synthesize", operation, domainFingerprint: region?.domainFingerprint, regionId, request, expectedDelta, contextRefs });
  return network;
}

export function markActivation(networkInput: SolutionNetwork, activationId: string, status: Activation["status"], sessionId?: string, error?: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); if (!activation) return network;
  activation.status = status; activation.sessionId = sessionId ?? activation.sessionId; activation.error = error; return network;
}

export function setRegionStatus(networkInput: SolutionNetwork, regionId: string, status: SolutionRegion["status"]): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (region) transitionRegion(region, status === "blocked" || status === "stalled" ? "blocked" : region.domainPhase, region.blockedReason, status); return network;
}

function addArtifact(network: SolutionNetwork, region: SolutionRegion, activationId: string, artifact: Omit<SolutionNetwork["artifacts"][number], "id" | "regionId" | "activationId">): void {
  const item = { ...artifact, id: `x${network.nextArtifactId++}`, regionId: region.id, activationId, createdRevision: network.revision + 1 };
  network.artifacts.push(item); region.artifactIds.push(item.id);
}

export function completeImplementation(networkInput: SolutionNetwork, activationId: string, output: ImplementationOutput, actualChangedFiles: string[]): SolutionNetwork {
  let network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed";
  for (const file of [...new Set(actualChangedFiles)]) addArtifact(network, region, activationId, { kind: "file", path: file, summary: `Changed ${file}` });
  const reportedOnly = [...new Set(output.changedFiles)].filter((file) => !actualChangedFiles.includes(file));
  if (reportedOnly.length) addArtifact(network, region, activationId, { kind: "check", summary: `Unconfirmed model-reported files: ${reportedOnly.join(", ")}`, passed: false });
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  if (output.status === "completed" && !actualChangedFiles.length) {
    addArtifact(network, region, activationId, { kind: "check", summary: "Implementation rejected: no measured workspace change", passed: false });
    transitionRegion(region, "selected", "A change task cannot complete without a measured workspace-change artifact.", "actionable");
  } else if (output.status === "already-satisfied") {
    addArtifact(network, region, activationId, { kind: "check", summary: `Already-satisfied proof: ${output.checks.map((item) => `${item.name}: ${item.evidence}`).join("; ")}`, passed: true });
    transitionRegion(region, "selected", undefined, "implemented");
  } else if (output.status === "completed") transitionRegion(region, "selected", undefined, "implemented");
  else if (countReopen(network, region)) {
    transitionRegion(region, "challenging", undefined, "superposed"); region.contradiction = output.blocker || output.summary || "Implementation reported a missing prerequisite."; region.selectedCandidateIds = [];
    region.acceptedFingerprint = null; region.challengeVerdict = null; region.certifiedLeaf = undefined; transitionRegion(region, "challenging");
    for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) { candidate.status = "possible"; candidate.declaredStatus = "possible"; }
  }
  network.revision++; return network;
}

export function completeVerification(networkInput: SolutionNetwork, activationId: string, output: VerificationOutput): SolutionNetwork {
  let network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed";
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  if (output.verdict === "pass" && output.completionEvidence) addArtifact(network, region, activationId, { kind: "completion-review", summary: output.completionEvidence.correctnessReview, passed: true, implementationOutcome: output.completionEvidence.implementationOutcome ?? (output.completionEvidence.changedFiles.length ? "changed" : "already-satisfied"), criterionIds: (output.completionEvidence.criterionIds ?? region.criterionIds) as CriterionId[], focusedTests: output.completionEvidence.focusedTests, fullChecks: output.completionEvidence.fullChecks, todoDisposition: output.completionEvidence.todoDisposition, findings: [] });
  for (const finding of output.findings) addArtifact(network, region, activationId, { kind: "completion-review", summary: finding.problem, passed: false, criterionIds: [finding.criterionId as CriterionId], findings: [{ ...finding, criterionId: finding.criterionId as CriterionId, repairRegionId: finding.repairRegionId ?? finding.regionId }] });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  const unresolved = [...new Set(output.findings.map((item) => item.criterionId as CriterionId))].sort();
  if (!recordSemanticCycle(network, region, "verify", semanticInputFingerprint(network, region), hash({ verdict: output.verdict, findings: output.findings.map((item) => ({ regionId: item.regionId, criterionId: item.criterionId, problem: normalize(item.problem), evidence: normalize(item.evidence) })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) }), unresolved)) { network.revision++; return network; }
  if (output.verdict === "pass") transitionRegion(region, "selected", undefined, "verified");
  else if (output.verdict === "repair") {
    for (const targetId of new Set(output.findings.map((item) => item.regionId))) {
      const target = network.regions.find((item) => item.id === targetId);
      if (target && recordSemanticCycle(network, target, "repair", semanticInputFingerprint(network, target), hash(unresolved.filter((id) => target.criterionIds.includes(id))), unresolved.filter((id) => target.criterionIds.includes(id)))) transitionRegion(target, "selected", undefined, "actionable");
    }
  } else if (output.verdict === "reopen") {
    for (const targetId of new Set(output.findings.map((item) => item.regionId)))
      network = reopenRegion(network, targetId, output.summary || output.findings.filter((item) => item.regionId === targetId).map((item) => item.problem).join("; "));
  } else {
    transitionRegion(region, "blocked", output.summary || output.findings.map((item) => item.problem).join("; "), "blocked");
  }
  network.revision++; return network;
}

export function completePresentation(networkInput: SolutionNetwork, activationId: string, answer: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed"; const input = semanticInputFingerprint(network, region); const output = hash(normalize(answer)); region.answer = answer; addArtifact(network, region, activationId, { kind: "answer", summary: answer }); if (recordSemanticCycle(network, region, "present", input, output, region.criterionIds)) transitionRegion(region, "selected", undefined, "implemented"); network.revision++; return network;
}

/** A content fingerprint over the region's evidence and artifact contents: fresh ids carrying identical content keep it stable, so only genuinely new content can reset the reopen counter. */
function regionContentFingerprint(network: SolutionNetwork, region: SolutionRegion): string {
  const evidence = [...new Set(region.evidenceIds.map((id) => network.evidence.find((item) => item.id === id)?.fingerprint ?? `missing:${id}`))].sort();
  const artifacts = [...new Set(region.artifactIds.map((id) => network.artifacts.find((item) => item.id === id)).filter((item): item is SolutionNetwork["artifacts"][number] => Boolean(item)).map((item) => `${item.kind}\0${item.path ?? ""}\0${item.summary}\0${item.passed ?? ""}`))].sort();
  return createHash("sha256").update(`${evidence.join("\0")}\n${artifacts.join("\0")}`).digest("hex").slice(0, 16);
}

function semanticInputFingerprint(network: SolutionNetwork, region: SolutionRegion): string {
  return hash({ objective: normalize(region.objective), criteria: region.criterionIds.map((id, index) => [id, normalize(region.acceptanceCriteria[index] ?? "")]).sort(), evidence: region.evidenceIds.map((id) => network.evidence.find((item) => item.id === id)?.fingerprint ?? `missing:${id}`).sort(), files: region.artifactIds.map((id) => network.artifacts.find((item) => item.id === id)).filter((item) => item && !item.historical && item.kind === "file").map((item) => [item!.path ?? "", normalize(item!.summary)]).sort() });
}

function recordSemanticCycle(network: SolutionNetwork, region: SolutionRegion, kind: SemanticCycleKind, inputFingerprint: string, outputFingerprint: string, unresolvedCriterionIds: CriterionId[]): boolean {
  const record = { kind, inputFingerprint, outputFingerprint, unresolvedCriterionIds: [...new Set(unresolvedCriterionIds)].sort(), revision: network.revision + 1 };
  region.convergenceCycles ??= [];
  region.convergenceCycles.push(record);
  const repeated = region.convergenceCycles.filter((item) => item.kind === kind && item.inputFingerprint === inputFingerprint && item.outputFingerprint === outputFingerprint);
  const latestPresent = [...region.convergenceCycles].reverse().find((item) => item.kind === "present");
  const answerLoop = kind === "repair" && Boolean(latestPresent) && region.convergenceCycles.some((item) => item.kind === "verify" && item.revision >= latestPresent!.revision) && latestPresent!.inputFingerprint === inputFingerprint;
  if (repeated.length < MAX_SEMANTIC_CYCLES && !answerLoop) return true;
  const fingerprints = [...new Set(repeated.flatMap((item) => [item.inputFingerprint, item.outputFingerprint]))].sort();
  const criteria = [...new Set(repeated.flatMap((item) => item.unresolvedCriterionIds))].sort();
  const reason = `Region ${region.id} blocked after repeated ${kind} semantic cycle; fingerprints=${fingerprints.join(",")}; unresolvedCriterionIds=${criteria.join(",") || "none"}`;
  region.blockedDetails = { kind: answerLoop ? "answer-present-verify-repair-loop" : `${kind}-limit`, fingerprints, unresolvedCriterionIds: criteria };
  transitionRegion(region, "blocked", reason, "blocked");
  return false;
}

/**
 * Count one reopen against a region: identical evidence/artifact content accumulates the counter,
 * genuinely new content resets it, and the contentless reopen past the shared retry policy converts
 * the region to terminal "stalled" instead of reopening. Returns whether the reopen may proceed.
 */
function countReopen(network: SolutionNetwork, region: SolutionRegion): boolean {
  const fingerprint = regionContentFingerprint(network, region);
  if (fingerprint !== region.reopenFingerprint) { region.reopenFingerprint = fingerprint; region.reopens = 1; return true; }
  if (region.reopens >= SAME_REVISION_RETRY_POLICY.maxAttempts) {
    transitionRegion(region, "blocked", undefined, "stalled");
    region.contradiction = `Region ${region.id} stalled: ${region.reopens} reopens without new evidence`;
    return false;
  }
  region.reopens += 1;
  return true;
}

export function reopenRegion(networkInput: SolutionNetwork, regionId: string, reason: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (!region) return network;
  if (!recordSemanticCycle(network, region, "reopen", semanticInputFingerprint(network, region), hash(normalize(reason)), region.criterionIds)) { network.revision++; return network; }
  if (!countReopen(network, region)) return network;
  transitionRegion(region, region.candidateIds.length ? "challenging" : "inspecting", undefined, region.acceptanceCriteria.length ? "superposed" : "unformed"); region.contradiction = reason; region.selectedCandidateIds = [];
  region.acceptedFingerprint = null; region.challengeVerdict = null; region.certifiedLeaf = undefined; transitionRegion(region, region.candidateIds.length ? "challenging" : "inspecting");
  region.noProgressCount = 0; region.noProgressFingerprint = null;
  region.coveredCriteria = undefined;
  for (const candidate of network.candidates.filter((item) => item.regionId === regionId)) { candidate.status = "possible"; candidate.declaredStatus = "possible"; }
  if (!region.acceptanceCriteria.length) {
    network.candidates = network.candidates.filter((item) => item.regionId !== regionId);
    region.candidateIds = [];
  }
  purgeDescendants(network, regionId);
  network.revision++; return network;
}

export function resetPrunedRegion(networkInput: SolutionNetwork, regionId: string): SolutionNetwork {
  const network = cloneNetwork(networkInput);
  const region = network.regions.find((item) => item.id === regionId);
  if (!region) return network;
  const retired = new Set(region.candidateIds);
  network.candidates = network.candidates.map((item) => retired.has(item.id) ? { ...item, historical: true } : item);
  network.constraints = network.constraints.map((item) => retired.has(item.subject) || retired.has(item.target) ? { ...item, historical: true } : item);
  region.candidateIds = [];
  region.selectedCandidateIds = [];
  region.constraintIds = region.constraintIds.filter((id) => !network.constraints.find((item) => item.id === id)?.historical);
  region.domainFingerprint = null;
  region.acceptedFingerprint = null;
  region.challengeVerdict = null;
  region.certifiedLeaf = undefined;
  transitionRegion(region, region.acceptanceCriteria.length ? "ungenerated" : "inspecting", undefined, region.acceptanceCriteria.length ? "superposed" : "unformed");
  return network;
}

export function nextQueuedActivation(network: SolutionNetwork): Activation | undefined {
  return network.activations.filter((item) => item.status === "queued" && activationAdmitted(network, item)).sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)))[0];
}

export function activationAdmitted(network: SolutionNetwork, activation: Activation): boolean {
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region || !activationReadsCurrent(network, activation)) return false;
  if (activation.capability === "inspect") return (region.status === "unformed" || region.status === "superposed") && region.domainPhase === "inspecting";
  if (activation.capability === "synthesize") {
    if (activation.domainFingerprint !== region.domainFingerprint) return false;
    return activation.operation === "generate-domain" ? region.domainPhase === "ungenerated"
      : activation.operation === "challenge-domain" ? region.domainPhase === "challenging"
      : activation.operation === "select-candidate" && region.domainPhase === "selecting";
  }
  if (activation.capability === "refine") return region.status === "unrefined";
  if (activation.capability === "implement") return region.status === "actionable" && region.delivery === "change";
  if (activation.capability === "present") return region.status === "actionable" && region.delivery === "answer";
  if (activation.capability === "verify") return region.status === "implemented";
  return false;
}

const MUTATING_CAPABILITIES: Capability[] = ["implement", "verify"];

function mutationResourcesOverlap(left: Activation, right: Activation): boolean {
  const resources = new Set(left.mutationResources ?? []);
  return (right.mutationResources ?? []).some((resource) => resources.has(resource));
}

/**
 * Select the next activation batch. Mutating work is batched only when scopes and
 * mutation resources do not overlap; read-only work is batched on distinct regions.
 * A width of 1 reproduces sequential execution.
 */
export function selectActivationBatch(network: SolutionNetwork, width: number): Activation[] {
  const ready = (activation: Activation) => {
    const region = network.regions.find((item) => item.id === activation.regionId);
    return (region?.dependencyScopeIds ?? []).every((scopeId) => network.regions.find((item) => item.scopeId === scopeId)?.status === "verified");
  };
  const priority = (activation: Activation) => network.regions.find((item) => item.id === activation.regionId)?.selectionAge ?? 0;
  const queued = network.activations.filter((item) => item.status === "queued" && activationAdmitted(network, item) && ready(item)).sort((left, right) => priority(right) - priority(left) || left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)));
  if (!queued.length) return [];
  const mutating = MUTATING_CAPABILITIES.includes(queued[0].capability);
  const batch: Activation[] = [];
  const claimedRegions = new Set<string>();
  const claimedScopes = new Set<string>();
  for (const activation of queued) {
    if (batch.length >= width) break;
    if (MUTATING_CAPABILITIES.includes(activation.capability) !== mutating) continue;
    if (claimedRegions.has(activation.regionId)) continue;
    const scopeId = network.regions.find((item) => item.id === activation.regionId)?.scopeId;
    if (mutating && (!scopeId || claimedScopes.has(scopeId) || batch.some((item) => mutationResourcesOverlap(item, activation)))) continue;
    batch.push(activation);
    claimedRegions.add(activation.regionId);
    if (scopeId) claimedScopes.add(scopeId);
  }
  return batch;
}

export function supersedeStaleQueuedActivations(networkInput: SolutionNetwork): SolutionNetwork {
  const network = cloneNetwork(networkInput);
  for (const activation of network.activations) {
    if (activation.status !== "queued" || activationAdmitted(network, activation)) continue;
    activation.status = "superseded";
    activation.error = "Superseded: activation context changed before admission.";
  }
  return network;
}

export interface BatchApplication {
  network: SolutionNetwork;
  applied: string[];
  deferred: string[];
  failed: string[];
  superseded: string[];
}

/**
 * Apply one batch of per-task records deterministically: records are ordered by
 * (basisRevision, activationId) regardless of completion order, existing reducers apply
 * them sequentially, and propagation runs after every attempted record. Failed activations
 * can still invalidate derived locks, so their absence of a delta is not a reason to skip
 * the kernel. A final idempotent pass also covers empty or wholly superseded batches.
 * A record whose basis is outdated and whose application lands its region in a
 * contradiction is rolled back and recorded as superseded — superseded outcomes never
 * consume the failed-activation retry limit.
 */
export function applyBatchRecords(networkInput: SolutionNetwork, records: ActivationTaskResult[]): BatchApplication {
  const ordered = [...records].sort((left, right) => left.basisRevision - right.basisRevision || Number(left.activationId.slice(1)) - Number(right.activationId.slice(1)));
  let current = networkInput;
  const application: BatchApplication = { network: networkInput, applied: [], deferred: [], failed: [], superseded: [] };
  for (const record of ordered) {
    const before = current;
    const liveActivation = current.activations.find((item) => item.id === record.activationId);
    if (!liveActivation || liveActivation.status === "completed" || liveActivation.status === "superseded" || !activationReadsCurrent(current, liveActivation)) { application.superseded.push(record.activationId); current = propagateNetwork(markActivation(current, record.activationId, "superseded", record.sessionId, "Superseded: activation context changed before result admission.")); continue; }
    const stale = current.revision !== record.basisRevision;
    let refused = false;
    try {
      if (record.outcome === "applied" && record.networkDelta) {
        const delta = record.networkDelta;
        if (delta.kind === "delta") current = markActivation(mergeSolutionDelta(stateForNetwork(current), record.activationId, delta.delta), record.activationId, "completed", record.sessionId);
        else if (delta.kind === "synthesis") current = markActivation(mergeSynthesisOutput(stateForNetwork(current), record.activationId, delta.output), record.activationId, "completed", record.sessionId);
        else if (delta.kind === "refinement") current = markActivation(mergeRefinementOutput(current, record.activationId, delta.output), record.activationId, "completed", record.sessionId);
        else if (delta.kind === "implementation") current = completeImplementation(current, record.activationId, delta.output, delta.changedFiles);
        else if (delta.kind === "verification") current = completeVerification(current, record.activationId, delta.output);
        else current = completePresentation(current, record.activationId, delta.answer);
      } else {
        const message = record.error ?? "Activation task failed.";
        current = markActivation(current, record.activationId, "failed", record.sessionId, message);
        const failedActivation = current.activations.find((item) => item.id === record.activationId);
        if (failedActivation && record.retryable && record.sessionId && (record.failureKind === "transport" || record.failureKind === "inactivity")) failedActivation.recovery = { sessionId: record.sessionId, strategy: record.progressText || record.tools?.length ? "fork" : "continue", attempts: record.retries ?? 0, failureKind: record.failureKind, contextFingerprint: activationContextFingerprint(failedActivation), retryTrace: record.retryTrace?.map((trace) => ({ ...trace })) ?? [] };
        if (record.capability === "implement") {
          const changedFiles = record.changedFiles ?? [];
          if (changedFiles.length) {
            const summary = record.outcome === "deferred" ? message : `Implementation output failed but workspace mutation was retained: ${message}`;
            current = completeImplementation(current, record.activationId, { status: "blocked", summary, changedFiles, checks: [], blocker: message, activations: [] }, changedFiles);
            current = markActivation(current, record.activationId, "failed", record.sessionId, message);
            current = setRegionStatus(current, record.regionId, "blocked");
          } else current = setRegionStatus(current, record.regionId, "actionable");
        }
      }
    } catch {
      refused = true;
    }
    current = propagateNetwork(current);
    const contradicted = stale && record.outcome === "applied" && current.regions.find((item) => item.id === record.regionId)?.status === "contradiction";
    if (refused || contradicted) {
      current = propagateNetwork(markActivation(before, record.activationId, "superseded", record.sessionId, refused ? "Superseded: the activation's region disappeared from the current solution." : "Superseded: the state revision moved past this activation's basis and its result now contradicts the newer state."));
      application.superseded.push(record.activationId);
      continue;
    }
    if (record.outcome === "applied") application.applied.push(record.activationId);
    else if (record.outcome === "deferred") application.deferred.push(record.activationId);
    else application.failed.push(record.activationId);
  }
  application.network = propagateNetwork(current);
  const telemetry = application.network.telemetry ?? emptyTelemetry();
  for (const record of ordered) {
    const elapsed = Math.max(0, record.finishedAt - record.startedAt);
    const queueMs = Math.max(0, record.startedAt - (networkInput.activations.find((item) => item.id === record.activationId)?.queuedAt ?? record.startedAt));
    const operation = record.operation ?? record.capability;
    const region = telemetry.regions[record.regionId] ?? { operationCalls: {}, promptChars: 0, validationFailures: 0, repairAttempts: 0, retries: 0, domainSizes: [], noProgressFingerprints: [], elapsedMs: 0, queueMs: 0, roleMs: {}, blockedReasons: [] };
    telemetry.activations++;
    telemetry.operationCalls[operation] = (telemetry.operationCalls[operation] ?? 0) + 1;
    if (record.operation === "challenge-domain" && record.outcome === "applied" && record.networkDelta?.kind === "synthesis" && record.networkDelta.output.operation === "challenge-domain" && record.networkDelta.output.verdict === "counterexample") telemetry.counterexampleRepairs++;
    telemetry.retries += record.retries ?? 0;
    telemetry.promptChars += record.promptChars ?? 0;
    telemetry.projectedContextChars += record.promptChars ?? 0;
    telemetry.validationFailures += record.validationFailures?.length ?? 0;
    telemetry.queueMs += queueMs;
    telemetry.roleMs[record.capability] = (telemetry.roleMs[record.capability] ?? 0) + elapsed;
    if (record.capability === "implement") telemetry.implementationMs += elapsed;
    if (record.capability === "verify") telemetry.verificationMs += elapsed;
    for (const key of Object.keys(EMPTY_USAGE) as Array<keyof typeof EMPTY_USAGE>) telemetry.usage[key] += record.usage[key];
    region.operationCalls[operation] = (region.operationCalls[operation] ?? 0) + 1;
    region.promptChars += record.promptChars ?? 0; region.validationFailures += record.validationFailures?.length ?? 0; region.retries += record.retries ?? 0; region.elapsedMs += elapsed; region.queueMs += queueMs;
    region.roleMs[record.capability] = (region.roleMs[record.capability] ?? 0) + elapsed;
    if (record.domainSize !== undefined) region.domainSizes.push(record.domainSize);
    region.repairAttempts += (record.validationFailures?.length ?? 0) || (record.outcome === "deferred" ? 1 : 0);
    const noProgressFingerprint = application.network.regions.find((item) => item.id === record.regionId)?.noProgressFingerprint;
    if (noProgressFingerprint && !region.noProgressFingerprints.includes(noProgressFingerprint)) region.noProgressFingerprints.push(noProgressFingerprint);
    telemetry.regions[record.regionId] = region;
  }
  telemetry.reopens = application.network.regions.reduce((sum, region) => sum + region.reopens, 0);
  telemetry.cycles = application.network.regions.reduce((sum, region) => sum + (region.convergenceCycles?.length ?? 0), 0);
  telemetry.candidates = application.network.candidates.filter((item) => !item.historical).length;
  telemetry.regionCount = application.network.regions.length;
  telemetry.blockedReasons = application.network.regions.flatMap((region) => region.blockedReason ? [region.blockedReason] : []);
  for (const region of application.network.regions) if (telemetry.regions[region.id]) telemetry.regions[region.id]!.blockedReasons = region.blockedReason ? [region.blockedReason] : [];
  application.network.telemetry = telemetry;
  return application;
}

function stateForNetwork(network: SolutionNetwork): SolutionLodState {
  return { stateVersion: 8, runId: "", originalTask: "", conversationContext: "", directory: "", worktree: "", phase: "", activeBatch: [], network, results: [], usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, result: "" };
}

export function ensureRunnableWork(input: SolutionNetwork, width = 1, originalTask = ""): { network: SolutionNetwork; done: boolean; blocked?: string } {
  let network = propagateNetwork(input);
  const unresolvedHigh = network.artifacts.flatMap((item) => item.historical ? [] : item.findings ?? []).find((finding) => finding.severity === "high");
  if (unresolvedHigh) return { network, done: false, blocked: `Change-delivery audit failed for ${unresolvedHigh.criterionId}: unresolved high-severity correctness review finding in ${unresolvedHigh.files.join(", ")}.` };
  if (nextQueuedActivation(network)) return { network, done: false };
  const required = network.regions;
  const terminal = required.length > 0 && required.every((region) => region.status === "verified" || region.status === "collapsed" && network.regions.some((child) => child.parentId === region.id));
  if (terminal) {
    for (const region of required) {
      const children = required.filter((item) => item.parentId === region.id);
      if (!children.length) continue;
      const expected = region.acceptanceCriteria.length || 1;
      const ownership = Array.from({ length: expected }, (_, index) => children.filter((child) => (child.coveredCriteria ?? []).includes(index)).length);
      if (ownership.some((count) => count !== 1)) return { network, done: false, blocked: `Root coverage audit failed for ${region.scopeId}: every criterion must have exactly one live child owner.` };
    }
    for (const region of required.filter((item) => item.candidateIds.length && item.delivery !== "answer" && item.status === "verified")) if (!hasSelectedImplementationFamily(network, region)) return { network, done: false, blocked: `Completed hard-constraint audit failed for ${region.id}: selection lacks one accepted implementation family at the exact domain fingerprint.` };
    for (const region of required.filter((item) => item.delivery === "change" && item.status === "verified")) {
      const artifacts = region.artifactIds.map((id) => network.artifacts.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => item !== undefined && !item.historical);
      const changed = artifacts.some((item) => item.kind === "file");
      const review = artifacts.find((item) => item.kind === "completion-review" && item.passed);
      const high = artifacts.flatMap((item) => item.findings ?? []).some((finding) => finding.severity === "high");
      const criteriaConfirmed = review && region.criterionIds.every((id) => review.criterionIds?.includes(id));
      const evidenceComplete = review?.focusedTests?.length && review.fullChecks?.length && (!taskReferencesTodo(originalTask) || review.todoDisposition);
      if (high) return { network, done: false, blocked: `Change-delivery audit failed for ${region.scopeId}: unresolved high-severity correctness review finding.` };
      if (!review || !criteriaConfirmed || !evidenceComplete || review.implementationOutcome === "changed" !== changed) return { network, done: false, blocked: `Change-delivery audit failed for ${region.scopeId}: completion evidence does not prove measured change delivery or an already-satisfied outcome.` };
    }
    return { network, done: true };
  }
  const explicitlyBlocked = required.find((region) => region.status === "blocked");
  if (explicitlyBlocked) return { network, done: false, blocked: explicitlyBlocked.blockedReason ?? explicitlyBlocked.contradiction ?? `Region ${explicitlyBlocked.id} is blocked.` };
  const implementing = required.find((region) => region.status === "implementing");
  if (implementing) return { network, done: false, blocked: `Implementation activation for ${implementing.id} disappeared.` };
  const actionable = required.find((region) => region.status === "actionable");
  if (actionable) {
    const capability = actionable.delivery === "answer" ? "present" : "implement";
    network = queueActivation(network, capability, actionable.id, capability === "present" ? "Answer the user using the supplied facts and choices." : "Make the required change and meet every success criterion.", `${capability}:${actionable.id}:${network.revision}`, [...actionable.evidenceIds, ...actionable.constraintIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule ${capability} for ${actionable.id}.` };
  }
  const implemented = required.find((region) => region.status === "implemented");
  if (implemented) {
    const existing = network.activations.find((activation) => activation.regionId === implemented.id && activation.capability === "verify" && activation.status === "queued");
    if (existing) {
      existing.basisRevision = network.revision;
      existing.contextRefs = [...new Set([implemented.id, ...implemented.artifactIds])];
      existing.readRefs = activationReadRefs(network, existing.contextRefs);
      return { network, done: false };
    }
    network = queueActivation(network, "verify", implemented.id, "Check the actual output (changed files or the answer) against every success criterion.", `verification:${implemented.id}:${network.revision}`, [...implemented.artifactIds]);
    return { network, done: false };
  }
  const unrefined = required.find((region) => region.status === "unrefined");
  if (unrefined) {
    network = queueActivation(network, "refine", unrefined.id, "Split the chosen approach into the next steps of work that together cover every success criterion.", `refinement:${unrefined.id}:${network.revision}`, [...unrefined.evidenceIds, ...unrefined.constraintIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule refinement for ${unrefined.id}.` };
  }
  const contradiction = required.find((region) => region.status === "contradiction");
  if (contradiction) return { network, done: false, blocked: `Contradiction in ${contradiction.id}: ${contradiction.contradiction ?? "every candidate was eliminated"}` };
  const unresolved = required.filter((region) => region.status === "unformed" || region.status === "superposed").sort((left, right) => {
    const viable = (region: SolutionRegion) => region.candidateIds.filter((id) => network.candidates.find((candidate) => candidate.id === id)?.status !== "eliminated").length;
    return viable(left) - viable(right) || right.lod - left.lod;
  });
  if (unresolved.length) {
    // Queue the whole formation frontier so read-only batches can fan out across sibling regions.
    for (const target of unresolved.slice(0, Math.max(1, width))) {
      if (target.domainPhase === "inspecting" || target.status === "unformed") {
        transitionRegion(target, "inspecting");
        network = queueActivation(network, "inspect", target.id, "Find the repository facts needed to form complete alternatives for this goal. Investigate lower-level details when they affect that choice, but do not turn them into choices yet.", `inspection:${target.id}:${network.revision}`, [...target.evidenceIds]);
      } else if (target.domainPhase === "ungenerated") {
        network = queueSynthesis(network, "generate-domain", target.id, "Generate two to seven mutually exclusive, materially distinct solution families without selecting or eliminating any.", `generate-domain:${target.id}:${network.revision}`, [...target.evidenceIds, ...target.constraintIds]);
      } else if (target.domainPhase === "challenging") {
        network = queueSynthesis(network, "challenge-domain", target.id, "Freshly challenge the bounded local domain: accept it, give one concrete missing family, or request one precise decision-relevant fact.", `challenge-domain:${target.id}:${target.domainFingerprint}:${target.reopens}`, [...target.evidenceIds, ...target.constraintIds, ...target.candidateIds]);
      } else if (target.domainPhase === "selecting") {
        network = queueSynthesis(network, "select-candidate", target.id, "Compare every viable candidate by the deterministic preference tiers and select one, or request one grounding fact for an unresolved tie.", `select-candidate:${target.id}:${target.domainFingerprint}:${target.reopens}`, [...target.evidenceIds, ...target.constraintIds, ...target.candidateIds]);
      }
    }
    const first = unresolved[0];
    if (nextQueuedActivation(network)) return { network, done: false };
    return { network, done: false, blocked: `No activation can make a novel state delta for ${first.id}.` };
  }
  const stalled = required.find((region) => region.status === "stalled");
  if (stalled) return { network, done: false, blocked: `Region ${stalled.id} stalled: ${stalled.reopens} reopens without new evidence` };
  return { network, done: false, blocked: "The solution network has no runnable activation and no completed root." };
}
