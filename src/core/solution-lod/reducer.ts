import { createHash } from "node:crypto";
import type { Activation, ActivationTaskResult, Capability, CandidateStance, DecisionVariable, ImplementationOutput, RefinementOutput, SolutionCandidate, SolutionDelta, SolutionLodState, SolutionNetwork, SolutionRegion, StanceRelation, VerificationOutput } from "./types.js";

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const slug = (value: string) => normalize(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "candidate";
const MAX_ACTIVATION_RETRIES = 3;
/** A region at or beyond this depth is treated as implementable regardless of its criterion count — a loop-breaker, never a scheduling target. */
export const REFINEMENT_DEPTH_LIMIT = 6;

export function initialNetwork(task: string): SolutionNetwork {
  return {
    revision: 0, nextRegionId: 2, nextEvidenceId: 1, nextConstraintId: 1, nextActivationId: 2, nextArtifactId: 1, nextVariableId: 1,
    regions: [{ id: "r1", key: "root", edge: "root", lod: 0, objective: task, delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: [], status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: ["a1"], artifactIds: [] }],
    candidates: [], constraints: [], evidence: [], artifacts: [],
    activations: [{ id: "a1", capability: "inspect", regionId: "r1", request: "Find repository facts needed to distinguish the broad solution types. Investigate lower-level details when they affect that choice, but do not turn them into choices yet.", expectedDelta: "coarse-domain:r1", contextRefs: ["r1"], status: "queued", basisRevision: 0 }],
    variables: [],
  };
}

function cloneNetwork(network: SolutionNetwork): SolutionNetwork {
  return {
    ...network,
    regions: network.regions.map((item) => ({ ...item, allowedVariables: [...item.allowedVariables], acceptanceCriteria: [...item.acceptanceCriteria], candidateIds: [...item.candidateIds], selectedCandidateIds: [...item.selectedCandidateIds], constraintIds: [...item.constraintIds], evidenceIds: [...item.evidenceIds], activationIds: [...item.activationIds], artifactIds: [...item.artifactIds], coveredCriteria: item.coveredCriteria ? [...item.coveredCriteria] : undefined })),
    candidates: network.candidates.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds], declaredEvidenceIds: item.declaredEvidenceIds ? [...item.declaredEvidenceIds] : undefined, eliminationReasons: [...item.eliminationReasons], declaredEliminationReasons: item.declaredEliminationReasons ? [...item.declaredEliminationReasons] : undefined, stances: (item.stances ?? []).map((stance) => ({ ...stance })) })),
    constraints: network.constraints.map((item) => ({ ...item })), evidence: network.evidence.map((item) => ({ ...item })), activations: network.activations.map((item) => ({ ...item, contextRefs: [...item.contextRefs] })), artifacts: network.artifacts.map((item) => ({ ...item })),
    variables: network.variables.map((item) => ({ ...item, seedLabels: [...(item.seedLabels ?? [])] })),
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
  return ref === "task" || network.regions.some((item) => item.id === ref) || network.candidates.some((item) => item.id === ref) || network.evidence.some((item) => item.id === ref) || network.constraints.some((item) => item.id === ref) || network.artifacts.some((item) => item.id === ref) || network.activations.some((item) => item.id === ref) || knownCoordinate(network, ref);
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
  return network.variables.find((item) => item.id === ref || (name.length > 0 && item.name === name));
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

function addActivation(network: SolutionNetwork, input: Omit<Activation, "id" | "status" | "basisRevision">): Activation | undefined {
  const signature = `${input.capability}\0${input.regionId}\0${normalize(input.expectedDelta)}`;
  const matches = network.activations.filter((item) => `${item.capability}\0${item.regionId}\0${normalize(item.expectedDelta)}` === signature);
  const duplicate = matches.some((item) => item.status !== "failed");
  const failedAttempts = matches.filter((item) => item.status === "failed").length;
  const region = network.regions.find((item) => item.id === input.regionId);
  if (duplicate || failedAttempts >= MAX_ACTIVATION_RETRIES || !region || input.contextRefs.some((ref) => !knownRef(network, ref))) return undefined;
  if (input.capability === "implement" && region.status !== "actionable" || input.capability === "verify" && region.status !== "implemented" || input.capability === "present" && (region.status !== "actionable" || region.delivery !== "answer") || input.capability === "refine" && region.status !== "unrefined" || input.capability === "synthesize" && !["unformed", "superposed", "contradiction"].includes(region.status)) return undefined;
  const contextRefs = [...new Set([input.regionId, ...input.contextRefs])];
  const activation: Activation = { ...input, id: `a${network.nextActivationId++}`, contextRefs, status: "queued", basisRevision: network.revision };
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
  // Shared choices owned by removed regions die with them; nothing outside their subtree could see them anyway.
  network.variables = network.variables.filter((item) => survivingRegionIds.has(item.ownerRegionId));
  // Live activations of removed regions stay visible but can no longer land: their region is gone.
  network.activations = network.activations
    .filter((item) => survivingRegionIds.has(item.regionId) || item.status === "queued" || item.status === "running")
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

export function propagateNetwork(input: SolutionNetwork): SolutionNetwork {
  const network = cloneNetwork(input);
  const derivedSnapshot = (value: SolutionNetwork) => JSON.stringify({
    candidates: value.candidates.map(({ id, status, evidenceIds, eliminationReasons }) => ({ id, status, evidenceIds, eliminationReasons })),
    regions: value.regions.map(({ id, status, selectedCandidateIds, contradiction }) => ({ id, status, selectedCandidateIds, contradiction })),
    waiting: value.activations.filter((item) => item.status === "queued").map(({ id, status }) => ({ id, status })),
  });
  const beforeDerived = derivedSnapshot(network);
  // Derived statuses never become new solver input. Rebuild the domain from the
  // authored dispositions before applying the complete constraint set.
  for (const candidate of network.candidates) {
    candidate.status = candidate.declaredStatus ?? candidate.status;
    candidate.evidenceIds = [...(candidate.declaredEvidenceIds ?? candidate.evidenceIds)];
    candidate.eliminationReasons = [...(candidate.declaredEliminationReasons ?? (candidate.status === "eliminated" ? candidate.eliminationReasons : []))];
  }
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
            if (constraint.kind === "refutes" && snapActive(constraint.subject) && snapKnown(constraint.target)) queueEliminate(constraint.target, constraint.reason || constraint.kind);
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
      if (killed?.declaredStatus === "selected") killed.declaredStatus = undefined;
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
      if (!constraint.evidenceRefs.every((ref) => network.evidence.some((item) => item.id === ref))) continue;
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
        selectedStances.set(holder.id, (holder.stances ?? []).map((stance) => ({ variableId: stance.variableId, valueLabel: stance.valueLabel })));
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
          region.status = "contradiction";
          region.contradiction = "Commitments conflict on shared choice: committed moves demand different options.";
          changed = anyChange = true;
        }
      }
      // Iterate the decreasing operator K ← conflicts(bindings(selected ∖ baseDead ∖ K)):
      // a kill must never outlive the binder that caused it. Contested variables are excluded
      // from binding entirely — their conflict is surfaced above instead of resolved silently.
      let excluded: Set<string> = new Set();
      let killed = new Map<string, string>();
      for (let iteration = 0; iteration < 16; iteration += 1) {
        killed = new Map<string, string>();
        const boundLabels = new Map<string, string>();
        const boundBy = new Map<string, string>();
        for (const holder of holders) {
          if (holder.status !== "selected" || baseDead.has(holder.id) || excluded.has(holder.id)) continue;
          for (const stance of holder.stances ?? []) {
            if (stance.relation !== "requires" || contestedVariables.has(stance.variableId)) continue;
            const key = `${stance.variableId}\u0000${slug(stance.valueLabel)}`;
            if (!boundLabels.has(key)) { boundLabels.set(key, stance.valueLabel); boundBy.set(key, holder.id); }
          }
        }
        const boundsPerVariable = new Map<string, Array<[string, string, string]>>();
        for (const [key, label] of boundLabels) {
          const variableId = key.split("\u0000")[0]!;
          if (!boundsPerVariable.has(variableId)) boundsPerVariable.set(variableId, []);
          boundsPerVariable.get(variableId)!.push([key, label, boundBy.get(key)!]);
        }
        for (const holder of holders) {
          if (holder.status === "eliminated" || baseDead.has(holder.id)) continue;
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
            if (reason) killed.set(holder.id, reason);
          }
        }
        const nextExcluded = new Set(killed.keys());
        const same = nextExcluded.size === excluded.size && [...nextExcluded].every((id) => excluded.has(id));
        if (same) break;
        excluded = nextExcluded;
      }
      for (const [id, reason] of killed) eliminate(id, reason);
    }
    // Commitment rules (excludes / requires-selection / equivalents / supports) evaluate only
    // after stance-facts have settled above.
const postOverlayStatuses = new Map(network.candidates.map((item) => [item.id, item.status]));
    for (const constraint of network.constraints) {
      if (constraint.kind !== "requires" || postOverlayStatuses.get(constraint.subject) !== "selected" || postOverlayStatuses.get(constraint.target) !== "eliminated") continue;
      const subjectCandidate = network.candidates.find((item) => item.id === constraint.subject);
    }
const commitmentStage = runConstraintSweeps(postOverlayStatuses, "commitments");
    for (const [id, reasons] of commitmentStage.pendingElims) for (const reason of reasons) eliminate(id, reason);
    for (const [id, reason] of commitmentStage.pendingSelects) select(id, reason);
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
        // Selection never implies actionability, and actionability is arithmetic, not opinion:
        // a region is implementable only when it carries exactly one explicit success criterion
        // (or sits at the depth floor); otherwise refinement must split it into next steps.
        const children = network.regions.filter((item) => item.parentId === region.id);
        const atomic = region.acceptanceCriteria.length === 1 || region.lod >= REFINEMENT_DEPTH_LIMIT;
        const status = children.length ? "collapsed" : atomic ? "actionable" : "unrefined";
        const conflictLocked = region.status === "contradiction" && Boolean(region.contradiction?.startsWith("Commitments conflict"));
        if (!conflictLocked && region.status !== status && !["implementing", "implemented", "verified", "blocked", "stalled"].includes(region.status)) { region.status = status; changed = anyChange = true; }
      } else {
        if (domain.length && region.status !== "superposed" && region.status !== "stalled") { region.status = "superposed"; changed = anyChange = true; }
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
      if (!subjectCandidate || subjectCandidate.declaredStatus !== "selected") continue;
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
  network.revision = input.revision + (derivedSnapshot(network) === beforeDerived ? 0 : 1);
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

export function validateSolutionDelta(state: SolutionLodState, regionId: string, capabilityOrDelta: Capability | SolutionDelta, maybeDelta?: SolutionDelta): void {
  const capability: Capability = typeof capabilityOrDelta === "string" ? capabilityOrDelta : capabilityOrDelta.resolvedAnswer ? "inspect" : "synthesize";
  const delta = normalizeDelta(typeof capabilityOrDelta === "string" ? maybeDelta! : capabilityOrDelta);
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  if (capability === "inspect") {
    if (delta.candidates.length || delta.constraints.length || delta.select.length || delta.variables?.length)
      throw new Error("Inspection may report sourced facts or a complete answer, but may not propose, reject, constrain, select solution alternatives, or declare shared choices.");
    if (delta.region?.objective) {
      const sameGoal = slug(delta.region.objective) === slug(region.objective);
      if (!sameGoal)
        throw new Error("Inspection may not rewrite the assigned objective. Omit the optional 'objective' field entirely — never restate, summarize, or paraphrase the goal in your result.");
    }
  } else if (capability === "synthesize" && delta.region && Object.keys(delta.region).length) {
    const sameCriteria = JSON.stringify([...(delta.region.acceptanceCriteria ?? region.acceptanceCriteria).map((item) => normalize(item))].sort()) === JSON.stringify([...region.acceptanceCriteria.map((item) => normalize(item))].sort());
    const sameVariables = JSON.stringify([...(delta.region.allowedVariables ?? region.allowedVariables)].sort()) === JSON.stringify([...region.allowedVariables].sort());
    const rewrote = (delta.region.objective !== undefined && slug(delta.region.objective) !== slug(region.objective))
      || (delta.region.delivery !== undefined && delta.region.delivery !== region.delivery)
      || !sameCriteria || !sameVariables;
    if (rewrote) throw new Error("Synthesis may compare alternatives, but may not rewrite the objective, delivery type, allowed variables, or success criteria.");
  }
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
  if (delta.candidates.length > 12) throw new Error("A region may contain at most 12 materially distinct current-level alternatives. Refine the decision boundary instead of silently pruning candidates.");
  // Mirror mergeSolutionDelta: an answer is honored only when the delta marks the goal as answer-only.
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  if (resolvedAnswer) {
    const known = new Set(state.network.evidence.map((item) => item.id));
    const suppliedSources = new Set(delta.evidence.map((item) => item.source));
    if (!resolvedAnswer.evidenceRefs.some((ref) => known.has(ref) || suppliedSources.has(ref)))
      throw new Error("A resolved answer must cite at least one real fact: an existing evidence id or the source of a fact supplied with this result. An answer without evidence is a guess, not a resolution.");
    return;
  }
  const statuses = new Map<string, string>();
  for (const candidate of state.network.candidates.filter((item) => item.regionId === regionId)) statuses.set(candidate.id, candidate.status);
  for (const item of delta.candidates) statuses.set(candidateId(regionId, item.key), item.outcome);
  const candidateRefs = new Set(statuses.keys());
  const evidenceRefs = new Set([...state.network.evidence.map((item) => item.id), ...delta.evidence.map((item) => item.source)]);
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
    if (target === "coordinate") {
      if (!(constraint.evidenceRefs ?? []).length)
        throw new Error(`Refuting shared choice "${constraint.target}" requires at least one cited fact in evidenceRefs — an uncited kill of a shared option is a guess, not a constraint.`);
      for (const ref of constraint.evidenceRefs ?? [])
        if (!evidenceRefs.has(ref)) throw new Error(`Constraint cites unknown fact "${ref}" — cite an established fact id or supply the fact with this result.`);
    }
  }
  // Mirror mergeSolutionDelta: a select only lands on a candidate that exists after the outcomes are applied.
  for (const key of delta.select) { const id = candidateRef(state.network, regionId, key); if (statuses.has(id)) statuses.set(id, "selected"); }
  const domain = [...statuses.values()];
  if (domain.length && domain.every((status) => status === "eliminated"))
    throw new Error(`Every alternative for ${regionId} was rejected. Leave at least one alternative possible or chosen. Reject an alternative only for a reason that argues against choosing it; supporting evidence is not a rejection reason.`);
}

/** Direct reducer callers may omit defaulted delta arrays; Zod-normalized graph paths never do. */
function normalizeDelta(delta: SolutionDelta): SolutionDelta {
  return { ...delta, candidates: delta.candidates ?? [], constraints: delta.constraints ?? [], evidence: delta.evidence ?? [], select: delta.select ?? [], activations: delta.activations ?? [], variables: delta.variables ?? [] };
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
    if (delta.region.delivery && delta.region.delivery !== region.delivery) { region.delivery = delta.region.delivery; changed = true; }
    if (delta.region.allowedVariables) { region.allowedVariables = [...new Set(delta.region.allowedVariables.map(normalize).filter(Boolean))]; changed = true; }
    if (delta.region.acceptanceCriteria) { region.acceptanceCriteria = [...new Set(delta.region.acceptanceCriteria.map(normalize).filter(Boolean))]; changed = true; }
  }
  const resolvedAnswer = delta.region?.delivery === "answer" ? delta.resolvedAnswer : undefined;
  const declaresSelection = !resolvedAnswer && (delta.select.length > 0 || delta.candidates.some((item) => item.outcome === "selected"));
  if (declaresSelection) {
    for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) { candidate.status = "possible"; candidate.declaredStatus = "possible"; }
    region.selectedCandidateIds = [];
    region.contradiction = undefined;
    // A new choice invalidates the previous refinement: drop its subtree and contract.
    if (purgeDescendants(network, region.id)) changed = true;
    changed = true;
  }
  const localEvidence = mergeEvidence(network, region, delta.evidence);
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
  for (const item of resolvedAnswer ? [] : delta.candidates) {
    const id = candidateId(region.id, item.key);
    let candidate = network.candidates.find((existing) => existing.id === id);
    const evidenceIds = item.evidenceRefs.map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((evidence) => evidence.id === ref));
    const stances = resolveStances(network, region.id, item.stances ?? []);
    if (!candidate) {
      candidate = { id, regionId: region.id, key: item.key, proposition: normalize(item.proposition), status: item.outcome, declaredStatus: item.outcome, evidenceIds, declaredEvidenceIds: evidenceIds, eliminationReasons: [...item.reasons], declaredEliminationReasons: [...item.reasons], stances };
      network.candidates.push(candidate); region.candidateIds.push(id); changed = true;
    } else {
      const serialized = JSON.stringify(candidate);
      candidate.proposition = normalize(item.proposition); candidate.status = item.outcome; candidate.declaredStatus = item.outcome; candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...evidenceIds])]; candidate.declaredEvidenceIds = [...candidate.evidenceIds]; candidate.eliminationReasons = [...new Set([...candidate.eliminationReasons, ...item.reasons])]; candidate.declaredEliminationReasons = [...candidate.eliminationReasons]; candidate.stances = stances;
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
      candidate = { id, regionId: region.id, key: "resolved-answer", proposition: region.answer, status: "selected", declaredStatus: "selected", evidenceIds, declaredEvidenceIds: evidenceIds, eliminationReasons: [], declaredEliminationReasons: [], stances: [] };
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
    region.status = "implemented";
    changed = true;
  }
  for (const key of resolvedAnswer ? [] : delta.select) {
    const candidate = network.candidates.find((item) => item.id === candidateRef(network, region.id, key));
    if (candidate && candidate.status !== "selected") { candidate.status = "selected"; candidate.declaredStatus = "selected"; changed = true; }
  }
  for (const item of resolvedAnswer ? [] : delta.constraints) {
    const coordinate = coordinateOf(network, item.target);
    const subject = localEvidence.get(item.subject) ?? candidateRef(network, region.id, item.subject); const target = localEvidence.get(item.target) ?? (coordinate ? `${coordinate.variableId}:${coordinate.valueLabel}` : candidateRef(network, region.id, item.target));
    if (!knownRef(network, subject) || !knownRef(network, target)) continue;
    const exists = network.constraints.some((constraint) => constraint.kind === item.kind && constraint.subject === subject && constraint.target === target && normalize(constraint.reason) === normalize(item.reason));
    if (exists) continue;
    const evidenceRefs = [...new Set((item.evidenceRefs ?? []).map((ref) => localEvidence.get(ref) ?? ref).filter((ref) => network.evidence.some((evidence) => evidence.id === ref)))];
    const constraint = { ...item, subject, target, reason: normalize(item.reason), id: `c${network.nextConstraintId++}`, sourceActivationId: activation.id, evidenceRefs };
    network.constraints.push(constraint); region.constraintIds.push(constraint.id); changed = true;
  }
  if (region.delivery === "answer" && delta.answer && delta.answer !== region.answer) { region.answer = normalize(delta.answer); changed = true; }
  // Formation: facts gathered for an unformed region make it ready for synthesis.
  if (activation.capability === "inspect" && region.status === "unformed") { region.status = "superposed"; changed = true; }
  assertAcyclicPrimalGraph(network);
  if (changed) network.revision++;
  for (const request of delta.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  return propagateNetwork(network);
}

export function validateRefinementOutput(state: SolutionLodState, regionId: string, output: RefinementOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) return;
  // Degenerate case: an unauthored criteria list leaves one anonymous implicit criterion.
  // Any child then trivially addresses position 0 — normalize silently instead of demanding
  // impossible mappings, but keep genuine coverage errors loud for authored lists.
  const authoredCount = region.acceptanceCriteria.length;
  const criteriaCount = Math.max(authoredCount, 1);
  const inRange = (value: number) => Number.isInteger(value) && value >= 0 && value < criteriaCount;
  if (!output.children.length)
    throw new Error(`Refinement must split the work into its next steps as children covering the ${authoredCount} success criterion position(s) of this goal (${region.acceptanceCriteria.map((criterion, index) => `${index}: ${criterion}`).join("; ") || "one implicit criterion"}). Whether the remainder is small enough to implement is decided by the scheduler from the criteria count, not declared here.`);
  const covered = new Set<number>();
  const seenKeys = new Set<string>();
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
  }
  const missing = Array.from({ length: criteriaCount }, (_, index) => index).filter((index) => !covered.has(index));
  if (missing.length)
    throw new Error(`The children do not collectively cover the parent success criteria: no child addresses criterion position(s) ${missing.join(", ")}. Add or extend a child so every criterion is covered.`);
}

export function validateImplementationOutput(state: SolutionLodState, regionId: string, output: ImplementationOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) throw new Error(`Unknown implementation region ${regionId}`);
  if (output.status === "blocked") {
    if (!normalize(output.blocker ?? output.summary)) throw new Error("A blocked implementation must name the concrete missing fact or conflict.");
    return;
  }
  if (!output.checks.length) throw new Error("Implementation completion requires at least one focused check with observable evidence.");
  const failed = output.checks.filter((check) => !check.passed);
  if (failed.length) throw new Error(`Implementation cannot complete while checks fail: ${failed.map((item) => item.name).join(", ")}.`);
  if (output.checks.some((check) => !normalize(check.evidence))) throw new Error("Every implementation check must include observable evidence.");
}

export function validateVerificationOutput(state: SolutionLodState, regionId: string, output: VerificationOutput): void {
  const region = state.network.regions.find((item) => item.id === regionId);
  if (!region) throw new Error(`Unknown verification region ${regionId}`);
  const live = new Map(state.network.regions.map((item) => [item.id, item]));
  for (const finding of output.findings) {
    const target = live.get(finding.regionId);
    if (!target) throw new Error(`Verification finding references missing region ${finding.regionId}.`);
    if (!target.acceptanceCriteria.includes(finding.criterion)) throw new Error(`Verification finding does not name an exact acceptance criterion of ${finding.regionId}: ${finding.criterion}`);
    if (!normalize(finding.problem) || !normalize(finding.evidence)) throw new Error("Every verification finding requires a concrete problem and observed evidence.");
  }
  if (output.verdict === "pass") {
    if (output.findings.length) throw new Error("A passing verification cannot contain defect findings.");
    if (!output.checks.length || output.checks.some((check) => !check.passed || !normalize(check.evidence)))
      throw new Error("Verification may pass only with passing checks containing observable evidence.");
    for (const criterion of region.acceptanceCriteria) {
      if (!output.checks.some((check) => normalize(`${check.name} ${check.evidence}`).includes(normalize(criterion))))
        throw new Error(`Verification pass has no criterion-specific evidence for: ${criterion}`);
    }
  } else if (!output.findings.length) throw new Error(`${output.verdict} verification requires at least one criterion-linked finding.`);
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
  for (const definition of output.children) {
    const existing = network.regions.find((item) => item.parentId === region.id && item.key === definition.key);
    if (existing) continue;
    // Mirror validation's degenerate-criteria normalization so stored children stay consistent.
    const coveredCriteria = region.acceptanceCriteria.length === 0 && definition.coveredCriteria.length === 0 ? [0] : [...definition.coveredCriteria];
    network.regions.push({
      id: `r${network.nextRegionId++}`, key: definition.key, parentId: region.id, parentCandidateId: parentSelection, edge: definition.edge,
      lod: region.lod + 1, objective: definition.objective, delivery: definition.delivery ?? region.delivery,
      allowedVariables: [...definition.allowedVariables], acceptanceCriteria: [...definition.acceptanceCriteria], coveredCriteria,
      status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [],
    });
  }
  region.status = "collapsed";
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
  for (const file of [...new Set(actualChangedFiles)]) addArtifact(network, region, activationId, { kind: "file", path: file, summary: `Changed ${file}` });
  const reportedOnly = [...new Set(output.changedFiles)].filter((file) => !actualChangedFiles.includes(file));
  if (reportedOnly.length) addArtifact(network, region, activationId, { kind: "check", summary: `Unconfirmed model-reported files: ${reportedOnly.join(", ")}`, passed: false });
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  if (output.status === "completed" || output.status === "already-satisfied") region.status = "implemented";
  else if (countReopen(network, region)) {
    region.status = "superposed"; region.contradiction = output.blocker || output.summary || "Implementation reported a missing prerequisite."; region.selectedCandidateIds = [];
    for (const candidate of network.candidates.filter((item) => item.regionId === region.id && item.status === "selected")) { candidate.status = "possible"; candidate.declaredStatus = "possible"; }
  }
  network.revision++; return network;
}

export function completeVerification(networkInput: SolutionNetwork, activationId: string, output: VerificationOutput): SolutionNetwork {
  let network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed";
  for (const check of output.checks) addArtifact(network, region, activationId, { kind: "check", summary: `${check.name}: ${check.evidence}`, passed: check.passed });
  for (const request of output.activations) addActivation(network, { ...request, regionId: request.regionId ?? region.id, contextRefs: request.contextRefs, senderActivationId: activation.id });
  if (output.verdict === "pass") region.status = "verified";
  else if (output.verdict === "repair") {
    for (const targetId of new Set(output.findings.map((item) => item.regionId))) {
      const target = network.regions.find((item) => item.id === targetId);
      if (target) target.status = "actionable";
    }
  } else if (output.verdict === "reopen") {
    for (const targetId of new Set(output.findings.map((item) => item.regionId)))
      network = reopenRegion(network, targetId, output.summary || output.findings.filter((item) => item.regionId === targetId).map((item) => item.problem).join("; "));
  } else {
    region.status = "blocked";
    region.contradiction = output.summary || output.findings.map((item) => item.problem).join("; ");
  }
  network.revision++; return network;
}

export function completePresentation(networkInput: SolutionNetwork, activationId: string, answer: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const activation = network.activations.find((item) => item.id === activationId); const region = network.regions.find((item) => item.id === activation?.regionId);
  if (!activation || !region) return network;
  activation.status = "completed"; region.answer = answer; region.status = "implemented"; addArtifact(network, region, activationId, { kind: "answer", summary: answer }); network.revision++; return network;
}

/** A content fingerprint over the region's evidence and artifact contents: fresh ids carrying identical content keep it stable, so only genuinely new content can reset the reopen counter. */
function regionContentFingerprint(network: SolutionNetwork, region: SolutionRegion): string {
  const evidence = [...new Set(region.evidenceIds.map((id) => network.evidence.find((item) => item.id === id)?.fingerprint ?? `missing:${id}`))].sort();
  const artifacts = [...new Set(region.artifactIds.map((id) => network.artifacts.find((item) => item.id === id)).filter((item): item is SolutionNetwork["artifacts"][number] => Boolean(item)).map((item) => `${item.kind}\0${item.path ?? ""}\0${item.summary}\0${item.passed ?? ""}`))].sort();
  return createHash("sha256").update(`${evidence.join("\0")}\n${artifacts.join("\0")}`).digest("hex").slice(0, 16);
}

/**
 * Count one reopen against a region: identical evidence/artifact content accumulates the counter,
 * genuinely new content resets it, and the contentless reopen past MAX_ACTIVATION_RETRIES converts
 * the region to terminal "stalled" instead of reopening. Returns whether the reopen may proceed.
 */
function countReopen(network: SolutionNetwork, region: SolutionRegion): boolean {
  const fingerprint = regionContentFingerprint(network, region);
  if (fingerprint !== region.reopenFingerprint) { region.reopenFingerprint = fingerprint; region.reopens = 1; return true; }
  if (region.reopens >= MAX_ACTIVATION_RETRIES) {
    region.status = "stalled";
    region.contradiction = `Region ${region.id} stalled: ${region.reopens} reopens without new evidence`;
    return false;
  }
  region.reopens += 1;
  return true;
}

/** Regions that reached implementability via the depth floor rather than single-criterion actionability — surfaced in the run result, never silent. */
export function depthFloorRegionIds(network: SolutionNetwork): string[] {
  return network.regions.filter((item) => item.lod >= REFINEMENT_DEPTH_LIMIT && item.acceptanceCriteria.length !== 1 && ["implemented", "verified"].includes(item.status)).map((item) => item.id);
}

export function reopenRegion(networkInput: SolutionNetwork, regionId: string, reason: string): SolutionNetwork {
  const network = cloneNetwork(networkInput); const region = network.regions.find((item) => item.id === regionId); if (!region) return network;
  if (!countReopen(network, region)) return network;
  region.status = region.acceptanceCriteria.length ? "superposed" : "unformed"; region.contradiction = reason; region.selectedCandidateIds = [];
  region.coveredCriteria = undefined;
  for (const candidate of network.candidates.filter((item) => item.regionId === regionId)) { candidate.status = "possible"; candidate.declaredStatus = "possible"; }
  if (!region.acceptanceCriteria.length) {
    network.candidates = network.candidates.filter((item) => item.regionId !== regionId);
    region.candidateIds = [];
  }
  purgeDescendants(network, regionId);
  network.revision++; return network;
}

export function nextQueuedActivation(network: SolutionNetwork): Activation | undefined {
  return network.activations.filter((item) => item.status === "queued").sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)))[0];
}

function activationAdmitted(network: SolutionNetwork, activation: Activation): boolean {
  const region = network.regions.find((item) => item.id === activation.regionId);
  if (!region) return false;
  if (activation.capability === "inspect") return region.status === "unformed" || region.status === "superposed";
  if (activation.capability === "synthesize") return region.status === "superposed" || region.status === "contradiction";
  if (activation.capability === "refine") return region.status === "unrefined";
  if (activation.capability === "implement") return region.status === "actionable" && region.delivery === "change";
  if (activation.capability === "present") return region.status === "actionable" && region.delivery === "answer";
  if (activation.capability === "verify") return region.status === "implemented";
  return false;
}

const MUTATING_CAPABILITIES: Capability[] = ["implement", "verify"];

/**
 * Select the next activation batch. Mutating capabilities (implement/verify) always run
 * as a singleton; read-only capabilities (inspect/synthesize/present) are batched on
 * pairwise distinct regions up to `width`. A width of 1 reproduces sequential execution.
 */
export function selectActivationBatch(network: SolutionNetwork, width: number): Activation[] {
  const queued = network.activations.filter((item) => item.status === "queued" && activationAdmitted(network, item)).sort((left, right) => left.basisRevision - right.basisRevision || Number(left.id.slice(1)) - Number(right.id.slice(1)));
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
            current = setRegionStatus(current, record.regionId, "blocked");
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
  return { stateVersion: 7, runId: "", originalTask: "", conversationContext: "", directory: "", worktree: "", phase: "", activeBatch: [], network, results: [], usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, result: "" };
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
    network = queueActivation(network, "refine", unrefined.id, "Split the chosen approach into the next steps of work that together cover every success criterion.", `refinement:${unrefined.id}:${network.revision}`, [...unrefined.evidenceIds, ...unrefined.constraintIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Could not schedule refinement for ${unrefined.id}.` };
  }
  const contradiction = required.find((region) => region.status === "contradiction");
  if (contradiction) {
    network = queueActivation(network, "synthesize", contradiction.id, `Choose a consistent approach without changing unrelated choices: ${contradiction.contradiction ?? "every alternative was rejected"}`, `contradiction:${contradiction.id}:${network.revision}`, [...contradiction.constraintIds, ...contradiction.evidenceIds]);
    return nextQueuedActivation(network) ? { network, done: false } : { network, done: false, blocked: `Contradiction in ${contradiction.id} could not be resolved.` };
  }
  const unresolved = required.filter((region) => region.status === "unformed" || region.status === "superposed").sort((left, right) => {
    const viable = (region: SolutionRegion) => region.candidateIds.filter((id) => network.candidates.find((candidate) => candidate.id === id)?.status !== "eliminated").length;
    return viable(left) - viable(right) || right.lod - left.lod;
  });
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
  const stalled = required.find((region) => region.status === "stalled");
  if (stalled) return { network, done: false, blocked: `Region ${stalled.id} stalled: ${stalled.reopens} reopens without new evidence` };
  return { network, done: false, blocked: "The solution network has no runnable activation and no completed root." };
}
