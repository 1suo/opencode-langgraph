import { describe, expect, it } from "vitest";
import { initialNetwork } from "../src/core/solution-lod/reducer.js";
import type { SolutionLodState } from "../src/core/solution-lod/types.js";
import { checkConvergence, checkEvidenceDedup, checkSolverWorkflows } from "../scripts/verify-real-runs.js";

const state = (network: ReturnType<typeof initialNetwork>): SolutionLodState => ({ stateVersion: 8, runId: "verify", originalTask: "change", conversationContext: "", directory: "/r", worktree: "/r", phase: "completed", activeBatch: [], network, results: [], usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 1, startedAt: 0, result: "done" });

describe("real-run verification checks", () => {
  it("accepts a clean network and flags a canonical evidence duplicate", () => {
    const clean = initialNetwork("change");
    clean.regions[0]!.evidenceIds = ["e1"];
    clean.evidence.push({ id: "e1", text: "Native transport is configured", source: "src/config.ts:4", kind: "repository", status: "confirmed", fingerprint: "a" });
    expect(checkEvidenceDedup(clean).every((check) => check.ok)).toBe(true);

    const dirty = initialNetwork("change");
    dirty.evidence.push(
      { id: "e1", text: "Native transport is configured", source: "src/config.ts:4", kind: "repository", status: "confirmed", fingerprint: "a" },
      { id: "e2", text: "native TRANSPORT  is configured!", source: "SRC/config.ts:4 ", kind: "repository", status: "confirmed", fingerprint: "b" },
    );
    dirty.regions[0]!.evidenceIds = ["e1", "e2"];
    const dedupChecks = checkEvidenceDedup(dirty);
    expect(dedupChecks.find((check) => check.name.includes("canonical"))!.ok).toBe(false);
  });

  it("flags unfinished regions as non-terminal convergence", () => {
    const network = initialNetwork("change");
    const unfinished = checkConvergence(state(network), 1000).find((check) => check.name.includes("terminal"));
    expect(unfinished?.ok).toBe(false);
    network.regions[0]!.status = "verified";
    expect(checkConvergence(state(network), 1000).find((check) => check.name.includes("terminal"))?.ok).toBe(true);
  });

  it("validates solver workflow invariants on the initial network", () => {
    const results = checkSolverWorkflows(initialNetwork("change"));
    expect(results.every((check) => check.ok), JSON.stringify(results)).toBe(true);
    expect(results.map((check) => check.name)).toEqual(expect.arrayContaining([
      expect.stringContaining("acyclic"),
      expect.stringContaining("idempotent"),
      expect.stringContaining("fingerprints"),
    ]));
  });
});
