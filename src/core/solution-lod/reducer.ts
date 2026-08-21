import { createHash } from "node:crypto";
import type { Activation, ActivationTaskResult, Capability, ImplementationContract, ImplementationOutput, RefinementOutput, SolutionCandidate, SolutionDelta, SolutionLodState, SolutionNetwork, SolutionRegion, VerificationOutput } from "./types.js";

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const slug = (value: string) => normalize(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "candidate";
const MAX_ACTIVATION_RETRIES = 3;

export function initialNetwork(task: string): SolutionNetwork {
  return {
    revision: 0, nextRegionId: 2, nextEvidenceId: 1, nextConstraintId: 1, nextActivationId: 2, nextArtifactId: 1,
    regions: [{ id: "r1", key: "root", edge: "root", lod: 0, objective: task, delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: [], status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: ["a1"], artifactIds: [] }],
    candidates: [], constraints: [], evidence: [], artifacts: [],
    activations: [{ id: "a1", capability: "inspect", regionId: "r1", request: "Find repository facts needed to distinguish the broad solution types. Investigate lower-level details when they affect that choice, but do not turn them into choices yet.", expectedDelta: "coarse-domain:r1", contextRefs: ["r1"], status: "queued", basisRevision: 0 }],
  };
}

function cloneNetwork(network: SolutionNetwork): SolutionNetwork {
  const cloneContract = (contract: ImplementationContract): ImplementationContract => ({ ...contract, allowedVariables: [...contract.allowedVariables], acceptanceCriteria: [...contract.acceptanceCriteria], coveredCriteria: [...contract.coveredCriteria] });
  return {
    ...network,
    regions: network.regions.map((item) => ({ ...item, allowedVariables: [...item.allowedVariables], acceptanceCriteria: [...item.acceptanceCriteria], candidateIds: [...item.candidateIds], selectedCandidateIds: [...item.selectedCandidateIds], constraintIds: [...item.constraintIds], evidenceIds: [...item.evidenceIds], activationIds: [...item.activationIds], artifactIds: [...item.artifactIds], implementationContract: item.implementationContract ? cloneContract(item.implementationContract) : undefined, coveredCriteria: item.coveredCriteria ? [...item.coveredCriteria] : undefined })),
    candidates: network.candidates.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds], eliminationReasons: [...item.eliminationReasons] })),
    constraints: network.constraints.map((item) => ({ ...item })), evidence: network.evidence.map((item) => ({ ...item })), activations: network.activations.map((item) => ({ ...item, contextRefs: [...item.contextRefs], wakeCondition: item.wakeCondition ? { ...item.wakeCondition } : undefined })), artifacts: network.artifacts.map((item) => ({ ...item })),
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
function knownRef(network: SolutionNetwork, ref: string): boolean {
  return ref === "task" || network.regions.some((item) => item.id === ref) || network.candidates.some((item) => item.id === ref) || network.evidence.some((item) => item.id === ref) || network.constraints.some((item) => item.id === ref) || network.artifacts.some((item) => item.id === ref) || network.activations.some((item) => item.id === ref);
}

function addActivation(network: SolutionNetwork, input: Omit<Activation, "id" | "status" | "basisRevision">): Activation | undefined {
  const signature = `${input.capability}\0${input.regionId}\0${normalize(input.expectedDelta)}`;
  const matches = network.activations.filter((item) => `${item.capability}\0${item.regionId}\0${normalize(item.expectedDelta)}` === signature);
  const duplicate = matches.some((item) => item.status !== "failed");
  const failedAttempts = matches.filter((item) => item.status === "failed").length;
  const region = network.regions.find((item) => item.id === input.regionId);
  if (duplicate || failedAttempts >= MAX_ACTIVATION_RETRIES || !region || input.contextRefs.some((ref) => !knownRef(network, ref))) return undefined;
  if (input.capability === "implement" && region.status !== "actionable" || input.capability === "verify" && region.status !== "implemented" || input.capability === "present" && (region.status !== "actionable" || region.delivery !== "answer") || input.capability === "refine" && region.status !== "unrefined") return undefined;
  const contextRefs = [...new Set([input.regionId, ...input.contextRefs])];
  const activation: Activation = { ...input, id: `a${network.nextActivationId++}`, contextRefs, status: input.wakeCondition && input.wakeCondition.revisionAfter >= network.revision ? "waiting" : "queued", basisRevision: network.revision };
  network.activations.push(activation);
  network.regions.find((region) => region.id === input.regionId)?.activationIds.push(activation.id);
  return activation;
}

function purgeDescendants(network: SolutionNetwork, regionId: string): boolean {
  const descendants = new Set<string>(); let expanded = true;
  while (expanded) { expanded = false; for (const item of network.regions) if (item.parentId && (item.parentId === regionId || descendants.has(item.parentId)) && !descendants.has(item.id)) { descendants.add(item.id); expanded = true; } }
  if (!descendants.size) return false;
  network.regions = network.regions.filter((item) => !descendants.has(item.id));
  const survivingRegionIds = new Set(network.regions.map((item) => item.id));
  network.candidates = network.candidates.filter((item) => survivingRegionIds.has(item.regionId));
  // Live activations of removed regions stay visible but can no longer land: their region is gone.
  network.activations = network.activations
    .filter((item) => survivingRegionIds.has(item.regionId) || item.status === "queued" || item.status === "running" || item.status === "waiting")
    .map((item) => survivingRegionIds.has(item.regionId) ? item : { ...item, status: "superseded" as Activation["status"], error: item.error ?? `Superseded: region ${item.regionId} was removed from the current solution.` });
  network.constraints = network.constraints.filter((item) => survivingRegionIds.has(item.subject) || network.candidates.some((candidate) => candidate.id === item.subject) || network.evidence.some((evidence) => evidence.id === item.subject));
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

export function propagateNetwork(input: SolutionNetwork): SolutionNetwork {
  const network = cloneNetwork(input);
  const equivalence = equivalenceClasses(network);
  let changed = true;
  let anyChange = false;
  while (changed) {
    changed = false;
    const select = (id: string, reason: string) => {
      const candidate = network.candidates.find((item) => item.id === id);
      if (!candidate || candidate.status === "eliminated" || candidate.status === "selected") return;
      candidate.status = "selected"; candidate.eliminationReasons = candidate.eliminationReasons.filter((item) => item !== reason); changed = anyChange = true;
    };
    const eliminate = (id: string, reason: string) => {
      const candidate = network.candidates.find((item) => item.id === id);
      if (!candidate || candidate.status === "eliminated") return;
      candidate.status = "eliminated"; candidate.eliminationReasons = [...new Set([...candidate.eliminationReasons, reason])]; changed = anyChange = true;
    };
    for (const constraint of network.constraints) {
      const subjectCandidate = network.candidates.find((item) => item.id === constraint.subject);
      const subjectSelected = subjectCandidate?.status === "selected" || network.regions.some((item) => item.id === constraint.subject);
      const subjectActive = subjectCandidate ? subjectCandidate.status === "selected" : true;
      if ((constraint.kind === "refutes" || constraint.kind === "excludes") && (constraint.kind === "refutes" ? subjectActive : subjectSelected)) eliminate(constraint.target, constraint.reason || constraint.kind);
      if (constraint.kind === "supports") {
        const candidate = network.candidates.find((item) => item.id === constraint.target);
        if (candidate && network.evidence.some((item) => item.id === constraint.subject) && !candidate.evidenceIds.includes(constraint.subject)) { candidate.evidenceIds.push(constraint.subject); changed = anyChange = true; }
      }
      if (constraint.kind === "requires" && subjectSelected) select(constraint.target, constraint.reason || constraint.kind);
      if (constraint.kind === "equivalent") {
        const left = network.candidates.find((item) => item.id === constraint.subject); const right = network.candidates.find((item) => item.id === constraint.target);
        if (left?.status === "selected" && right && right.status !== "eliminated") select(right.id, constraint.reason || "equivalent");
        if (right?.status === "selected" && left && left.status !== "eliminated") select(left.id, constraint.reason || "equivalent");
      }
    }
    for (const region of network.regions) {
      const domain = region.candidateIds.map((id) => network.candidates.find((item) => item.id === id)).filter((item): item is SolutionCandidate => Boolean(item));
      const viable = domain.filter((item) => item.status !== "eliminated");
      let selected = viable.filter((item) => item.status === "selected");
      if (domain.length && !viable.length) {
        if (region.status !== "contradiction") { region.status = "contradiction"; region.contradiction = "Every candidate was eliminated."; changed = anyChange = true; }
        continue;
      }
      if (!selected.length && viable.length === 1) { select(viable[0].id, "only viable candidate"); selected = [viable[0]]; }
      if (selected.length) {
        const equivalent = (left: string, right: string) => equivalence.get(left) === equivalence.get(right);
        if (selected.some((candidate, index) => selected.slice(index + 1).some((other) => !equivalent(candidate.id, other.id)))) {
          const contradiction = "Multiple incompatible alternatives were chosen. Choose one complete approach.";
          if (region.status !== "contradiction" || region.contradiction !== contradiction) { region.status = "contradiction"; region.contradiction = contradiction; changed = anyChange = true; }
          continue;
        }
        for (const candidate of viable) if (!selected.some((item) => item.id === candidate.id) && !selected.every((item) => equivalent(item.id, candidate.id))) eliminate(candidate.id, "a different non-equivalent approach was chosen");
        selected = viable.filter((item) => item.status === "selected" || selected.every((choice) => equivalent(choice.id, item.id)));
        const ids = selected.map((item) => item.id);
        if (region.selectedCandidateIds.join("\0") !== ids.join("\0")) { region.selectedCandidateIds = ids; changed = anyChange = true; }
        if (!region.acceptanceCriteria.length) { region.acceptanceCriteria = [region.objective]; changed = anyChange = true; }
        // Selection never implies actionability: children come only from a successful refinement,
        // and a leaf becomes actionable only when refinement certified an implementation contract.
        const children = network.regions.filter((item) => item.parentId === region.id);
        const status = children.length ? "collapsed" : region.implementationContract ? "actionable" : "unrefined";
        if (region.status !== status && !["implementing", "implemented", "verified"].includes(region.status)) { region.status = status; changed = anyChange = true; }
      } else {
        if (region.implementationContract && region.status !== "implementing" && region.status !== "implemented" && region.status !== "verified") { region.implementationContract = undefined; changed = anyChange = true; }
        if (domain.length && region.status !== "superposed") { region.status = "superposed"; changed = anyChange = true; }
      }
    }
  }
  for (const activation of network.activations) if (activation.status === "waiting" && activation.wakeCondition && activation.wakeCondition.revisionAfter < network.revision) activation.status = "queued";
  if (anyChange) network.revision++;
  return network;
}

function mergeEvidence(network: SolutionNetwork, region: SolutionRegion, items: SolutionDelta["evidence"]): Map<string, string> {
  const localEvidence = new Map<string, string>();
  for (const item of items) {
    const fingerprint = createHash("sha256").update(`${normalize(item.text)}\0${normalize(item.source)}`).digest("hex").slice(0, 16);
    let evidence = network.evidence.find((existing) => existing.fingerprint === fingerprint);
    if (!evidence) { evidence = { ...item, text: normalize(item.text), source: normalize(item.source), id: `e${network.nextEvidenceId++}`, fingerprint }; network.evidence.push(evidence); } else { evidence = { ...evidence }; }
    region.evidenceIds = [...new Set([...region.evidenceIds, evidence.id])]; localEvidence.set(item.source, evidence.id);
  }
  return localEvidence;
}

export function validateSolutionDelta(state: SolutionLodState, regionId: string, delta: SolutionDelta): void {
  // Mirror mergeSolutionDelta: an answer is honored only when the delta marks the goal as answer-only.
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  if (resolvedAnswer) {
    const known = new Set(state.network.evidence.map((item) => item.id));
    const suppliedSources = new Set(delta.evidence.map((item) => item.source));
    if (!resolvedAnswer.evidenceRefs.some((ref) => known.has(ref) || suppliedSources.has(ref)))
      throw new Error("A resolved answer must cite at least one real fact: an existing evidence id or the source of a fact supplied with this result. An answer without evidence is a guess, not a resolution.");
    return;
  }
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  const statuses = new Map<string, string>();
  for (const candidate of state.network.candidates.filter((item) => item.regionId === regionId)) statuses.set(candidate.id, candidate.status);
  for (const item of delta.candidates) statuses.set(candidateId(regionId, item.key), item.outcome);
  // Mirror mergeSolutionDelta: a select only lands on a candidate that exists after the outcomes are applied.
  for (const key of delta.select) { const id = candidateRef(state.network, regionId, key); if (statuses.has(id)) statuses.set(id, "selected"); }
  const domain = [...statuses.values()];
  if (domain.length && domain.every((status) => status === "eliminated"))
    throw new Error(`Every alternative for ${regionId} was rejected. Leave at least one alternative possible or chosen. Reject an alternative only for a reason that argues against choosing it; supporting evidence is not a rejection reason.`);
}

export function mergeSolutionDelta(state: SolutionLodState, activationId: string, delta: SolutionDelta): SolutionNetwork {
  const network = cloneNetwork(state.network);
  const activation = network.activations.find((item) => item.id === activationId);
  if (!activation) throw new Error(`Unknown activation ${activationId}`);
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Unknown activation region ${activation.regionId}`);
  let changed = false;
  if (delta.region) {
    if (delta.region.objective && delta.region.objective !== region.objective) { region.objective = delta.region.objective; changed = true; }
    if (delta.region.delivery && delta.region.delivery !== region.delivery) { region.delivery = delta.region.delivery; changed = true; }
    if (delta.region.allowedVariables) { region.allowedVariables = [...new Set(delta.region.allowedVariables.map(normalize).filter(Boolean))]; changed = true; }
    if (delta.region.acceptanceCriteria) { region.acceptanceCriteria = [...new Set(delta.region.acceptanceCriteria.map(normalize).filter(Boolean))]; changed = true; }
  }
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  const declaresSelection = !resolvedAnswer && (delta.select.length > 0 || delta.candidates.some((item) => item.outcome === "selected"));
  if (declaresSelection) {
    for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) candidate.status = "possible";
    region.selectedCandidateIds = [];
    region.contradiction = undefined;
    // A new choice invalidates the previous refinement: drop its subtree and contract.
    if (purgeDescendants(network, region.id)) changed = true;
    if (region.implementationContract) { region.implementationContract = undefined; changed = true; }
    changed = true;
  }
  const localEvidence = mergeEvidence(network, region, delta.evidence);
  for (const item of resolvedAnswer ? [] : delta.candidates) {
    const id = candidateId(region.id, item.key);
    let candidate = network.candidates.find((existing) => existing.id === id);
    const evidenceIds = item.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    if (!candidate) {
      candidate = { id, regionId: region.id, key: item.key, proposition: normalize(item.proposition), status: item.outcome, evidenceIds, eliminationReasons: [...item.reasons] };
      network.candidates.push(candidate); region.candidateIds.push(id); changed = true;
    } else {
      const serialized = JSON.stringify(candidate);
      candidate.proposition = normalize(item.proposition); candidate.status = item.outcome; candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])]; candidate.eliminationReasons = [...new Set([...candidate.eliminationReasons, ...item.reasons])];
      if (JSON.stringify(candidate) !== serialized) changed = true;
    }
  }
  if (resolvedAnswer) {
    region.delivery = "answer";
    region.answer = normalize(resolvedAnswer.answer);
    region.acceptanceCriteria = [...new Set(resolvedAnswer.acceptanceCriteria.map(normalize).filter(Boolean))];
    const id = candidateId(region.id, "resolved-answer");
    const evidenceIds = resolvedAnswer.evidenceRefs
      .map((ref) => localEvidence.get(ref) ?? ref)
      .filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    let candidate = network.candidates.find((item) => item.id === id);
    if (!candidate) {
      candidate = { id, regionId: region.id, key: "resolved-answer", proposition: region.answer, status: "selected", evidenceIds, eliminationReasons: [] };
      network.candidates.push(candidate);
      region.candidateIds.push(id);
    } else {
      candidate.proposition = region.answer;
      candidate.status = "selected";
      candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])];
    }
    for (const other of network.candidates.filter((item) => item.regionId === region.id && item.id !== id && item.status === "selected")) other.status = "possible";
    region.selectedCandidateIds = [id];
    addArtifact(network, region, activation.id, { kind: "answer", summary: region.answer });
    region.status = "implemented";
    changed = true;
  }
  for (const key of resolvedAnswer ? [] : delta.select) {
    const candidate = network.candidates.find((item) => item.id === candidateRef(network, region.id, key));
    if (candidate && candidate.status !== "selected") { candidate.status = "selected"; changed = true; }
  }
  for (const item of resolvedAnswer ? [] : delta.constraints) {
    const subject = candidateRef(network, region.id, item.subject); const target = candidateRef(network, region.id, item.target);
    if (!knownRef(network, subject) || !knownRef(network, target)) continue;
    const exists = network.constraints.some((constraint) => constraint.kind === item.kind && constraint.subject === subject && constraint.target === target && normalize(constraint.reason) === normalize(item.reason));
    if (exists) continue;
    const constraint = { ...item, subject, target, reason: normalize(item.reason), id: `c${network.nextConstraintId++}`, sourceActivationId: activation.id };
    network.constraints.push(constraint); region.constraintIds.push(constraint.id); changed = true;
  }
  if (region.delivery === "answer" && delta.answer && delta.answer !== region.answer) { region.answer = normalize(delta.answer); changed = true; }
  // Formation: facts gathered for an unformed region make it ready for synthesis.
  if (activation.capability === "inspect" && region.status === "unformed") { region.status = "superposed"; changed = true; }
  if (changed) network.revision++;
  for (const request of delta.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  return propagateNetwork(network);
}

export function validateRefinementOutput(state: SolutionLodState, regionId: string, output: RefinementOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  const criteriaCount = Math.max(region.acceptanceCriteria.length, 1);
  const inRange = (value: number) => Number.isInteger(value) && value >= 0 && value < criteriaCount;
  if (output.terminal) {
    if (!output.implementationContract)
      throw new Error("A terminal result requires an implementation contract: the bounded observable criteria of the single change to make. If the work must be settled further first, declare terminal false and supply children instead.");
    const invalid = output.implementationContract.coveredCriteria.filter((index) => !inRange(index));
    if (invalid.length)
      throw new Error(`The implementation contract references success-criteria positions that do not exist (received ${invalid.join(", ")} against ${criteriaCount} criterion entries). Address every supplied criterion by its position.`);
    if (new Set(output.implementationContract.coveredCriteria).size < criteriaCount)
      throw new Error("The implementation contract does not cover every success criterion. Reference each supplied criterion position, or explain why the work cannot be bounded yet by declaring terminal false with children.");
    return;
  }
  if (!output.children.length)
    throw new Error("A non-terminal refinement must split the work into children. If ordinary coding judgment can complete it as one bounded change, declare terminal true with an implementation contract instead.");
  const covered = new Set<number>();
  const seenKeys = new Set<string>();
  for (const child of output.children) {
    const key = normalize(child.key);
    if (seenKeys.has(key)) throw new Error(`Two children share the name "${child.key}". Give each child a distinct stable name.`);
    seenKeys.add(key);
    if (!child.coveredCriteria.length || !child.coveredCriteria.every(inRange))
      throw new Error(`Child "${child.key}" does not address any known success criterion. Link it to at least one criterion position of the parent, or remove it.`);
    for (const index of child.coveredCriteria) covered.add(index);
  }
  const missing = Array.from({ length: criteriaCount }, (_, index) => index).filter((index) => !covered.has(index));
  if (missing.length)
    throw new Error(`The children do not collectively cover the parent success criteria: no child addresses criterion ${missing.join(" or ")}. Add or extend a child so every criterion is covered.`);
}

export function mergeRefinementOutput(networkInput: SolutionNetwork, activationId: string, output: RefinementOutput): SolutionNetwork {
  const network = cloneNetwork(networkInput);
  const activation = network.activations.find((item) => item.id === activationId);
  if (!activation) throw new Error(`Unknown activation ${activationId}`);
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region) throw new Error(`Unknown activation region ${activation.regionId}`);
  activation.status = "completed";
  mergeEvidence(network, region, output.evidence);
  if (output.terminal && output.implementationContract) {
    const contract = output.implementationContract;
    const certified: ImplementationContract = {
      delivery: contract.delivery,
      allowedVariables: [...new Set(contract.allowedVariables.map(normalize).filter(Boolean))],
      acceptanceCriteria: [...new Set(contract.acceptanceCriteria.map(normalize).filter(Boolean))],
      coveredCriteria: [...new Set(contract.coveredCriteria)],
    };
    region.implementationContract = certified;
    if (certified.delivery) region.delivery = certified.delivery;
    region.acceptanceCriteria = certified.acceptanceCriteria;
    region.status = "actionable";
    addArtifact(network, region, activation.id, { kind: "check", summary: `Refinement certified one bounded change: ${certified.acceptanceCriteria.join("; ")}`, passed: true });
  } else {
    const parentSelection = region.selectedCandidateIds[0];
    for (const definition of output.children) {
      const existing = network.regions.find((item) => item.parentId === region.id && item.key === definition.key);
      if (existing) continue;
      network.regions.push({
        id: `r${network.nextRegionId++}`, key: definition.key, parentId: region.id, parentCandidateId: parentSelection, edge: definition.edge,
        lod: region.lod + 1, objective: definition.objective, delivery: definition.delivery ?? region.delivery,
        allowedVariables: [...definition.allowedVariables], acceptanceCriteria: [...definition.acceptanceCriteria], coveredCriteria: [...definition.coveredCriteria],
        status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [...region.evidenceIds], activationIds: [], artifactIds: [],
      });
    }
    region.status = "collapsed";
  }
  network.revision++;
  return propagateNetwork(network);
}

export function queueActivation(networkInput: SolutionNetwork, capability: Capability, regionId: string, request: string, expectedDelta: string, contextRefs: string[] = []): SolutionNetwork {
  const network = cloneNetwork(networkInput); addActivation(network, { capability, regionId, request, expectedDelta, contextRefs }); return network;
}

export function markActivation(networkInput: SolutionNetwork, activationId: string, status: Activation["status"], sessionId?: string, error?: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); if (!activation) return network;
  activation.status = status; activation.sessionId = sessionId ?? activation.sessionId; activation.error = error; return network;
}

export function setRegionStatus(networkInput: SolutionNetwork, regionId: string, status: SolutionRegion["status"]): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (region) region.status = status; return network;
}

function addArtifact(network: SolutionNetwork, region: SolutionRegion, activationId: string, artifact: Omit<SolutionNetwork["artifacts"][number], "id" | "regionId" | "activationId">): void {
  const item = { ...artifact, id: `x${network.nextArtifactId++}`, regionId: region.id, activationId };
  network.artifacts.push(item); region.artifactIds.push(item.id);
}

export function completeImplementation(networkInput: SolutionNetwork, activationId: string, output: ImplementationOutput, actualChangedFiles: string[]): SolutionNetwork {
  let network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed";
  for (const file of [...new Set([...actualChangedFiles, ...output.changedFiles])]) addArtifact(network, region, activationId, { kind: "file", path: file, summary: `Changed ${file}` });
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  if (output.status === "completed") region.status = "implemented";
  else { region.status = "superposed"; region.contradiction = output.blocker || output.summary || "Implementation reported a missing prerequisite."; region.selectedCandidateIds = []; region.implementationContract = undefined; for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) candidate.status = "possible"; }
  network.revision++; return network;
}

export function completeVerification(networkInput: SolutionNetwork, activationId: string, output: VerificationOutput): SolutionNetwork {
  let network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed";
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  if (output.verdict === "pass") region.status = "verified";
  else if (output.verdict === "repair") region.status = "actionable";
  else {
    const target = output.findings[0]?.regionId ?? region.id;
    network = reopenRegion(network, target, output.summary || output.findings.map((item) => item.problem).join("; "));
  }
  network.revision++; return network;
}

export function completePresentation(networkInput: SolutionNetwork, activationId: string, answer: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed"; region.answer = answer; region.status = "implemented"; addArtifact(network, region, activationId, { kind: "answer", summary: answer }); network.revision++; return network;
}

export function reopenRegion(networkInput: SolutionNetwork, regionId: string, reason: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (!region) return network;
  region.status = "superposed"; region.contradiction = reason; region.selectedCandidateIds = [];
  region.implementationContract = undefined; region.coveredCriteria = undefined;
  for (const candidate of network.candidates.filter((item) => item.regionId === regionId)) candidate.status = "possible";
  purgeDescendants(network, regionId);
  network.revision++; return network;
}

export function nextQueuedActivation(network: SolutionNetwork): Activation | undefined {
  return network.activations.filter((item) => item.status === "queued").sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)))[0];
}

const MUTATING_CAPABILITIES: Capability[] = ["implement", "verify"];

/**
 * Select the next activation batch. Mutating capabilities (implement/verify) always run
 * as a singleton; read-only capabilities (inspect/synthesize/present) are batched on
 * pairwise distinct regions up to `width`. A width of 1 reproduces sequential execution.
 */
export function selectActivationBatch(network: SolutionNetwork, width: number): Activation[] {
  const queued = network.activations.filter((item) => item.status === "queued").sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)));
  if (!queued.length) return [];
  if (MUTATING_CAPABILITIES.includes(queued[0].capability)) return [queued[0]];
  const batch: Activation[] = [];
  const claimedRegions = new Set<string>();
  for (const activation of queued) {
    if (batch.length >= width) break;
    if (MUTATING_CAPABILITIES.includes(activation.capability)) continue;
    if (claimedRegions.has(activation.regionId)) continue;
    batch.push(activation);
    claimedRegions.add(activation.regionId);
  }
  return batch;
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
 * them sequentially, and one deferred propagateNetwork pass runs after the whole batch.
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
    if (!current.activations.some((item) => item.id === record.activationId)) { application.superseded.push(record.activationId); continue; }
    const stale = current.revision !== record.basisRevision;
    let refused = false;
    try {
      if (record.outcome === "applied" && record.networkDelta) {
        const delta = record.networkDelta;
        if (delta.kind === "delta") current = markActivation(mergeSolutionDelta(stateForNetwork(current), record.activationId, delta.delta), record.activationId, "completed", record.sessionId);
        else if (delta.kind === "refinement") current = markActivation(mergeRefinementOutput(current, record.activationId, delta.output), record.activationId, "completed", record.sessionId);
        else if (delta.kind === "implementation") current = completeImplementation(current, record.activationId, delta.output, delta.changedFiles);
        else if (delta.kind === "verification") current = completeVerification(current, record.activationId, delta.output);
        else current = completePresentation(current, record.activationId, delta.answer);
      } else {
        const message = record.error ?? "Activation task failed.";
        current = markActivation(current, record.activationId, "failed", record.sessionId, message);
        if (record.capability === "implement") {
          const changedFiles = record.changedFiles ?? [];
          if (changedFiles.length) {
            const summary = record.outcome === "deferred" ? message : `Implementation output failed but workspace mutation was retained: ${message}`;
            current = completeImplementation(current, record.activationId, { status: "blocked", summary, changedFiles, checks: [], blocker: message, activations: [] }, changedFiles);
            current = markActivation(current, record.activationId, "failed", record.sessionId, message);
          } else current = setRegionStatus(current, record.regionId, "actionable");
        }
      }
    } catch {
      refused = true;
    }
    const contradicted = stale && record.outcome === "applied" && current.regions.find((item) => item.id === record.regionId)?.status === "contradiction";
    if (refused || contradicted) {
      current = markActivation(before, record.activationId, "superseded", record.sessionId, refused ? "Superseded: the activation's region disappeared from the current solution." : "Superseded: the state revision moved past this activation's basis and its result now contradicts the newer state.");
      application.superseded.push(record.activationId);
      continue;
    }
    if (record.outcome === "applied") application.applied.push(record.activationId);
    else if (record.outcome === "deferred") application.deferred.push(record.activationId);
    else application.failed.push(record.activationId);
  }
  application.network = propagateNetwork(current);
  return application;
}

function stateForNetwork(network: SolutionNetwork): SolutionLodState {
  return { stateVersion: 4, runId: "", originalTask: "", conversationContext: "", directory: "", worktree: "", phase: "", activeBatch: [], network, results: [], usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, worktreeAcquired: false, result: "" };
}

export function ensureRunnableWork(input: SolutionNetwork, width = 1): { network: SolutionNetwork; done: boolean; blocked?: string } {
  let network = propagateNetwork(input);
  if (nextQueuedActivation(network)) return { network, done: false };
  const required = network.regions;
  if (required.length && required.every((region) => region.status === "verified" || region.status === "collapsed" && network.regions.some((child) => child.parentId === region.id))) return { network, done: true };
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
    network = queueActivation(network, "verify", implemented.id, "Check the actual output (changed files or the answer) against every success criterion.", `verification:${implemented.id}:${network.revision}`, [...implemented.artifactIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule verification for ${implemented.id}.` };
  }
  const unrefined = required.find((region) => region.status === "unrefined");
  if (unrefined) {
    network = queueActivation(network, "refine", unrefined.id, "Decide whether the chosen approach can be carried out now as one bounded change, or split it into children that together cover every success criterion.", `refinement:${unrefined.id}:${network.revision}`, [...unrefined.evidenceIds, ...unrefined.constraintIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule refinement for ${unrefined.id}.` };
  }
  const contradiction = required.find((region) => region.status === "contradiction");
  if (contradiction) {
    network = queueActivation(network, "synthesize", contradiction.id, `Choose a consistent approach without changing unrelated choices: ${contradiction.contradiction ?? "every alternative was rejected"}`, `contradiction:${contradiction.id}:${network.revision}`, [...contradiction.constraintIds, ...contradiction.evidenceIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Contradiction in ${contradiction.id} could not be resolved.` };
  }
  const unresolved = required.filter((region) => region.status === "unformed" || region.status === "superposed").sort((left, right) => left.candidateIds.length - right.candidateIds.length || left.lod - right.lod);
  if (unresolved.length) {
    // Queue the whole formation frontier so read-only batches can fan out across sibling regions.
    for (const target of unresolved.slice(0, Math.max(1, width))) {
      if (target.status === "unformed") {
        network = queueActivation(network, "inspect", target.id, "Find the repository facts needed to form complete alternatives for this goal. Investigate lower-level details when they affect that choice, but do not turn them into choices yet.", `inspection:${target.id}:${network.revision}`, [...target.evidenceIds]);
      } else {
        network = queueActivation(network, "synthesize", target.id, target.candidateIds.length
          ? "Choose among the existing alternatives using the supplied facts. Request one named missing fact only if no sound choice is possible without it."
          : "Propose complete alternatives for this choice and choose one.", `synthesis:${target.id}:${network.revision}`, [...target.evidenceIds, ...target.constraintIds]);
      }
    }
    const first = unresolved[0];
    if (nextQueuedActivation(network)) return { network, done: false };
    return { network, done: false, blocked: `No activation can make a novel state delta for ${first.id}.` };
  }
  return { network, done: false, blocked: "The solution network has no runnable activation and no completed root." };
}
