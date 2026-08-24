import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { activationContextFingerprint, activationRecovery, applyBatchRecords, initialNetwork, queueActivation } from "../src/core/solution-lod/reducer.js";
import type { AgentCall } from "../src/core/types.js";

const usage = { turns: 1, input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function failed(network = initialNetwork("inspect")) {
  network.activations[0]!.status = "running";
  return applyBatchRecords(network, [{ activationId: "a1", regionId: "r1", capability: "inspect", basisRevision: 0, startedAt: 0, finishedAt: 1, usage, outcome: "error", error: "disconnected", networkDelta: null, failureKind: "transport", retryable: true, sessionId: "child-1", progressText: "read files", retries: 1, retryTrace: [{ kind: "transport", message: "disconnected", action: "fork", sessionId: "child-1" }] }]).network;
}

describe("activation continuation", () => {
  it("persists transport recovery identity and retry trace", () => {
    const activation = failed().activations[0]!;
    expect(activation.recovery).toEqual({ sessionId: "child-1", strategy: "fork", attempts: 1, failureKind: "transport", contextFingerprint: activationContextFingerprint(activation), retryTrace: [{ kind: "transport", message: "disconnected", action: "fork", sessionId: "child-1" }] });
  });

  it("survives a checkpoint and resumes the same activation context", async () => {
    const saver = new MemorySaver();
    const connector = solutionLodGraph({ agents: { inspect: "i", synthesize: "s", refine: "r", implement: "m", verify: "v", present: "p" }, checkpointer: saver });
    const prior = failed();
    const source = prior.activations[0]!;
    source.status = "queued";
    const network = prior;
    const resumed = source;
    expect(resumed.recovery).toMatchObject({ sessionId: "child-1", strategy: "fork", failureKind: "transport" });
    let call: AgentCall | undefined;
    const runtime = { call: async (input: AgentCall) => { call = input; return { text: "", structured: { region: { acceptanceCriteria: ["known"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] }, sessionId: "child-2" }; } };
    const state = { ...connector.initial({ task: "inspect", directory: "/r", worktree: "/r", runId: "resume" }), network };
    await connector.graph.invoke(state, { configurable: { thread_id: "resume", langgraphOpenCodeRuntime: runtime }, recursionLimit: 3 }).catch(() => {});
    expect(call?.session).toEqual({ strategy: "fork", sessionId: "child-1" });
  });

  it("refuses stale read context and independent activation reuse", () => {
    const network = failed();
    network.regions[0]!.objective = "changed context";
    const stale = queueActivation(network, "inspect", "r1", network.activations[0]!.request, network.activations[0]!.expectedDelta, []);
    expect(stale.activations.at(-1)!.recovery).toBeUndefined();
    const independent = queueActivation(failed(), "inspect", "r1", "another question", "different-delta", []);
    expect(independent.activations.at(-1)!.recovery).toBeUndefined();
  });

  it("always isolates a fresh challenge operation", () => {
    const source = failed().activations[0]!;
    expect(activationRecovery([source], "challenge-domain", source.idempotencyKey!, source.readRefs!)).toBeUndefined();
  });
});
