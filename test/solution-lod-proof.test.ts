import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { CandidateStance, SolutionLodState, SolutionNetwork } from "../src/core/solution-lod/types.js";
import { SolutionDeltaSchema } from "../src/core/solution-lod/types.js";
import { assertAcyclicPrimalGraph, applyBatchRecords, ensureRunnableWork, initialNetwork, mergeSolutionDelta, propagateNetwork, purgeDescendants } from "../src/core/solution-lod/reducer.js";
import { projectActivationContext, solutionLodGraph } from "../src/core/solution-lod/graph.js";

// ─── shared helpers ──────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(random: () => number, items: T[]): T | undefined => items[Math.floor(random() * items.length)];
function shuffled<T>(random: () => number, items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) { const swap = Math.floor(random() * (index + 1)); [copy[index], copy[swap]] = [copy[swap], copy[index]]; }
  return copy;
}
const EMPTY_STATE = {
  stateVersion: 7, runId: "oracle", originalTask: "t", conversationContext: "", directory: "/repo", worktree: "/repo", phase: "", activeBatch: [], results: [], usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, result: "",
} as const;

/** Canonical derived state: input-array order is irrelevant, every consequential field is not. */
function semanticSnapshot(value: SolutionNetwork): string {
  return JSON.stringify({
    revision: value.revision,
    variables: value.variables.map((v) => ({ ...v, seedLabels: [...(v.seedLabels ?? [])].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    candidates: value.candidates.map((c) => ({ ...c, evidenceIds: [...c.evidenceIds].sort(), declaredEvidenceIds: [...(c.declaredEvidenceIds ?? [])].sort(), eliminationReasons: [...c.eliminationReasons].sort(), declaredEliminationReasons: [...(c.declaredEliminationReasons ?? [])].sort(), stances: [...(c.stances ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })).sort((a, b) => a.id.localeCompare(b.id)),
    regions: value.regions.map((r) => ({ ...r, allowedVariables: [...r.allowedVariables].sort(), acceptanceCriteria: [...r.acceptanceCriteria].sort(), candidateIds: [...r.candidateIds].sort(), selectedCandidateIds: [...r.selectedCandidateIds].sort(), constraintIds: [...r.constraintIds].sort(), evidenceIds: [...r.evidenceIds].sort(), activationIds: [...r.activationIds].sort(), artifactIds: [...r.artifactIds].sort(), coveredCriteria: [...(r.coveredCriteria ?? [])].sort((a, b) => a - b) })).sort((a, b) => a.id.localeCompare(b.id)),
    constraints: [...value.constraints].sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...value.evidence].sort((a, b) => a.id.localeCompare(b.id)),
    activations: value.activations.map((a) => ({ ...a, contextRefs: [...a.contextRefs].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: [...value.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Full derived-state dump for idempotence: everything must be bit-for-bit stable. */
function fullSnapshot(value: SolutionNetwork): string {
  return JSON.stringify(value);
}

const stanceOf = (network: SolutionNetwork): Map<string, CandidateStance[]> => {
  const map = new Map<string, CandidateStance[]>();
  for (const candidate of network.candidates) map.set(candidate.id, [...(candidate.stances ?? [])]);
  return map;
};

const factKills = (network: SolutionNetwork) => {
  const variableIds = new Set(network.variables.map((v) => v.id));
  const evidenceKills = new Set<string>();
  const refutedCoordinates = new Set<string>();
  for (const constraint of network.constraints) {
    if (constraint.kind !== "refutes") continue;
    const colon = constraint.target.indexOf(":");
    if (colon > 0 && variableIds.has(constraint.target.slice(0, colon))) {
      if (!constraint.evidenceRefs?.length) continue;
      if (!constraint.evidenceRefs.every((ref) => network.evidence.some((e) => e.id === ref))) continue;
      refutedCoordinates.add(`${constraint.target.slice(0, colon)}\u0000${constraint.target.slice(colon + 1).trim().toLowerCase()}`);
    } else if (network.evidence.some((e) => e.id === constraint.subject)) {
      evidenceKills.add(constraint.target);
    }
  }
  return { evidenceKills, refutedCoordinates, variableIds };
};

// ─── Tier 1: fast direct-construction generator ─────────────────────────────

interface FastInstance {
  network: SolutionNetwork;
  committedPicks: Array<{ regionId: string; id: string }>;
}

function buildDirect(seed: number): FastInstance {
  const random = rng(seed);
  const net = initialNetwork("t");
  net.activations[0].status = "completed";
  const varCount = Math.floor(random() * 3);
  for (let i = 0; i < varCount; i++) net.variables.push({ id: `v${i + 1}`, name: `choice-${i}`, ownerRegionId: "r1", seedLabels: [] });
  const childCount = 2 + Math.floor(random() * 2);
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
  return { network: net, committedPicks };
}

// ─── Declarative joint enumeration (shared by both tiers) ───────────────────

interface EnumerationResult {
  anyValid: boolean;
  usedCandidates: Set<string>;
  usedCoordinates: Map<string, Set<string>>; // varId -> Set<labelLower>
}

function enumerateJoint(network: SolutionNetwork, committedPicks: Array<{ regionId: string; id: string }>): EnumerationResult {
  const liveRegions = network.regions.filter((r) => r.candidateIds.length > 0);
  const domains = liveRegions.map((r) => [...r.candidateIds]);
  const stanceMap = stanceOf(network);
  const { evidenceKills, refutedCoordinates, variableIds } = factKills(network);
  const varIds = [...variableIds];

  // Label domain per variable: seed ∪ all stance labels.
  const labelDomains = new Map<string, string[]>();
  for (const vid of varIds) {
    const set = new Set<string>();
    for (const v of network.variables) if (v.id === vid) for (const s of v.seedLabels ?? []) set.add(s.toLowerCase());
    for (const c of network.candidates) for (const st of c.stances ?? []) if (st.variableId === vid) set.add(st.valueLabel.toLowerCase());
    labelDomains.set(vid, ["", ...[...set]]); // "" = unbound
  }

  const satisfied = (id: string, labels: Record<string, string>): boolean => {
    if (evidenceKills.has(id)) return false;
    for (const st of stanceMap.get(id) ?? []) {
      const bound = labels[st.variableId] ?? "";
      if (st.relation === "requires") { if (bound !== st.valueLabel.toLowerCase()) return false; if (refutedCoordinates.has(`${st.variableId}\u0000${bound}`)) return false; }
      if (st.relation === "excludes") { if (bound === st.valueLabel.toLowerCase()) return false; }
    }
    return true;
  };

  const commitByRegion = new Map(committedPicks.map((e) => [e.regionId, e.id] as const));

  const usedCandidates = new Set<string>();
  const usedCoordinates = new Map<string, Set<string>>();
  let anyValid = false;

  const totalVarCombos = varIds.reduce((p, vid) => p * labelDomains.get(vid)!.length, 1);
  const totalPickCombos = domains.reduce((p, d) => p * d.length, 1);

  for (let vi = 0; vi < Math.max(totalVarCombos, 1); vi++) {
    const labels: Record<string, string> = {};
    { let rem = vi; for (const vid of varIds) { const opts = labelDomains.get(vid)!; const choice = opts[rem % opts.length]!; rem = Math.floor(rem / opts.length); if (choice !== "") labels[vid] = choice; } }
    for (let pi = 0; pi < totalPickCombos; pi++) {
      const picks: string[] = [];
      { let rem = pi; for (const d of domains) { picks.push(d[rem % d.length]!); rem = Math.floor(rem / d.length); } }

      // Commitments force their region unless fact-dead or structurally unsatisfiable.
      let ok = true;
      for (let slot = 0; slot < liveRegions.length && ok; slot++) {
        const commitId = commitByRegion.get(liveRegions[slot].id);
        if (!commitId) continue;
        const structurallyBad = network.constraints.some((c) => c.kind === "requires" && c.subject === commitId && c.target !== commitId && c.target.startsWith(`${liveRegions[slot].id}:`));
        const factDead = evidenceKills.has(commitId) || (stanceMap.get(commitId) ?? []).some((stance) => stance.relation === "requires" && refutedCoordinates.has(`${stance.variableId}\u0000${stance.valueLabel.toLowerCase()}`));
        if (factDead || structurallyBad) { if (picks[slot] === commitId) ok = false; continue; }
        if (picks[slot] !== commitId || !satisfied(commitId, labels)) ok = false;
      }
      if (!ok) continue;

      // Expand equivalent classes into co-selected sets.
      const chosen = new Set(picks);
      for (const id of picks) {
        for (const constraint of network.constraints) {
          if (constraint.kind !== "equivalent") continue;
          if (constraint.subject === id && chosen.has(constraint.target) === false && !evidenceKills.has(constraint.target)) chosen.add(constraint.target);
          if (constraint.target === id && chosen.has(constraint.subject) === false && !evidenceKills.has(constraint.subject)) chosen.add(constraint.subject);
        }
      }

      // Every co-picked candidate must be satisfied.
      for (const id of chosen) {
        if (!satisfied(id, labels)) { ok = false; break; }
        for (const constraint of network.constraints) {
          if (constraint.kind !== "excludes" || constraint.target.includes(":")) continue;
          if (constraint.subject === id && chosen.has(constraint.target)) { ok = false; break; }
          if (constraint.target === id && chosen.has(constraint.subject)) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;

      // Pairwise requires/excludes among picks.
      for (const constraint of network.constraints) {
        if (constraint.kind !== "requires" && constraint.kind !== "excludes") continue;
        const l = chosen.has(constraint.subject), r = chosen.has(constraint.target);
        if (constraint.kind === "excludes" && l && r) { ok = false; break; }
        if (constraint.kind === "requires" && l && !r) { ok = false; break; }
      }
      if (!ok) continue;

      // Coordinate-excludes from forced/committed sources.
      for (const constraint of network.constraints) {
        if (constraint.kind !== "excludes") continue;
        const colon = constraint.target.indexOf(":");
        if (!(colon > 0 && variableIds.has(constraint.target.slice(0, colon)))) continue;
        const head = constraint.target.slice(0, colon);
        const label = constraint.target.slice(colon + 1).trim().toLowerCase();
        // Declarative meaning: the rule applies exactly in worlds where its subject is chosen.
        // No propagation/singleton algorithm is reproduced here.
        const isSource = chosen.has(constraint.subject);
        if (!isSource) continue;
        if (labels[head] === label) { ok = false; break; }
        for (const otherId of chosen) {
          if (otherId === constraint.subject) continue;
          for (const st of stanceMap.get(otherId) ?? []) {
            if (st.relation === "requires" && st.variableId === head && st.valueLabel.toLowerCase() === label) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) break;
      }
      if (!ok) continue;

      // Coordinate-refutes from task/evidence facts.
      for (const [vid, labelSet] of Object.entries(labels).length ? refutedCoordinateDemands(chosen, stanceMap) : []) {
        void vid; void labelSet;
      }
      for (const id of chosen) {
        for (const st of stanceMap.get(id) ?? []) {
          if (st.relation !== "requires") continue;
          if (refutedCoordinates.has(`${st.variableId}\u0000${st.valueLabel.toLowerCase()}`)) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;

      anyValid = true;
      for (const id of chosen) usedCandidates.add(id);
      for (const id of chosen) {
        for (const st of stanceMap.get(id) ?? []) {
          if (st.relation !== "requires") continue;
          if (!usedCoordinates.has(st.variableId)) usedCoordinates.set(st.variableId, new Set());
          usedCoordinates.get(st.variableId)!.add(st.valueLabel.toLowerCase());
        }
      }
    }
  }

  return { anyValid, usedCandidates, usedCoordinates };
}

// Helper: collect coordinate demands from chosen candidates' requires-stances.
function* refutedCoordinateDemands(chosen: Set<string>, stanceMap: Map<string, CandidateStane[]>): Generator<[string, string]> {
  for (const id of chosen) { for (const st of stanceMap.get(id) ?? []) { if (st.relation === "requires") yield [st.variableId, st.valueLabel]; } }
}
type CandidateStane<T = string> = { variableId: T; relation: string; valueLabel: string };

// ─── Tier 1: fast soundness oracle (500+ seeds, direct construction) ────────

describe("soundness oracle — fast tier (declarative joint enumeration)", () => {
  const SEEDS = Number(process.env.NEOLIT_ORACLE_SEEDS ?? 500);
  it(`never eliminates a candidate or coordinate some valid assignment uses (${SEEDS} seeds)`, () => {
    let eliminationsSeen = 0, skipped = 0;
    const constraintKinds = new Set<string>(); const provenanceKinds = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      let network: SolutionNetwork | null = null; let committedPicks: Array<{ regionId: string; id: string }> = [];
      for (let attempt = 0; attempt < 4; attempt++) { try { const inst = buildDirect(seed * 11 + attempt); if (inst) { network = inst.network; committedPicks = inst.committedPicks; break; } } catch { /* coupling cycle — retry */ } }
      if (!network) continue;
      for (const constraint of network.constraints) { constraintKinds.add(constraint.kind); provenanceKinds.add(constraint.sourceKind); }
      const propagated = propagateNetwork(structuredClone(network));
      const { anyValid, usedCandidates, usedCoordinates } = enumerateJoint(network, committedPicks);
      if (!anyValid) continue; // cross-region inconsistency is a documented incompleteness
      for (const candidate of propagated.candidates) {
        if (candidate.status !== "eliminated") continue;
        eliminationsSeen++;
        const ctx = `seed=${seed} cand=${candidate.id} reasons=${JSON.stringify(candidate.eliminationReasons)}`;
        expect(candidate.eliminationReasons.length, `witness required: ${ctx}`).toBeGreaterThan(0);
        expect(candidate.eliminationReasons.every((r) => r.trim().length > 3), `witness substance: ${ctx}`).toBe(true);
        if (usedCandidates.has(candidate.id)) fs.writeFileSync("/tmp/opencode/unsound-case.json", JSON.stringify({ seed, input: network, out: propagated, committedPicks }, null, 2));
        expect(usedCandidates.has(candidate.id), `unsound elimination: ${ctx}`).toBe(false);
      }
      for (const [variableId, labels] of usedCoordinates) for (const label of labels) {
        expect(propagated.candidates.some((candidate) => candidate.status !== "eliminated" && candidate.stances?.some((stance) => stance.relation === "requires" && stance.variableId === variableId && stance.valueLabel.toLowerCase() === label)), `used coordinate ${variableId}=${label} lost every viable witness`).toBe(true);
      }
      const twice = propagateNetwork(structuredClone(propagated));
      expect(fullSnapshot(twice), `seed=${seed} full idempotence`).toBe(fullSnapshot(propagated));
      expect(twice.revision, `seed=${seed} revision idempotence`).toBe(propagated.revision);
    }
    expect(eliminationsSeen, "expected meaningful coverage").toBeGreaterThan(SEEDS / 10);
    expect([...constraintKinds].sort()).toEqual(["equivalent", "excludes", "refutes", "requires", "supports"]);
    expect([...provenanceKinds].sort()).toEqual(["model-inference", "repo-evidence", "user-task"]);
  });

  it("is order-independent across every insertion dimension", () => {
    for (let seed = 1; seed <= 80; seed++) {
      let net2: SolutionNetwork | null = null;
      for (let attempt = 0; attempt < 4; attempt++) { try { net2 = buildDirect(seed * 11 + attempt).network; break; } catch { /* retry */ } }
      if (!net2) continue;
      const network = net2;
      const forward = propagateNetwork(structuredClone(network));
      const permuted: SolutionNetwork = structuredClone(network);
      permuted.regions = shuffled(rng(seed * 13 + 1), permuted.regions);
      permuted.candidates = shuffled(rng(seed * 13 + 2), permuted.candidates).map((c) => ({ ...c, stances: shuffled(rng(seed * 131), c.stances ?? []) }));
      permuted.constraints = shuffled(rng(seed * 13 + 3), permuted.constraints);
      permuted.evidence = shuffled(rng(seed * 13 + 4), permuted.evidence);
      permuted.variables = shuffled(rng(seed * 13 + 5), permuted.variables);
      permuted.activations = shuffled(rng(seed * 13 + 6), permuted.activations);
      const backward = propagateNetwork(permuted);
      expect(semanticSnapshot(backward)).toBe(semanticSnapshot(forward));
    }
  });
});

// ─── Tier 2: merge-boundary suite (30 seeds through real parse + merge) ─────

describe("merge-boundary suite", () => {
  const BOUNDARY_SEEDS = Number(process.env.NEOLIT_BOUNDARY_SEEDS ?? 15);
  it(`generates through real schema parse + mergeSolutionDelta (${BOUNDARY_SEEDS} seeds)`, () => {
    let skipped = 0;
    for (let seed = 1; seed <= BOUNDARY_SEEDS; seed++) {
      const instance = generateThroughMerge(seed);
      if (!instance) { skipped++; continue; }
      const propagated = propagateNetwork(instance.network);
      const { anyValid, usedCandidates } = enumerateJoint(instance.network, instance.committedPicks);
      if (!anyValid) continue;
      for (const candidate of propagated.candidates) {
        if (candidate.status !== "eliminated") continue;
        expect(usedCandidates.has(candidate.id), `seed=${seed} unsound: ${candidate.id}`).toBe(false);
      }
    }
    expect(skipped, "too many merge rejections").toBeLessThanOrEqual(BOUNDARY_SEEDS / 3);
  });

  function generateThroughMerge(seed: number): OracleInstance | null {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return buildThroughMerge(seed * 11 + attempt); } catch { /* retry */ }
    }
    return null;
  }

  function buildThroughMerge(seed: number): OracleInstance {
    const random = rng(seed);
    let net = initialNetwork("boundary task");
    net.activations[0].status = "completed";
    let ac = 1;
    const pushAct = (rid: string): string => {
      const id = `a${++ac}`;
      net.activations.push({ id, capability: "synthesize", regionId: rid, request: `fill ${rid}`, expectedDelta: `${id}:${net.revision}`, contextRefs: [rid], status: "running", basisRevision: net.revision });
      net.regions.find((r) => r.id === rid)?.activationIds.push(id);
      return id;
    };
    const doMerge = (rid: string, delta: unknown): SolutionNetwork => {
      const aid = pushAct(rid);
      const parsed = SolutionDeltaSchema.parse(delta);
      net = mergeSolutionDelta({ ...EMPTY_STATE, network: net } as SolutionLodState, aid, parsed);
      return net;
    };
    const committedPicks: Array<{ regionId: string; id: string }> = [];
    const varCount = Math.floor(random() * 3);
    const varNames = Array.from({ length: varCount }, (_, i) => `choice-${i}`);
    net.regions[0].status = "superposed";
    net = doMerge("r1", { region: {}, evidence: [], variables: varNames.map((name) => ({ name, seedLabels: [] })), candidates: [], constraints: [], select: [], activations: [] });
    const rootVars = net.variables.filter((v) => v.name.startsWith("choice-"));
    const cc = 2 + Math.floor(random() * 2);
    for (let ci = 0; ci < cc; ci++) {
      const rid = `r${ci + 2}`;
      net.regions.push({ id: rid, key: rid, parentId: "r1", edge: "partOf", lod: 1, objective: rid, delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
      const ds = 1 + Math.floor(random() * 3);
      const candidates: any[] = []; const constraints: any[] = []; const evidence: any[] = [];
      for (let ki = 0; ki < ds; ki++) {
        const stances: any[] = [];
        for (const rv of rootVars) {
          const roll = random();
          if (roll < 0.35) stances.push({ variable: rv.name, relation: "requires", valueLabel: roll < 0.18 ? "alpha" : "beta" });
          else if (roll < 0.45) stances.push({ variable: rv.name, relation: "excludes", valueLabel: "alpha" });
        }
        candidates.push({ key: `c${ki}`, proposition: `${rid} o${ki}`, outcome: "possible", reasons: [], evidenceRefs: [], stances });
      }
      if (random() < 0.25 && candidates.length) {
        const ck = pick(random, candidates.map((c) => c.key as string))!;
        candidates.forEach((c) => { if (c.key === ck) c.outcome = "selected"; });
        if (rootVars.length) {
          const tv = pick(random, rootVars)!;
          const src = `src/bc-${ci}.ts:1`;
          evidence.push({ text: `cite ${src}`, source: src, kind: "repository" });
          constraints.push({ kind: "excludes", subject: ck, target: `${tv.name}:${pick(random, ["alpha", "beta"])!}`, reason: "bc", sourceKind: "repo-evidence", evidenceRefs: [src] });
        }
      }
      net = doMerge(rid, { region: {}, evidence, candidates, constraints, select: [], activations: [] });
      if (random() < 0.2 && candidates.length) {
        const ck = pick(random, candidates.map((c) => c.key as string))!;
        net = doMerge(rid, { region: {}, evidence: [], candidates: [], constraints: [], select: [ck], activations: [] });
        const sid = net.regions.find((r) => r.id === rid)?.selectedCandidateIds[0];
        if (sid) committedPicks.push({ regionId: rid, id: sid });
      }
    }
    assertAcyclicPrimalGraph(net);
    const authored = net.candidates.filter((candidate) => candidate.declaredStatus === "selected").map((candidate) => ({ regionId: candidate.regionId, id: candidate.id }));
    return { network: net, committedPicks: [...new Map([...committedPicks, ...authored].map((entry) => [entry.regionId, entry])).values()] };
  }
});

// ─── Named matrix additions ─────────────────────────────────────────────────

describe("named regression matrix additions", () => {
  it("three-variable clique cycle is rejected", () => {
    const n = initialNetwork("t");
    n.variables.push({ id: "v1", name: "a", ownerRegionId: "r1", seedLabels: [] }, { id: "v2", name: "b", ownerRegionId: "r1", seedLabels: [] }, { id: "v3", name: "c", ownerRegionId: "r1", seedLabels: [] });
    n.candidates.push(
      { id: "r2:x", regionId: "r2", key: "x", proposition: "", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "p" }, { variableId: "v2", relation: "requires", valueLabel: "q" }] },
      { id: "r2:y", regionId: "r2", key: "y", proposition: "", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v2", relation: "requires", valueLabel: "q" }, { variableId: "v3", relation: "requires", valueLabel: "r" }] },
    );
    n.regions.push({ ...n.regions[0], id: "r2", key: "r2", parentId: "r1", edge: "partOf", lod: 1, objective: "", delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "superposed", candidateIds: ["r2:x", "r2:y"], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    expect(() => assertAcyclicPrimalGraph(n)).not.toThrow(); // chain a-b-c is legal
    n.candidates.push({ id: "r2:z", regionId: "r2", key: "z", proposition: "", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "prefers", valueLabel: "p" }, { variableId: "v3", relation: "prefers", valueLabel: "r" }] });
    expect(() => assertAcyclicPrimalGraph(n)).toThrow(/close a coupling cycle/); // z closes triangle
  });

  it("owner-variable invalidation drops stale coordinate constraints", () => {
    const n = initialNetwork("t");
    n.regions.push({ ...n.regions[0], id: "r2", key: "child", parentId: "r1", edge: "partOf", lod: 1, objective: "", delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "unformed", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    n.variables.push({ id: "v9", name: "sub-choice", ownerRegionId: "r2", seedLabels: [] });
    n.constraints.push({ id: "c9", kind: "refutes", subject: "task", target: "v9:red", reason: "test", sourceActivationId: "a9", sourceKind: "user-task", evidenceRefs: ["eZ"] });
    n.evidence.push({ id: "eZ", text: "z", source: "z:1", kind: "repository", fingerprint: "z" });
    // Remove the require() call — purgeDescendants is imported at the top.
    purgeDescendants(n, "r1");
    expect(n.variables.find((v) => v.id === "v9")).toBeUndefined();
    expect(n.constraints.find((c) => c.id === "c9")).toBeUndefined();
  });

  it("exact structured empty-domain witness", () => {
    const n = initialNetwork("t");
    n.evidence.push({ id: "e1", text: "f", source: "f:1", kind: "repository", fingerprint: "e1" });
    n.candidates.push({ id: "r2:x", regionId: "r2", key: "x", proposition: "", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [] });
    n.regions.push({ ...n.regions[0], id: "r2", key: "r2", parentId: "r1", edge: "partOf", lod: 1, objective: "", delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "superposed", candidateIds: ["r2:x"], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    n.constraints.push({ id: "c1", kind: "refutes", subject: "e1", target: "r2:x", reason: "dead", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: ["e1"] });
    const out = propagateNetwork(n);
    expect(out.regions.find((r) => r.id === "r2")?.contradiction).toBe("Every candidate was eliminated.");
  });
});

// ─── Graph-level fixtures ───────────────────────────────────────────────────

describe("terminal-state replay through the real graph (fully verified checkpoint)", () => {
  it("completes with a throwing runtime and never invokes a model", async () => {
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async () => { throw new Error("NO MODEL"); } };
    const authored = initialNetwork("settled change");
    authored.regions = [{ ...authored.regions[0], acceptanceCriteria: ["done"], status: "verified", candidateIds: ["r1:d"], selectedCandidateIds: ["r1:d"] }];
    authored.candidates = [{ id: "r1:d", regionId: "r1", key: "d", proposition: "", status: "selected", evidenceIds: [], eliminationReasons: [], stances: [] }];
    authored.activations = [];
    const result = await configured.graph.invoke({ ...configured.initial({ task: "s", directory: "/r", worktree: "/r", runId: "z" }), network: authored }, { recursionLimit: 16, configurable: { thread_id: "z", langgraphOpenCodeRuntime: runtime } });
    expect(configured.result?.(result as SolutionLodState)).toContain("Implemented and verified");
    expect(configured.progress?.(result as SolutionLodState)?.phase).toBe("completed");
  });
});

describe("nonterminal actionable configuration blocks at exploration limit without model calls", () => {
  it("reaches blocked phase at the limit without invoking the runtime", async () => {
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async () => { throw new Error("NO MODEL"); } };
    const authored = initialNetwork("unverified change");
    authored.regions = [{ ...authored.regions[0], acceptanceCriteria: ["done"], candidateIds: ["r1:d"], selectedCandidateIds: ["r1:d"] }];
    authored.candidates = [{ id: "r1:d", regionId: "r1", key: "d", proposition: "", status: "selected", evidenceIds: [], eliminationReasons: [], stances: [] }];
    const initial = configured.initial({ task: "u", directory: "/r", worktree: "/r", runId: "exh" });
    const injected = { ...initial, network: propagateNetwork(authored), callsUsed: 256 };
    const result = await configured.graph.invoke(injected, { recursionLimit: 16, configurable: { thread_id: "exh", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result as SolutionLodState)?.phase).toBe("blocked");
    expect(configured.result?.(result as SolutionLodState)).toContain("exploration-limit");
  });
});

// Re-export needed types for local use
type CandidateStance2 = CandidateStance;
