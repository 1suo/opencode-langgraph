import { createHash } from "node:crypto";
import type { Activation, Capability, ConditionalRegionDefinition, ImplementationOutput, SolutionCandidate, SolutionDelta, SolutionLodState, SolutionNetwork, SolutionRegion, VerificationOutput } from "./types.js";

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const slug = (value: string) => normalize(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "candidate";
const MAX_ACTIVATION_RETRIES = 3;

export function initialNetwork(task: string): SolutionNetwork {
  return {
    revision: 0, nextRegionId: 2, nextEvidenceId: 1, nextConstraintId: 1, nextActivationId: 2, nextArtifactId: 1,
    regions: [{ id: "r1", key: "root", edge: "root", lod: 0, objective: task, delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: [], status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: ["a1"], artifactIds: [] }],
    candidates: [], constraints: [], evidence: [], artifacts: [],
    activations: [{ id: "a1", capability: "inspect", regionId: "r1", request: "Inspect the request and repository context needed to form the coarse solution domain. Do not expose implementation-level variables.", expectedDelta: "coarse-domain:r1", contextRefs: ["r1"], status: "queued", basisRevision: 0 }],
  };
}

function cloneNetwork(network: SolutionNetwork): SolutionNetwork {
  return {
    ...network,
    regions: network.regions.map((item) => ({ ...item, allowedVariables: [...item.allowedVariables], acceptanceCriteria: [...item.acceptanceCriteria], candidateIds: [...item.candidateIds], selectedCandidateIds: [...item.selectedCandidateIds], constraintIds: [...item.constraintIds], evidenceIds: [...item.evidenceIds], activationIds: [...item.activationIds], artifactIds: [...item.artifactIds] })),
    candidates: network.candidates.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds], eliminationReasons: [...item.eliminationReasons], nextLod: item.nextLod.map((child) => ({ ...child, allowedVariables: [...child.allowedVariables], acceptanceCriteria: [...child.acceptanceCriteria] })) })),
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
  if (input.capability === "implement" && region.status !== "actionable" || input.capability === "verify" && region.status !== "implemented" || input.capability === "present" && (region.status !== "actionable" || region.delivery !== "answer")) return undefined;
  const contextRefs = [...new Set([input.regionId, ...input.contextRefs])];
  const activation: Activation = { ...input, id: `a${network.nextActivationId++}`, contextRefs, status: input.wakeCondition && input.wakeCondition.revisionAfter >= network.revision ? "waiting" : "queued", basisRevision: network.revision };
  network.activations.push(activation);
  network.regions.find((region) => region.id === input.regionId)?.activationIds.push(activation.id);
  return activation;
}

function exposeChildren(network: SolutionNetwork, region: SolutionRegion, candidates: SolutionCandidate[]): boolean {
  let changed = false;
  for (const candidate of candidates) for (const definition of candidate.nextLod) {
    const existing = network.regions.find((item) => item.parentCandidateId === candidate.id && item.key === definition.key);
    if (existing) continue;
    const child: SolutionRegion = {
      id: `r${network.nextRegionId++}`, key: definition.key, parentId: region.id, parentCandidateId: candidate.id, edge: definition.edge,
      lod: region.lod + 1, objective: definition.objective, delivery: definition.delivery ?? region.delivery,
      allowedVariables: [...definition.allowedVariables], acceptanceCriteria: [...definition.acceptanceCriteria], status: "unformed",
      candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [...region.evidenceIds], activationIds: [], artifactIds: [],
    };
    network.regions.push(child); changed = true;
  }
  return changed;
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
          const contradiction = "A solution region selected multiple non-equivalent alternatives; synthesize one complete candidate at this LOD.";
          if (region.status !== "contradiction" || region.contradiction !== contradiction) { region.status = "contradiction"; region.contradiction = contradiction; changed = anyChange = true; }
          continue;
        }
        for (const candidate of viable) if (!selected.some((item) => item.id === candidate.id) && !selected.every((item) => equivalent(item.id, candidate.id))) eliminate(candidate.id, "another solution family collapsed");
        selected = viable.filter((item) => item.status === "selected" || selected.every((choice) => equivalent(choice.id, item.id)));
        const ids = selected.map((item) => item.id);
        if (region.selectedCandidateIds.join("\0") !== ids.join("\0")) { region.selectedCandidateIds = ids; changed = anyChange = true; }
        if (exposeChildren(network, region, selected)) changed = anyChange = true;
        const children = network.regions.filter((item) => item.parentId === region.id && selected.some((candidate) => candidate.id === item.parentCandidateId));
        if (!children.length && !region.acceptanceCriteria.length) { region.acceptanceCriteria = [region.objective]; changed = anyChange = true; }
        const status = children.length ? "collapsed" : "actionable";
        if (region.status !== status && !["implementing", "implemented", "verified"].includes(region.status)) { region.status = status; changed = anyChange = true; }
      } else if (domain.length && region.status !== "superposed") { region.status = "superposed"; changed = anyChange = true; }
    }
  }
  for (const activation of network.activations) if (activation.status === "waiting" && activation.wakeCondition && activation.wakeCondition.revisionAfter < network.revision) activation.status = "queued";
  if (anyChange) network.revision++;
  return network;
}

export function validateSolutionDelta(state: SolutionLodState, regionId: string, delta: SolutionDelta): void {
  if (delta.resolvedAnswer) return;
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  const statuses = new Map<string, string>();
  for (const candidate of state.network.candidates.filter((item) => item.regionId === regionId)) statuses.set(candidate.id, candidate.status);
  for (const item of delta.candidates) statuses.set(candidateId(regionId, item.key), item.outcome);
  // Mirror mergeSolutionDelta: a select only lands on a candidate that exists after the outcomes are applied.
  for (const key of delta.select) { const id = candidateRef(state.network, regionId, key); if (statuses.has(id)) statuses.set(id, "selected"); }
  const domain = [...statuses.values()];
  if (domain.length && domain.every((status) => status === "eliminated"))
    throw new Error(`Delta leaves every candidate in region ${regionId} eliminated with none selected. Provide at least one viable candidate (outcome "possible" or "selected"), or select one via "select". Elimination reasons must be genuine defeaters; supporting evidence is not a reason to eliminate a candidate.`);
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
    changed = true;
  }
  const localEvidence = new Map<string, string>();
  for (const item of delta.evidence) {
    const fingerprint = createHash("sha256").update(`${normalize(item.text)}\0${normalize(item.source)}`).digest("hex").slice(0, 16);
    let evidence = network.evidence.find((existing) => existing.fingerprint === fingerprint);
    if (!evidence) { evidence = { ...item, text: normalize(item.text), source: normalize(item.source), id: `e${network.nextEvidenceId++}`, fingerprint }; network.evidence.push(evidence); changed = true; }
    region.evidenceIds = [...new Set([...region.evidenceIds, evidence.id])]; localEvidence.set(item.source, evidence.id);
  }
  for (const item of resolvedAnswer ? [] : delta.candidates) {
    const id = candidateId(region.id, item.key);
    let candidate = network.candidates.find((existing) => existing.id === id);
    const evidenceIds = item.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    if (!candidate) {
      candidate = { id, regionId: region.id, key: item.key, proposition: normalize(item.proposition), status: item.outcome, evidenceIds, eliminationReasons: [...item.reasons], nextLod: item.nextLod as ConditionalRegionDefinition[] };
      network.candidates.push(candidate); region.candidateIds.push(id); changed = true;
    } else {
      const serialized = JSON.stringify(candidate);
      candidate.proposition = normalize(item.proposition); candidate.status = item.outcome; candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])]; candidate.eliminationReasons = [...new Set([...candidate.eliminationReasons, ...item.reasons])]; candidate.nextLod = item.nextLod as ConditionalRegionDefinition[];
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
      candidate = { id, regionId: region.id, key: "resolved-answer", proposition: region.answer, status: "selected", evidenceIds, eliminationReasons: [], nextLod: [] };
      network.candidates.push(candidate);
      region.candidateIds.push(id);
    } else {
      candidate.proposition = region.answer;
      candidate.status = "selected";
      candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])];
      candidate.nextLod = [];
    }
    for (const other of network.candidates.filter((item) => item.regionId === region.id && item.id !== id && item.status === "selected")) other.status = "possible";
    region.selectedCandidateIds = [id];
    region.status = "verified";
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
  if (!resolvedAnswer && delta.actionable && region.acceptanceCriteria.length && region.candidateIds.length) { region.status = "actionable"; changed = true; }
  if (changed) network.revision++;
  for (const request of delta.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
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
  else { region.status = "superposed"; region.contradiction = output.blocker || output.summary || "Implementation reported a missing prerequisite."; region.selectedCandidateIds = []; for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) candidate.status = "possible"; }
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
  activation.status = "completed"; region.answer = answer; region.status = "verified"; addArtifact(network, region, activationId, { kind: "answer", summary: answer }); network.revision++; return network;
}

export function reopenRegion(networkInput: SolutionNetwork, regionId: string, reason: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (!region) return network;
  region.status = "superposed"; region.contradiction = reason; region.selectedCandidateIds = [];
  for (const candidate of network.candidates.filter((item) => item.regionId === regionId)) candidate.status = "possible";
  const descendants = new Set<string>(); let expanded = true;
  while (expanded) { expanded = false; for (const item of network.regions) if (item.parentId && (item.parentId === regionId || descendants.has(item.parentId)) && !descendants.has(item.id)) { descendants.add(item.id); expanded = true; } }
  network.regions = network.regions.filter((item) => !descendants.has(item.id));
  const survivingRegionIds = new Set(network.regions.map((item) => item.id));
  network.candidates = network.candidates.filter((item) => survivingRegionIds.has(item.regionId));
  network.activations = network.activations.filter((item) => survivingRegionIds.has(item.regionId));
  network.constraints = network.constraints.filter((item) => survivingRegionIds.has(item.subject) || network.candidates.some((candidate) => candidate.id === item.subject) || network.evidence.some((evidence) => evidence.id === item.subject));
  network.revision++; return network;
}

export function nextQueuedActivation(network: SolutionNetwork): Activation | undefined {
  return network.activations.filter((item) => item.status === "queued").sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)))[0];
}

export function ensureRunnableWork(input: SolutionNetwork): { network: SolutionNetwork; done: boolean; blocked?: string } {
  let network = propagateNetwork(input);
  if (nextQueuedActivation(network)) return { network, done: false };
  const required = network.regions;
  if (required.length && required.every((region) => region.status === "verified" || region.status === "collapsed" && network.regions.some((child) => child.parentId === region.id))) return { network, done: true };
  const implementing = required.find((region) => region.status === "implementing");
  if (implementing) return { network, done: false, blocked: `Implementation activation for ${implementing.id} disappeared.` };
  const actionable = required.find((region) => region.status === "actionable");
  if (actionable) {
    const capability = actionable.delivery === "answer" ? "present" : "implement";
    network = queueActivation(network, capability, actionable.id, capability === "present" ? "Produce the answer supported by this collapsed solution path." : "Implement this collapsed actionable region and satisfy its acceptance criteria.", `${capability}:${actionable.id}:${network.revision}`, [...actionable.evidenceIds, ...actionable.constraintIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule ${capability} for ${actionable.id}.` };
  }
  const implemented = required.find((region) => region.status === "implemented");
  if (implemented) {
    network = queueActivation(network, "verify", implemented.id, "Verify this region against its acceptance criteria and actual artifacts.", `verification:${implemented.id}:${network.revision}`, [...implemented.artifactIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule verification for ${implemented.id}.` };
  }
  const contradiction = required.find((region) => region.status === "contradiction");
  if (contradiction) {
    network = queueActivation(network, "synthesize", contradiction.id, `Resolve the contradiction without discarding unrelated solution regions: ${contradiction.contradiction ?? "all candidates were eliminated"}`, `contradiction:${contradiction.id}:${network.revision}`, [...contradiction.constraintIds, ...contradiction.evidenceIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Contradiction in ${contradiction.id} could not be resolved.` };
  }
  const unresolved = required.filter((region) => region.status === "unformed" || region.status === "superposed").sort((left, right) => left.candidateIds.length - right.candidateIds.length || left.lod - right.lod)[0];
  if (unresolved) {
    network = queueActivation(network, "synthesize", unresolved.id, unresolved.candidateIds.length
      ? "Collapse this region from its existing candidates and evidence. Request inspection only for one named fact that genuinely prevents selection."
      : "Form and collapse the candidate domain at exactly this LOD, including only conditional next-LOD definitions.", `synthesis:${unresolved.id}:${network.revision}`, [...unresolved.evidenceIds, ...unresolved.constraintIds]);
    if (nextQueuedActivation(network)) return { network, done: false };
    return { network, done: false, blocked: `No activation can make a novel state delta for ${unresolved.id}.` };
  }
  return { network, done: false, blocked: "The solution network has no runnable activation and no completed root." };
}
