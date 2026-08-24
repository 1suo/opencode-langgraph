import { describe, expect, it } from "vitest";
import { initialNetwork, mergeRefinementOutput, reopenRegion, resolveContextReference } from "../src/core/solution-lod/reducer.js";
import type { Activation, RefinementOutput, SolutionNetwork } from "../src/core/solution-lod/types.js";

const child = (key: string, objective = key): RefinementOutput["children"][number] => ({ key, objective, edge: "partOf", delivery: "change", allowedVariables: ["mode"], acceptanceCriteria: [`${key} done`], coveredCriteria: [0], requirementIds: ["requirement:one"], dependencyScopeIds: ["scope:dependency"], mutationResources: [`src/${key}.ts`] });

function refined(definitions: RefinementOutput["children"]): SolutionNetwork {
  const network = initialNetwork("change");
  const root = network.regions[0]!;
  root.status = "unrefined"; root.domainPhase = "selected"; root.acceptanceCriteria = ["done"]; root.criterionIds = ["criterion:scope:r1:0"];
  network.activations.push({ id: "a2", capability: "refine", regionId: "r1", request: "split", expectedDelta: "split", contextRefs: ["r1"], status: "running", basisRevision: 0 });
  root.activationIds.push("a2");
  return mergeRefinementOutput(network, "a2", { evidence: [], children: definitions, activations: [] });
}

function populate(network: SolutionNetwork, regionId: string): void {
  const region = network.regions.find((item) => item.id === regionId)!;
  region.status = "verified"; region.domainPhase = "selected"; region.domainFingerprint = "old"; region.acceptedFingerprint = "old"; region.challengeVerdict = "accept";
  region.candidateIds = [`${regionId}:choice`]; region.selectedCandidateIds = [`${regionId}:choice`]; region.constraintIds = ["c-old"]; region.activationIds.push("a-old"); region.artifactIds = ["x-old"];
  network.candidates.push({ id: `${regionId}:choice`, regionId, key: "choice", proposition: "old", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [] });
  network.variables.push({ id: "v-old", name: "old-coordinate", ownerRegionId: regionId, seedLabels: ["yes"] });
  network.constraints.push({ id: "c-old", kind: "requires", subject: `${regionId}:choice`, target: "v-old:yes", reason: "old", sourceActivationId: "a-old", sourceKind: "model-inference", evidenceRefs: [] });
  const activation: Activation = { id: "a-old", capability: "inspect", regionId, request: "old", expectedDelta: "old", contextRefs: [regionId, `${regionId}:choice`, "v-old:yes"], status: "queued", basisRevision: 0 };
  network.activations.push(activation);
  network.artifacts.push({ id: "x-old", regionId, kind: "file", path: "src/old.ts", summary: "old output", activationId: "a-old" });
}

function reconcile(network: SolutionNetwork, definitions: RefinementOutput["children"]): SolutionNetwork {
  network.activations.push({ id: "a3", capability: "refine", regionId: "r1", request: "reconcile", expectedDelta: "reconcile", contextRefs: ["r1"], status: "running", basisRevision: network.revision });
  network.regions[0]!.activationIds.push("a3");
  return mergeRefinementOutput(network, "a3", { evidence: [], children: definitions, activations: [] });
}

describe("conditional subtree reconciliation", () => {
  it("updates changed definitions deterministically and invalidates child domain and acceptance", () => {
    let network = refined([child("work")]); const id = network.regions.find((item) => item.parentId === "r1")!.id; populate(network, id);
    network = reconcile(network, [{ ...child(" work ", "changed objective"), delivery: "answer", allowedVariables: [" z ", "a"], acceptanceCriteria: ["new criterion"], requirementIds: ["requirement:two"], dependencyScopeIds: ["scope:other"], mutationResources: [" src/z.ts "] }]);
    expect(network.regions.find((item) => item.id === id)).toMatchObject({ key: "work", objective: "changed objective", delivery: "answer", allowedVariables: ["a", "z"], acceptanceCriteria: ["new criterion"], requirementIds: ["requirement:two"], dependencyScopeIds: ["scope:other"], mutationResources: ["src/z.ts"], status: "unformed", domainPhase: "inspecting", domainFingerprint: null, acceptedFingerprint: null, candidateIds: [], selectedCandidateIds: [] });
  });

  it("removes abandoned children and cleans stale coordinates and activations", () => {
    let network = refined([child("keep"), child("drop")]); const dropped = network.regions.find((item) => item.key === "drop")!; populate(network, dropped.id);
    network = reconcile(network, [child("keep")]);
    expect(network.regions.some((item) => item.id === dropped.id)).toBe(false);
    expect(resolveContextReference(network, `${dropped.id}:choice`)).toBeUndefined(); expect(resolveContextReference(network, "v-old:yes")).toBeUndefined();
    expect(network.constraints.find((item) => item.id === "c-old")?.historical).toBe(true);
    expect(network.activations.find((item) => item.id === "a-old")).toMatchObject({ status: "superseded", historical: true });
  });

  it("retains retired records as explicit historical artifacts", () => {
    let network = refined([child("work")]); const id = network.regions.find((item) => item.parentId === "r1")!.id; populate(network, id); network = reconcile(network, [child("work", "new work")]);
    expect(network.candidates.find((item) => item.id === `${id}:choice`)?.historical).toBe(true); expect(network.variables.find((item) => item.id === "v-old")?.historical).toBe(true); expect(network.artifacts.find((item) => item.id === "x-old")).toMatchObject({ summary: "old output", historical: true });
  });

  it("keeps reopen and reselection references sound", () => {
    let network = refined([child("work")]); const id = network.regions.find((item) => item.parentId === "r1")!.id; populate(network, id); network = reconcile(network, [child("work", "new work")]); network = reopenRegion(network, id, "reselect");
    expect(network.regions.find((item) => item.id === id)).toMatchObject({ selectedCandidateIds: [], acceptedFingerprint: null });
    expect(network.activations.filter((item) => !item.historical).every((item) => item.contextRefs.every((ref) => resolveContextReference(network, ref)))).toBe(true);
  });
});
