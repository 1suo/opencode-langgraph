import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { CandidateSelectionOutputSchema, DomainChallengeOutputSchema, DomainGenerationOutputSchema, SolutionDeltaSchema, type Activation, type SolutionLodState, type SolutionNetwork, type SynthesisOutput } from "../src/core/solution-lod/types.js";
import { domainFingerprint, initialNetwork, mergeSolutionDelta, mergeSynthesisOutput, propagateNetwork, reopenRegion, selectActivationBatch, validateImplementationOutput, validateSolutionDelta, validateSynthesisOutput } from "../src/core/solution-lod/reducer.js";
import { solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { OpenCodeRuntimeError } from "../src/opencode/runtime.js";

const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const state = (network: SolutionNetwork): SolutionLodState => ({ stateVersion: 8, runId: "v8", originalTask: "change it", conversationContext: "", directory: "/r", worktree: "/r", phase: "", activeBatch: [], network, results: [], usage, callsUsed: 0, startedAt: 0, result: "" });

function activation(network: SolutionNetwork, operation: Activation["operation"]): Activation {
  const region = network.regions[0]!;
  const item: Activation = { id: `a${network.nextActivationId++}`, capability: "synthesize", operation, domainFingerprint: region.domainFingerprint, regionId: region.id, request: operation!, expectedDelta: `${operation}:${region.domainFingerprint}`, contextRefs: [region.id], status: "running", basisRevision: network.revision };
  network.activations.push(item);
  region.activationIds.push(item.id);
  return item;
}

function generated(): SolutionNetwork {
  const network = initialNetwork("change it");
  network.activations[0]!.status = "completed";
  network.regions[0]!.status = "superposed";
  network.regions[0]!.domainPhase = "ungenerated";
  const act = activation(network, "generate-domain");
  return mergeSynthesisOutput(state(network), act.id, {
    operation: "generate-domain", evidence: [], variables: [], constraints: [],
    candidates: [
      { key: "native", proposition: "Use the native repository pattern", evidenceRefs: [], stances: [] },
      { key: "adapter", proposition: "Add a local adapter", evidenceRefs: [], stances: [] },
    ],
  });
}

function acceptDomain(network: SolutionNetwork): SolutionNetwork {
  const act = activation(network, "challenge-domain");
  return mergeSynthesisOutput(state(network), act.id, { operation: "challenge-domain", verdict: "accept", domainFingerprint: network.regions[0]!.domainFingerprint!, viableCandidateIds: ["r1:native", "r1:adapter"] });
}

describe("solution LOD state v8 lifecycle", () => {
  it("uses strict disjoint operation schemas and bounded generation", () => {
    expect(() => DomainGenerationOutputSchema.parse({ operation: "generate-domain", evidence: [], variables: [], candidates: [{ key: "x", proposition: "x", evidenceRefs: [], stances: [] }], constraints: [], selectedCandidateId: "x" })).toThrow();
    expect(() => DomainGenerationOutputSchema.parse({ operation: "generate-domain", evidence: [], variables: [], candidates: Array.from({ length: 8 }, (_, index) => ({ key: `x${index}`, proposition: `x${index}`, evidenceRefs: [], stances: [] })), constraints: [] })).toThrow();
    expect(() => DomainChallengeOutputSchema.parse({ operation: "challenge-domain", verdict: "accept", domainFingerprint: "f", viableCandidateIds: ["x"], candidate: { key: "y", proposition: "y", evidenceRefs: [], stances: [] } })).toThrow();
    expect(() => CandidateSelectionOutputSchema.parse({ operation: "select-candidate", domainFingerprint: "f", basis: "only-viable", comparisons: [], hardConstraints: [] })).toThrow();
  });

  it("requires exact challenge coverage and gates authored and singleton selection", () => {
    let network = generated();
    const region = network.regions[0]!;
    const challenge = activation(network, "challenge-domain");
    expect(() => validateSynthesisOutput(state(network), challenge, { operation: "challenge-domain", verdict: "accept", domainFingerprint: region.domainFingerprint!, viableCandidateIds: ["r1:native"] })).toThrow(/every and only/);

    network.evidence.push({ id: "e1", text: "adapter is incompatible", source: "src/x.ts:1", kind: "repository", status: "confirmed", fingerprint: "e1" });
    network.constraints.push({ id: "c1", kind: "refutes", subject: "e1", target: "r1:adapter", reason: "incompatible", sourceActivationId: challenge.id, sourceKind: "repo-evidence", evidenceRefs: ["e1"] });
    region.constraintIds.push("c1");
    network = propagateNetwork(network);
    expect(network.candidates.find((item) => item.id === "r1:adapter")?.status).toBe("eliminated");
    expect(network.regions[0]!.selectedCandidateIds).toEqual([]);
    expect(network.candidates.find((item) => item.id === "r1:native")?.status).toBe("possible");
  });

  it("rejects model-authored selection and never resurrects a cleared pre-accept choice", () => {
    let network = generated();
    const act = activation(network, "challenge-domain");
    const delta = SolutionDeltaSchema.parse({ region: {}, evidence: [], candidates: [{ key: "native", proposition: "Use the native repository pattern", outcome: "selected", evidenceRefs: [], stances: [] }], constraints: [], select: ["native"], activations: [] });
    expect(() => validateSolutionDelta(state(network), "r1", "synthesize", delta)).toThrow(/only by the select-candidate operation/);
    network = mergeSolutionDelta(state(network), act.id, delta);
    expect(network.candidates.find((item) => item.id === "r1:native")?.declaredStatus).toBe("possible");
    network = acceptDomain(network);
    expect(network.regions[0]!.selectedCandidateIds).toEqual([]);
    expect(network.candidates.find((item) => item.id === "r1:native")?.status).toBe("possible");
  });

  it("merges one counterexample, invalidates acceptance, and accepts only the enlarged fingerprint", () => {
    let network = generated();
    const before = network.regions[0]!.domainFingerprint;
    const act = activation(network, "challenge-domain");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "challenge-domain", verdict: "counterexample", domainFingerprint: before!, candidate: { key: "config", proposition: "Use configuration only", evidenceRefs: [], stances: [] }, reason: "material missing family", evidenceRefs: [] });
    expect(network.regions[0]!.cegarRound).toBe(1);
    expect(network.regions[0]!.acceptedFingerprint).toBeNull();
    expect(network.regions[0]!.domainPhase).toBe("challenging");
    expect(network.regions[0]!.domainFingerprint).not.toBe(before);
    expect(network.regions[0]!.candidateIds).toHaveLength(3);
  });

  it("selects by deterministic tiers only after acceptance and keeps preferences soft", () => {
    let network = acceptDomain(generated());
    const region = network.regions[0]!;
    expect(region.acceptedFingerprint).toBe(region.domainFingerprint);
    const act = activation(network, "select-candidate");
    const output: SynthesisOutput = {
      operation: "select-candidate", domainFingerprint: region.domainFingerprint!, basis: "lexicographic", selectedCandidateId: "r1:native", hardConstraints: [],
      comparisons: [
        { candidateId: "r1:native", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "preferred", irreversibleRisk: "neutral", evidenceRefs: [] },
        { candidateId: "r1:adapter", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] },
      ],
    };
    network = mergeSynthesisOutput(state(network), act.id, output);
    expect(network.regions[0]!.selectedCandidateIds).toEqual(["r1:native"]);
    expect(network.constraints).toEqual([]);
    expect(network.candidates.find((item) => item.id === "r1:adapter")?.eliminationReasons).toContain("a different non-equivalent approach was chosen");
  });

  it("invalidates only when local fingerprint input changes", () => {
    let network = acceptDomain(generated());
    const accepted = network.regions[0]!.acceptedFingerprint;
    network.evidence.push({ id: "unrelated", text: "other", source: "other:1", kind: "repository", status: "confirmed", fingerprint: "other" });
    network = propagateNetwork(network);
    expect(network.regions[0]!.acceptedFingerprint).toBe(accepted);
    network.candidates.find((item) => item.id === "r1:native")!.proposition = "Use a changed native pattern";
    network = propagateNetwork(network);
    expect(network.regions[0]!.acceptedFingerprint).toBeNull();
    expect(domainFingerprint(network, "r1")).toBe(network.regions[0]!.domainFingerprint);
  });

  it("blocks bounded counterexample and repeated no-progress cycles with exact reasons", () => {
    let network = generated();
    network.regions[0]!.cegarRound = 2;
    let act = activation(network, "challenge-domain");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "challenge-domain", verdict: "counterexample", domainFingerprint: network.regions[0]!.domainFingerprint!, candidate: { key: "third", proposition: "A concrete third family", evidenceRefs: [], stances: [] }, reason: "missing", evidenceRefs: [] });
    expect(network.regions[0]!.blockedReason).toContain("unresolved counterexample A concrete third family");
    expect(network.regions[0]!.blockedReason).toContain('"key":"third"');
    expect(network.regions[0]!.blockedReason).toContain('"reason":"missing"');

    network = acceptDomain(generated());
    const tie = () => ({ operation: "select-candidate" as const, domainFingerprint: network.regions[0]!.domainFingerprint!, basis: "needs-fact" as const, comparisons: [
      { candidateId: "r1:native", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
      { candidateId: "r1:adapter", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
    ], hardConstraints: [], inspectionRequest: { request: "Which pattern is already used?", expectedDelta: "pattern", contextRefs: [] } });
    act = activation(network, "select-candidate");
    network = mergeSynthesisOutput(state(network), act.id, tie());
    act = activation(network, "select-candidate");
    network = mergeSynthesisOutput(state(network), act.id, tie());
    expect(network.regions[0]!.domainPhase).toBe("blocked");
    expect(network.regions[0]!.blockedReason).toContain("two identical comparison cycles");
  });

  it("rejects counterexample ID collisions and blocks a repair beyond seven candidates", () => {
    let network = generated();
    let act = activation(network, "challenge-domain");
    expect(() => validateSynthesisOutput(state(network), act, { operation: "challenge-domain", verdict: "counterexample", domainFingerprint: network.regions[0]!.domainFingerprint!, candidate: { key: "native", proposition: "A distinct proposition under an occupied ID", evidenceRefs: [], stances: [] }, reason: "collision", evidenceRefs: [] })).toThrow(/genuinely new candidate ID/);
    for (let index = 0; index < 5; index++) {
      const id = `r1:extra-${index}`;
      network.candidates.push({ id, regionId: "r1", key: `extra-${index}`, proposition: `Extra family ${index}`, status: "possible", declaredStatus: "possible", evidenceIds: [], declaredEvidenceIds: [], eliminationReasons: [], declaredEliminationReasons: [], stances: [], createdRevision: 1, sourceActivationId: act.id });
      network.regions[0]!.candidateIds.push(id);
    }
    network = propagateNetwork(network);
    act = activation(network, "challenge-domain");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "challenge-domain", verdict: "counterexample", domainFingerprint: network.regions[0]!.domainFingerprint!, candidate: { key: "eighth", proposition: "An eighth concrete family", evidenceRefs: [], stances: [] }, reason: "still missing", evidenceRefs: [] });
    expect(network.regions[0]!.candidateIds).toHaveLength(7);
    expect(network.regions[0]!.blockedReason).toContain("seven-candidate domain bound exceeded");
  });

  it("canonicalizes needs-fact cycles and resets them on changed requests and reopen", () => {
    let network = acceptDomain(generated());
    const comparisons = [
      { candidateId: "r1:native", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
      { candidateId: "r1:adapter", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
    ];
    let act = activation(network, "select-candidate");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "select-candidate", domainFingerprint: network.regions[0]!.domainFingerprint!, basis: "needs-fact", comparisons, hardConstraints: [], inspectionRequest: { request: "Which pattern is used?", expectedDelta: "pattern", contextRefs: ["task", "r1"] } });
    act = activation(network, "select-candidate");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "select-candidate", domainFingerprint: network.regions[0]!.domainFingerprint!, basis: "needs-fact", comparisons: [...comparisons].reverse(), hardConstraints: [], inspectionRequest: { request: " Which pattern is used? ", expectedDelta: "pattern", contextRefs: ["r1", "task"] } });
    expect(network.regions[0]!.domainPhase).toBe("blocked");

    network = reopenRegion(network, "r1", "new repair cycle");
    expect(network.regions[0]!.noProgressCount).toBe(0);
    expect(network.regions[0]!.noProgressFingerprint).toBeNull();
  });

  it("accepts only cited hard elimination rules and validates needs-fact context references", () => {
    const network = acceptDomain(generated());
    network.evidence.push({ id: "e1", text: "Repository fact", source: "src/x.ts:1", kind: "repository", status: "confirmed", fingerprint: "e1" });
    const act = activation(network, "select-candidate");
    const base = { operation: "select-candidate" as const, domainFingerprint: network.regions[0]!.domainFingerprint!, basis: "hard-constraint" as const, comparisons: [
      { candidateId: "r1:native", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
      { candidateId: "r1:adapter", userPreference: "neutral" as const, repositoryCompatibility: "neutral" as const, changeScope: "neutral" as const, irreversibleRisk: "neutral" as const, evidenceRefs: [] },
    ] };
    expect(() => validateSynthesisOutput(state(network), act, { ...base, hardConstraints: [{ kind: "supports", subject: "e1", target: "r1:native", reason: "soft", evidenceRefs: ["e1"], sourceKind: "repo-evidence" }] })).toThrow(/hard elimination rule/);
    expect(() => validateSynthesisOutput(state(network), act, { ...base, hardConstraints: [{ kind: "requires", subject: "r1:native", target: "r1:adapter", reason: "uncited", evidenceRefs: [], sourceKind: "model-inference" }] })).toThrow(/cited confirmed evidence/);
    expect(() => validateSynthesisOutput(state(network), act, { ...base, basis: "needs-fact", hardConstraints: [], inspectionRequest: { request: "Inspect", expectedDelta: "fact", contextRefs: ["invented"] } })).toThrow(/unknown context reference/);
  });

  it("treats equivalent selected candidates as one implementation family", () => {
    let network = generated();
    network.constraints.push({ id: "c1", kind: "equivalent", subject: "r1:native", target: "r1:adapter", reason: "interchangeable", sourceActivationId: "a1", sourceKind: "model-inference", evidenceRefs: [] });
    network.regions[0]!.constraintIds.push("c1");
    network = propagateNetwork(network);
    network = acceptDomain(network);
    const act = activation(network, "select-candidate");
    network = mergeSynthesisOutput(state(network), act.id, { operation: "select-candidate", domainFingerprint: network.regions[0]!.domainFingerprint!, basis: "lexicographic", selectedCandidateId: "r1:native", hardConstraints: [], comparisons: [
      { candidateId: "r1:native", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "preferred", irreversibleRisk: "neutral", evidenceRefs: [] },
      { candidateId: "r1:adapter", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] },
    ] });
    network.regions[0]!.certifiedLeaf = { criterionIds: [], implementationScope: "Apply the interchangeable implementation", evidenceRefs: [] };
    expect(network.regions[0]!.selectedCandidateIds).toEqual(["r1:native", "r1:adapter"]);
    expect(() => validateImplementationOutput(state(network), "r1", { status: "completed", summary: "done", changedFiles: ["src/x.ts"], checks: [{ name: "check", passed: true, evidence: "passed" }], activations: [] })).not.toThrow();
  });

  it("supersedes stale local synthesis and purges descendants on fingerprint invalidation", () => {
    let network = acceptDomain(generated());
    const queued = activation(network, "select-candidate");
    queued.status = "queued";
    network.regions.push({ id: "r9", key: "stale", parentId: "r1", parentCandidateId: "r1:native", edge: "partOf", lod: 1, objective: "stale child", delivery: "change", allowedVariables: [], acceptanceCriteria: ["done"], coveredCriteria: [0], status: "unformed", reopens: 0, reopenFingerprint: null, candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [], scopeId: "scope:r9", criterionIds: ["criterion:r9:0"], domainPhase: "inspecting", domainFingerprint: null, acceptedFingerprint: null, cegarRound: 0, challengeVerdict: null, noProgressFingerprint: null, noProgressCount: 0 });
    network.candidates.find((item) => item.id === "r1:native")!.stances.push({ variableId: "missing", relation: "prefers", valueLabel: "x" });
    network = propagateNetwork(network);
    expect(network.regions.some((item) => item.id === "r9")).toBe(false);
    expect(network.regions[0]!.acceptedFingerprint).toBeNull();
    expect(network.activations.find((item) => item.id === queued.id)?.status).toBe("superseded");
    expect(selectActivationBatch(network, 1)).toEqual([]);
  });

  it("frames independent root tasks as exclusively owned typed AND scopes", () => {
    const network = initialNetwork("change A and answer B");
    network.activations[0]!.status = "running";
    const delta = SolutionDeltaSchema.parse({ region: {}, evidence: [], candidates: [], constraints: [], select: [], activations: [], taskScopes: [
      { key: "change-a", objective: "Change A", delivery: "change", allowedVariables: ["implementation"], acceptanceCriteria: ["A passes"] },
      { key: "answer-b", objective: "Answer B", delivery: "answer", allowedVariables: [], acceptanceCriteria: ["B is sourced"] },
    ] });
    validateSolutionDelta(state(network), "r1", "inspect", delta);
    const merged = mergeSolutionDelta(state(network), "a1", delta);
    const children = merged.regions.filter((item) => item.parentId === "r1");
    expect(children.map((item) => item.edge)).toEqual(["partOf", "partOf"]);
    expect(new Set(children.map((item) => item.scopeId)).size).toBe(2);
    expect(children.map((item) => item.coveredCriteria)).toEqual([[0], [1]]);
    expect(children.every((item) => item.domainPhase === "inspecting" && item.candidateIds.length === 0)).toBe(true);
  });

  it("runs inspect through all three synthesis operations, certified implementation, and verification", async () => {
    const calls: string[] = [];
    const runtime = { call: async (input: any) => {
      calls.push(input.node);
      const network = input.state.network as SolutionNetwork;
      const region = network.regions[0]!;
      if (input.node === "inspect:r1") return { text: "", structured: { region: { acceptanceCriteria: ["criterion done"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] } };
      if (input.node === "generate-domain:r1") return { text: "", structured: { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: [
        { key: "native", proposition: "Use native code", evidenceRefs: [], stances: [] },
        { key: "adapter", proposition: "Add an adapter", evidenceRefs: [], stances: [] },
      ] } };
      if (input.node === "challenge-domain:r1") return { text: "", structured: { operation: "challenge-domain", verdict: "accept", domainFingerprint: region.domainFingerprint, viableCandidateIds: [...region.candidateIds] } };
      if (input.node === "select-candidate:r1") return { text: "", structured: { operation: "select-candidate", domainFingerprint: region.domainFingerprint, basis: "lexicographic", selectedCandidateId: "r1:native", hardConstraints: [], comparisons: [
        { candidateId: "r1:native", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "preferred", irreversibleRisk: "neutral", evidenceRefs: [] },
        { candidateId: "r1:adapter", userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] },
      ] } };
      if (input.node === "refine:r1") return { text: "", structured: { evidence: [], children: [], certifiedLeaf: { implementationScope: "one bounded source edit", evidenceRefs: [] }, activations: [] } };
      if (input.node === "implement:r1") return { text: "", structured: { status: "already-satisfied", summary: "already satisfied", changedFiles: [], checks: [{ name: "focused", passed: true, evidence: "criterion done" }], activations: [] } };
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "verified", findings: [], checks: [{ name: "criterion done", passed: true, evidence: "criterion done observed" }], completionEvidence: { implementation: "already satisfied after inspection", directTest: "focused check passed", correctnessReview: "reviewed criterion", releaseGate: "full checks passed", changedFiles: [], focusedTests: ["focused"], fullChecks: ["full"] }, activations: [] } };
      throw new Error(`unexpected call ${input.node}`);
    } };
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const result = await configured.graph.invoke(configured.initial({ task: "change it", directory: "/r", worktree: "/r", runId: "v8-e2e" }), { recursionLimit: 64, configurable: { thread_id: "v8-e2e", langgraphOpenCodeRuntime: runtime } });
    expect(calls).toEqual(["inspect:r1", "generate-domain:r1", "challenge-domain:r1", "select-candidate:r1", "refine:r1", "implement:r1", "verify:r1"]);
    expect(configured.progress?.(result as SolutionLodState)?.phase).toBe("completed");
    expect(configured.result?.(result as SolutionLodState)).toContain("Implemented and verified");
  });

  it("preserves structured runtime failure diagnostics in activation task records", async () => {
    const connector = solutionLodGraph({ agents: { inspect: "i", synthesize: "s", refine: "r", implement: "m", verify: "v", present: "p" }, checkpointer: new MemorySaver() });
    const runtime = { call: async () => { throw new OpenCodeRuntimeError("transport", "connection lost", { sessionId: "session-1", usage: { ...usage, turns: 1, input: 4 }, tools: [{ tool: "read", status: "completed" }], progressText: "read src/x.ts", retryable: true }); } };
    let failure: SolutionLodState["results"][number] | undefined;
    for await (const value of await connector.graph.stream(connector.initial({ task: "change it", conversationContext: "", directory: "/r", worktree: "/r", runId: "diagnostics" }), { configurable: { thread_id: "diagnostics", langgraphOpenCodeRuntime: runtime }, streamMode: "values", recursionLimit: 40 })) {
      const current = value as SolutionLodState;
      if (current.results?.length) failure = current.results[0];
    }
    expect(failure).toMatchObject({ failureKind: "transport", sessionId: "session-1", retryable: true, progressText: "read src/x.ts", usage: { turns: 1, input: 4 }, tools: [{ tool: "read", status: "completed" }] });
  });
});
