import { describe, expect, it } from "vitest";
import { completeImplementation, completeVerification, domainFingerprint, ensureRunnableWork, initialNetwork, validateImplementationOutput, validateVerificationOutput } from "../src/core/solution-lod/reducer.js";
import type { SolutionLodState, SolutionNetwork, VerificationOutput } from "../src/core/solution-lod/types.js";

const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const state = (network: SolutionNetwork, originalTask = "change it"): SolutionLodState => ({ stateVersion: 8, runId: "review", originalTask, conversationContext: "", directory: "/r", worktree: "/r", phase: "", activeBatch: [], network, results: [], usage, callsUsed: 0, startedAt: 0, result: "" });
const ready = () => {
  const network = initialNetwork("change it");
  const region = network.regions[0]!;
  region.status = "implemented";
  region.acceptanceCriteria = ["behavior works"];
  region.criterionIds = ["criterion:scope:r1:0"];
  region.certifiedLeaf = { criterionIds: [...region.criterionIds], implementationScope: "change src/x.ts", evidenceRefs: [] };
  region.candidateIds = ["r1:chosen"];
  region.selectedCandidateIds = ["r1:chosen"];
  network.candidates.push({ id: "r1:chosen", regionId: "r1", key: "chosen", proposition: "change it", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [] });
  region.domainFingerprint = "accepted";
  region.acceptedFingerprint = "accepted";
  network.activations.push({ id: "a2", capability: "verify", regionId: "r1", request: "verify", expectedDelta: "verify", contextRefs: ["r1"], status: "running", basisRevision: 0 });
  return network;
};
const pass = (overrides: Partial<VerificationOutput["completionEvidence"]> = {}): VerificationOutput => ({ verdict: "pass", summary: "verified", findings: [], checks: [{ name: "behavior works", passed: true, evidence: "behavior works in focused test" }], completionEvidence: { implementationOutcome: "changed", implementation: "measured implementation", directTest: "focused passed", correctnessReview: "reviewed before completion", releaseGate: "configured gates passed", changedFiles: ["src/x.ts"], focusedTests: ["focused test passed"], fullChecks: ["npm test passed", "tsc passed"], criterionIds: ["criterion:scope:r1:0"], inspectionEvidenceRefs: [], ...overrides }, activations: [] });

describe("change completion correctness review", () => {
  it("requires measured mutation, focused evidence, all criteria, release gates, and TODO disposition", () => {
    const network = ready();
    network.artifacts.push({ id: "x1", regionId: "r1", kind: "file", path: "src/x.ts", summary: "Changed src/x.ts", activationId: "a1" });
    network.regions[0]!.artifactIds = ["x1"];
    expect(() => validateVerificationOutput(state(network, "Implement TODO item"), "r1", pass())).toThrow(/TODO disposition/);
    const output = pass({ todoDisposition: "Removed the completed TODO entry" });
    expect(() => validateVerificationOutput(state(network, "Implement TODO item"), "r1", output)).not.toThrow();
    const completed = completeVerification(network, "a2", output);
    expect(completed.regions[0]!.status).toBe("verified");
  });

  it("accepts already-satisfied only with confirmed inspection evidence and every exact criterion", () => {
    const network = ready();
    network.evidence.push({ id: "e1", text: "behavior already exists", source: "src/x.ts:1", kind: "repository", fingerprint: "e1" });
    const output = pass({ implementationOutcome: "already-satisfied", implementation: "already satisfied", changedFiles: [], inspectionEvidenceRefs: ["e1"] });
    expect(() => validateVerificationOutput(state(network), "r1", output)).not.toThrow();
    expect(completeVerification(network, "a2", output).regions[0]!.status).toBe("verified");
    expect(() => validateVerificationOutput(state(network), "r1", pass({ implementationOutcome: "already-satisfied", changedFiles: [], inspectionEvidenceRefs: ["missing"] }))).toThrow(/confirmed inspection evidence/);
  });

  it("stores typed repair findings and unresolved high severity blocks terminality", () => {
    const network = ready();
    const finding = { regionId: "r1", criterionId: "criterion:scope:r1:0", severity: "high" as const, files: ["src/x.ts"], problem: "regression", regressionCriterion: "focused regression test passes", evidence: "focused test failed", repairRegionId: "r1" };
    const repaired = completeVerification(network, "a2", { verdict: "repair", summary: "repair", findings: [finding], checks: [], activations: [] });
    const artifact = repaired.artifacts.find((item) => item.findings?.length);
    expect(artifact?.findings?.[0]).toEqual(finding);
    repaired.regions[0]!.status = "verified";
    repaired.regions[0]!.domainPhase = "selected";
    repaired.activations.forEach((activation) => { activation.status = "completed"; });
    const terminal = ensureRunnableWork(repaired);
    expect(terminal.done).toBe(false);
    expect(terminal.blocked).toMatch(/high-severity/);
  });

  it("requires TODO disposition at implementation time", () => {
    const network = ready();
    const region = network.regions[0]!;
    region.status = "actionable";
    region.domainFingerprint = null;
    region.acceptedFingerprint = null;
    region.candidateIds = [];
    region.selectedCandidateIds = [];
    network.candidates = [];
    network.activations = [];
    region.certifiedLeaf = { criterionIds: [...region.criterionIds], implementationScope: "already present", evidenceRefs: [] };
    network.candidates.push({ id: "r1:chosen", regionId: "r1", key: "chosen", proposition: "already present", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [] });
    region.candidateIds = ["r1:chosen"];
    region.selectedCandidateIds = ["r1:chosen"];
    region.domainFingerprint = domainFingerprint(network, "r1");
    region.acceptedFingerprint = region.domainFingerprint;
    expect(() => validateImplementationOutput(state(network, "Implement TODO item"), "r1", { status: "already-satisfied", summary: "already satisfied", changedFiles: [], checks: [{ name: "focused", passed: true, evidence: "passed" }], activations: [] })).toThrow(/TODO disposition/);
    void completeImplementation;
  });
});
