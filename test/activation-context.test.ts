import { describe, expect, it } from "vitest";
import { projectActivationContext } from "../src/core/solution-lod/graph.js";
import { applyBatchRecords, initialNetwork, queueActivation, resolveContextReference, selectActivationBatch, supersedeStaleQueuedActivations } from "../src/core/solution-lod/reducer.js";
import type { ActivationTaskResult, SolutionLodState, SolutionNetwork } from "../src/core/solution-lod/types.js";

const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const state = (network: SolutionNetwork): SolutionLodState => ({ stateVersion: 8, runId: "context", originalTask: "task", conversationContext: "", directory: "/r", worktree: "/r", phase: "", activeBatch: [], network, results: [], usage, callsUsed: 0, startedAt: 0, result: "" });

function networkWithReferences(): SolutionNetwork {
  const network = initialNetwork("task");
  network.activations[0]!.status = "completed";
  network.regions[0]!.status = "superposed";
  network.regions[0]!.domainPhase = "inspecting";
  network.candidates.push({ id: "r1:c", regionId: "r1", key: "c", proposition: "candidate", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [], createdRevision: 1 });
  network.evidence.push({ id: "e1", text: "fact", source: "src/x.ts:1", kind: "repository", status: "confirmed", fingerprint: "fact", createdRevision: 1 });
  network.constraints.push({ id: "c1", kind: "supports", subject: "e1", target: "r1:c", reason: "supports", sourceActivationId: "a1", sourceKind: "repo-evidence", evidenceRefs: ["e1"], createdRevision: 1 });
  network.artifacts.push({ id: "x1", regionId: "r1", kind: "check", summary: "passed", passed: true, activationId: "a1", createdRevision: 1 });
  network.variables.push({ id: "v1", name: "mode", ownerRegionId: "r1", seedLabels: ["fast"] });
  network.regions[0]!.candidateIds = ["r1:c"];
  network.regions[0]!.evidenceIds = ["e1"];
  network.regions[0]!.constraintIds = ["c1"];
  network.regions[0]!.artifactIds = ["x1"];
  return network;
}

describe("activation context", () => {
  it("resolves and projects every accepted typed context reference through one resolver", () => {
    let network = networkWithReferences();
    const refs = ["task", "r1", "r1:c", "e1", "c1", "x1", "a1", "v1:fast"];
    network = queueActivation(network, "inspect", "r1", "inspect refs", "refs", refs);
    const activation = network.activations.at(-1)!;
    expect(activation.readRefs!.map(({ ref, kind }) => [ref, kind])).toEqual([...activation.readRefs!].sort((left, right) => left.ref.localeCompare(right.ref)).map(({ ref, kind }) => [ref, kind]));
    expect(activation.readRefs!.map((read) => read.kind).sort()).toEqual(["activation", "artifact", "candidate", "constraint", "coordinate", "evidence", "region", "task"]);
    expect(activation.readRefs!.every((read) => Number.isInteger(read.revision) && read.fingerprint.length > 0)).toBe(true);
    const projection = projectActivationContext(state(network), activation) as { referencedContext: Array<{ ref: string; kind: string }> };
    expect(projection.referencedContext.map(({ ref, kind }) => [ref, kind])).toEqual(activation.readRefs!.map(({ ref, kind }) => [ref, kind]));
  });

  it("uses deterministic intent idempotency while allowing a fresh request after supersession", () => {
    let network = networkWithReferences();
    network = queueActivation(network, "inspect", "r1", "first wording", "same delta", ["e1"]);
    const first = network.activations.at(-1)!;
    network = queueActivation(network, "inspect", "r1", "different wording", "same delta", ["e1"]);
    expect(network.activations).toHaveLength(2);
    network.evidence[0]!.text = "changed fact";
    network = supersedeStaleQueuedActivations(network);
    expect(network.activations.find((item) => item.id === first.id)?.status).toBe("superseded");
    network = queueActivation(network, "inspect", "r1", "fresh wording", "same delta", ["e1"]);
    const fresh = network.activations.at(-1)!;
    expect(fresh.idempotencyKey).toBe(first.idempotencyKey);
    expect(fresh.readRefs!.find((item) => item.ref === "e1")?.fingerprint).not.toBe(first.readRefs!.find((item) => item.ref === "e1")?.fingerprint);
  });

  it("keeps unrelated sibling changes local but supersedes a stale queued read and stale result", () => {
    let network = networkWithReferences();
    network.regions.push({ ...structuredClone(network.regions[0]!), id: "r2", key: "sibling", scopeId: "scope:r2", candidateIds: [], constraintIds: [], evidenceIds: [], artifactIds: [], activationIds: [], criterionIds: [] });
    network = queueActivation(network, "inspect", "r1", "inspect fact", "fact", ["e1"]);
    const activation = network.activations.at(-1)!;
    network.regions.find((item) => item.id === "r2")!.objective = "changed sibling";
    expect(selectActivationBatch(network, 1).map((item) => item.id)).toEqual([activation.id]);
    network.evidence[0]!.text = "stale fact";
    const result: ActivationTaskResult = { activationId: activation.id, regionId: "r1", capability: "inspect", basisRevision: activation.basisRevision, startedAt: 0, finishedAt: 1, usage, outcome: "applied", networkDelta: { kind: "delta", delta: { region: {}, evidence: [], candidates: [], constraints: [], select: [], activations: [] } } };
    const applied = applyBatchRecords(network, [result]);
    expect(applied.superseded).toEqual([activation.id]);
    expect(applied.network.activations.find((item) => item.id === activation.id)?.status).toBe("superseded");
  });
});
