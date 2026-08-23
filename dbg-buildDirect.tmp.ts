import type { SolutionNetwork, CandidateStance } from "./src/core/solution-lod/types.js";
function buildDirect(seed: number): FastInstance {
  const random = rng(seed);
  const net = initialNetwork("t");
  net.activations[0].status = "completed";
  const varCount = Math.floor(random() * 3);
  for (let i = 0; i < varCount; i++) net.variables.push({ id: `v${i + 1}`, name: `choice-${i}`, ownerRegionId: "r1", seedLabels: [] });
  const childCount = 1 + Math.floor(random() * 2);
  const committedPicks: Array<{ regionId: string; id: string }> = [];
  for (let ci = 0; ci < childCount; ci++) {
    const rid = `r${ci + 2}`;
    const ds = 2 + Math.floor(random() * 2);
    net.regions.push({ id: rid, key: `c${ci}`, parentId: "r1", edge: "partOf", lod: 1, objective: rid, delivery: random() < 0.25 ? "answer" : "change", allowedVariables: [], acceptanceCriteria: [], status: "superposed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    for (let ki = 0; ki < ds; ki++) {
      const cid = `${rid}:c${ki}`;
      const stances: CandidateStance[] = [];
      for (let vi = 1; vi <= varCount; vi++) {
        const roll = random();
        if (roll < 0.35) stances.push({ variableId: `v${vi}`, relation: "requires", valueLabel: roll < 0.18 ? "alpha" : "beta" });
        else if (roll < 0.45) stances.push({ variableId: `v${vi}`, relation: "excludes", valueLabel: "alpha" });
        // Mixed demands on one holder: requires + excludes of the same variable must never
        // self-contest — regression coverage for the stale conflict-lock bug.
        else if (roll < 0.55) {
          stances.push({ variableId: `v${vi}`, relation: "requires", valueLabel: "beta" });
          stances.push({ variableId: `v${vi}`, relation: "excludes", valueLabel: "alpha" });
        }
      }
      net.candidates.push({ id: cid, regionId: rid, key: `c${ki}`, proposition: `${rid} o${ki}`, status: "possible", evidenceIds: [], eliminationReasons: [], stances });
      net.regions.find((r) => r.id === rid)!.candidateIds.push(cid);
    }
    if (random() < 0.2) {
      const target = pick(random, net.candidates.filter((c) => c.regionId === rid))!;
      target.status = "selected"; target.declaredStatus = "selected";
      committedPicks.push({ regionId: rid, id: target.id });
    }
    const sibs = net.candidates.filter((c) => c.regionId === rid);
    if (sibs.length >= 2 && random() < 0.4) {
      const l = pick(random, sibs)!; let r = pick(random, sibs)!; while (r.id === l.id) r = pick(random, sibs)!;
      net.constraints.push({ id: `pw${ci}`, kind: pick(random, ["requires", "excludes", "equivalent"] as const)!, subject: l.id, target: r.id, reason: "pairwise relation", sourceActivationId: "a9", sourceKind: pick(random, ["user-task", "repo-evidence", "model-inference"] as const)!, evidenceRefs: [] });
    }
    if (varCount > 0 && random() < 0.3) {
      const sub = pick(random, sibs)!;
      const vid = `v${1 + Math.floor(random() * varCount)}`;
      net.constraints.push({ id: `cx${ci}`, kind: "excludes", subject: sub.id, target: `${vid}:alpha`, reason: "move-vs-option", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: [] });
    }
  }
  const multiLevel = random() < 0.55;
  let descendantVariable = false;
  if (multiLevel) {
    const extraBudget = 5 - net.regions.length;
    const extraCount = 1 + Math.floor(random() * Math.max(1, extraBudget));
    let descendantVariableCount = 0;
    for (let extra = 0; extra < extraCount; extra++) {
      const possibleParents = net.regions.filter((region) => region.id !== "r1");
      const deepest = [...possibleParents].sort((left, right) => right.lod - left.lod || left.id.localeCompare(right.id))[0]!;
      const parent = random() < 0.7 ? deepest : pick(random, possibleParents)!;
      const rid = `r${20 + extra}`;
      const ownsVariable = random() < 0.8;
      const descendantVariableId = `v${varCount + ++descendantVariableCount}`;
      if (ownsVariable) {
        net.variables.push({ id: descendantVariableId, name: `descendant-choice-${extra}`, ownerRegionId: parent.id, seedLabels: ["red", "blue"] });
        descendantVariable = true;
      }
      net.regions.push({ id: rid, key: `descendant-${extra}`, parentId: parent.id, edge: random() < 0.5 ? "refines" : "partOf", lod: parent.lod + 1, objective: rid, delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "superposed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
      const size = 2 + Math.floor(random() * 2);
      for (let index = 0; index < size; index++) {
        const id = `${rid}:c${index}`;
        const stances: CandidateStance[] = [];
        if (ownsVariable) stances.push({ variableId: descendantVariableId, relation: index === 0 ? "requires" : "excludes", valueLabel: "red" });
        if (varCount > 0 && random() < 0.45) stances.push({ variableId: "v1", relation: "requires", valueLabel: index % 2 ? "beta" : "alpha" });
        net.candidates.push({ id, regionId: rid, key: `c${index}`, proposition: `${rid} option ${index}`, status: "possible", evidenceIds: [], eliminationReasons: [], stances });
        net.regions.at(-1)!.candidateIds.push(id);
      }
      if (random() < 0.2) {
        const selected = pick(random, net.candidates.filter((candidate) => candidate.regionId === rid))!;
        selected.status = "selected"; selected.declaredStatus = "selected";
        committedPicks.push({ regionId: rid, id: selected.id });
      }
    }
  }
  let ec = 0;
  const rc = Math.floor(random() * varCount * 2);
  for (let i = 0; i < rc && varCount > 0; i++) {
    const vid = `v${1 + Math.floor(random() * varCount)}`;
    const label = pick(random, ["alpha", "beta"])!;
    const eid = `e${++ec}`;
    net.evidence.push({ id: eid, text: eid, source: `s/${eid}`, kind: "repository", fingerprint: eid });
    net.constraints.push({ id: `cr${i}`, kind: "refutes", subject: "task", target: `${vid}:${label}`, reason: "coordinate refutation", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: [eid] });
  }
  for (let i = 0; i < Math.floor(random() * 3); i++) {
    const t = pick(random, net.candidates); if (!t) break;
    const eid = `e${++ec}`;
    net.evidence.push({ id: eid, text: eid, source: `s/${eid}`, kind: "repository", fingerprint: eid });
    if (random() < 0.6) net.constraints.push({ id: `ce${i}`, kind: "refutes", subject: eid, target: t.id, reason: "evidence kill", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: [eid] });
    else net.constraints.push({ id: `cs${i}`, kind: "supports", subject: eid, target: t.id, reason: "support", sourceActivationId: "a9", sourceKind: "model-inference", evidenceRefs: [eid] });
  }
  assertAcyclicPrimalGraph(net); // throws on coupling cycles — caught by generateInstance for retry
  return { network: net, committedPicks, multiLevel, descendantVariable, maxDepth: Math.max(...net.regions.map((region) => region.lod)) };
}