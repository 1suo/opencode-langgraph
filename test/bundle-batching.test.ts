import { describe, expect, it } from "vitest";
import { initialNetwork, mergeSolutionDelta, selectActivationBatch, validateSolutionDelta } from "../src/core/solution-lod/reducer.js";
import { SolutionDeltaSchema, type Activation, type SolutionLodState, type SolutionNetwork } from "../src/core/solution-lod/types.js";

const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const state = (network: SolutionNetwork): SolutionLodState => ({ stateVersion: 8, runId: "batch", originalTask: "deliver all requested work", conversationContext: "", directory: "/r", worktree: "/r", phase: "", activeBatch: [], network, results: [], usage, callsUsed: 0, startedAt: 0, result: "" });

const mutationNetwork = (resources: string[][]): SolutionNetwork => {
  const network = initialNetwork("mutate independent scopes");
  network.activations = [];
  resources.forEach((mutationResources, index) => {
    const id = `r${index + 2}`;
    const scopeId = `scope:${id}` as const;
    network.regions.push({ ...network.regions[0]!, id, key: id, parentId: "r1", edge: "partOf", lod: 1, scopeId, status: "actionable", domainPhase: "selected", mutationResources, activationIds: [] });
    network.activations.push({ id: `a${index + 2}`, capability: "implement", regionId: id, request: id, expectedDelta: id, contextRefs: [id], status: "queued", basisRevision: 0, mutationResources } as Activation);
  });
  return network;
};

describe("bundle mutation batching", () => {
  it("persists evidence-backed exclusions while aligned requirements remain partOf scopes", () => {
    const network = initialNetwork("implement A and B; report external C");
    network.activations[0]!.status = "running";
    const delta = SolutionDeltaSchema.parse({ region: {}, evidence: [], materialRequirements: [
      { key: "a", text: "Implement A", criterion: "A passes" },
      { key: "b", text: "Implement B", criterion: "B passes" },
    ], taskScopes: [
      { key: "a", objective: "Implement A", acceptanceCriteria: ["A passes"], requirementKeys: ["a"], mutationResources: ["src/a.ts"] },
      { key: "b", objective: "Implement B", acceptanceCriteria: ["B passes"], requirementKeys: ["b"], mutationResources: ["src/b.ts"] },
    ], taskDispositions: [{ key: "c", request: "Change external service C", disposition: "external", reason: "The service is outside this repository", evidenceRefs: ["task"] }] });
    validateSolutionDelta(state(network), "r1", "inspect", delta);
    const merged = mergeSolutionDelta(state(network), "a1", delta);
    expect(merged.regions.filter((region) => region.parentId === "r1").map((region) => region.edge)).toEqual(["partOf", "partOf"]);
    expect(merged.taskDispositions).toEqual([{ key: "c", request: "Change external service C", disposition: "external", reason: "The service is outside this repository", evidenceRefs: ["task"] }]);
  });

  it("forms deterministic maximal batches from scope and resource overlap", () => {
    const independent = mutationNetwork([["src/a.ts"], ["src/b.ts"], ["src/a.ts"]]);
    expect(selectActivationBatch(independent, 3).map((activation) => activation.id)).toEqual(["a2", "a3"]);
    expect(selectActivationBatch(independent, 3).map((activation) => activation.id)).toEqual(["a2", "a3"]);
  });

  it("serializes shared mutation resources and keeps independent reads concurrent", () => {
    const network = mutationNetwork([["src/shared.ts"], ["src/shared.ts"]]);
    expect(selectActivationBatch(network, 4).map((activation) => activation.id)).toEqual(["a2"]);
    network.activations.forEach((activation) => { activation.capability = "inspect"; });
    network.regions.slice(1).forEach((region) => { region.status = "unformed"; region.domainPhase = "inspecting"; });
    expect(selectActivationBatch(network, 4).map((activation) => activation.id)).toEqual(["a2", "a3"]);
  });

  it("proves overlap with counters and a barrier instead of sibling completion order", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const run = async () => { active++; entered++; maxActive = Math.max(maxActive, active); if (entered === 2) release(); await barrier; active--; };
    await Promise.all([run(), run()]);
    expect(maxActive).toBe(2);
    expect(active).toBe(0);
  });
});
