import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { applyBatchRecords, initialNetwork } from "../src/core/solution-lod/reducer.js";
import type { ActivationTaskResult } from "../src/core/solution-lod/types.js";
import type { AgentRuntime } from "../src/core/types.js";
import { renderPlanTree } from "../src/opencode/tui.js";

const usage = { turns: 1, input: 10, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 0, cost: 0.25 };
const record = (overrides: Partial<ActivationTaskResult> = {}): ActivationTaskResult => ({ activationId: "a1", regionId: "r1", capability: "inspect", basisRevision: 0, startedAt: 20, finishedAt: 50, usage, outcome: "error", error: "test", networkDelta: null, promptChars: 120, validationFailures: ["bad"], retries: 2, ...overrides });

describe("run telemetry and limits", () => {
  it("durably aggregates activation telemetry after the result log clears", () => {
    const network = initialNetwork("task"); network.activations[0].queuedAt = 10; network.activations[0].status = "running";
    const applied = applyBatchRecords(network, [record()]).network;
    expect(applied.telemetry).toMatchObject({ activations: 1, retries: 2, promptChars: 120, projectedContextChars: 120, validationFailures: 1, queueMs: 10, operationCalls: { inspect: 1 }, usage });
    expect(applied.telemetry?.regions.r1).toMatchObject({ elapsedMs: 30, queueMs: 10, roleMs: { inspect: 30 } });
    expect(applyBatchRecords(applied, []).network.telemetry).toEqual(applied.telemetry);
  });

  it("counts deferred repairs without validation failures and records CEGAR diagnostics", () => {
    const network = initialNetwork("task");
    network.regions[0]!.noProgressFingerprint = "same-selection";
    const deferred = applyBatchRecords(network, [record({ outcome: "deferred", validationFailures: [], retries: 0 })]).network;
    expect(deferred.telemetry?.regions.r1).toMatchObject({ repairAttempts: 1, noProgressFingerprints: ["same-selection"] });

    const repaired = applyBatchRecords(deferred, [record({
      activationId: "a2",
      capability: "synthesize",
      operation: "challenge-domain",
      outcome: "applied",
      validationFailures: [],
      retries: 0,
      networkDelta: { kind: "synthesis", output: { operation: "challenge-domain", verdict: "counterexample", domainFingerprint: "domain", candidate: { key: "missing", proposition: "Missing family", evidenceRefs: [], stances: [] }, reason: "missing", evidenceRefs: [] } },
    })]).network;
    expect(repaired.telemetry?.counterexampleRepairs).toBe(1);
  });

  it("shows telemetry in progress rendering", () => {
    const network = initialNetwork("task"); network.telemetry!.retries = 2; network.telemetry!.reopens = 1; network.telemetry!.regionCount = 1; network.telemetry!.candidates = 3; network.telemetry!.promptChars = 99;
    const graph = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const state = { ...graph.initial({ task: "task", directory: ".", worktree: ".", runId: "r" }), network };
    const progress = graph.progress!(state);
    expect(renderPlanTree([{ at: "now", runId: "r", rootSessionId: "s", graph: "solution-lod", node: "n", status: "active", agent: "a", model: "m", progress }])).toContain("2 retries · 1 reopens · 1 regions · 3 candidates · 99 prompt chars");
  });

  it.each([
    ["elapsedMs", { maxElapsedMs: 1 }, { startedAt: 0 }],
    ["cost", { maxCost: 0.1 }, { usage: { ...usage } }],
    ["retries", { maxRetries: 2 }, { telemetry: { retries: 2 } }],
    ["reopens", { maxReopens: 1 }, { telemetry: { reopens: 1 } }],
  ] as const)("blocks on exact %s metric", async (metric, runLimits, change) => {
    const runtime: AgentRuntime = { call: async () => { throw new Error("must block before activation"); } };
    const graph = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, runLimits, checkpointer: new MemorySaver() });
    const initial = graph.initial({ task: "task", directory: ".", worktree: ".", runId: `limit-${metric}` });
    if ("startedAt" in change) initial.startedAt = change.startedAt;
    if ("usage" in change) initial.usage = change.usage;
    if ("telemetry" in change) Object.assign(initial.network.telemetry!, change.telemetry);
    const result = await graph.graph.invoke(initial, { recursionLimit: 3, configurable: { thread_id: `limit-${metric}`, langgraphOpenCodeRuntime: runtime } });
    expect(result.phase).toBe("blocked");
    expect(result.result).toContain(`metric=${metric}`);
    expect(result.result).toMatch(/used=.+ limit=/);
  });
});
