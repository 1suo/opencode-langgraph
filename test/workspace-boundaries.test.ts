import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { changedFileDiscrepancies, solutionLodGraph } from "../src/core/solution-lod/graph.js";
import type { SolutionLodState, SolutionNetwork } from "../src/core/solution-lod/types.js";
import { prepareVerifierWorkspace, releaseVerifierWorkspace } from "../src/opencode/verifier-workspace.js";

const roots: string[] = [];
const agents = { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" };

afterEach(async () => {
  delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("workspace boundaries", () => {
  it("preserves Git context while isolating verifier worktree and index mutations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-git-source-")); const state = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-git-state-")); roots.push(root, state);
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(root, ["init", "-q"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(root, "renamed.txt"), "base\n"); fs.writeFileSync(path.join(root, "staged.txt"), "base\n");
    git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]);
    fs.renameSync(path.join(root, "renamed.txt"), path.join(root, "moved.txt")); fs.writeFileSync(path.join(root, "staged.txt"), "staged\n"); git(root, ["add", "-A"]);
    fs.writeFileSync(path.join(root, "staged.txt"), "unstaged\n"); fs.writeFileSync(path.join(root, "untracked.txt"), "source\n");
    const sourceIndex = git(root, ["rev-parse", "--git-path", "index"]).trim();
    const beforeIndex = fs.readFileSync(path.resolve(root, sourceIndex));
    const beforeStatus = git(root, ["status", "--porcelain=v1"]);
    const workspace = await prepareVerifierWorkspace("git-isolation", root);

    expect(git(workspace, ["rev-parse", "HEAD"])).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(git(workspace, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(git(workspace, ["diff", "--cached", "--name-status", "-M"])).toContain("R100\trenamed.txt\tmoved.txt");
    expect(git(workspace, ["diff", "HEAD", "--", "staged.txt"])).toContain("unstaged");

    fs.writeFileSync(path.join(workspace, "staged.txt"), "verifier\n"); fs.writeFileSync(path.join(workspace, "verifier-only.txt"), "new\n");
    git(workspace, ["add", "-A"]); git(workspace, ["commit", "-qm", "verifier"]);
    expect(fs.readFileSync(path.join(root, "staged.txt"), "utf8")).toBe("unstaged\n");
    expect(fs.existsSync(path.join(root, "verifier-only.txt"))).toBe(false);
    expect(fs.readFileSync(path.resolve(root, sourceIndex))).toEqual(beforeIndex);
    expect(git(root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    await releaseVerifierWorkspace("git-isolation");
  });

  it("measures non-Git mutations and records exact model discrepancies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-boundary-")); roots.push(root);
    fs.writeFileSync(path.join(root, "existing.txt"), "before");
    const runtime = { call: async (input: any) => {
      const region = (input.state.network as SolutionNetwork).regions[0]!;
      if (input.node === "inspect:r1") return { structured: { region: { acceptanceCriteria: ["done"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] }, text: "" };
      if (input.node === "generate-domain:r1") return { structured: { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: [{ key: "a", proposition: "A", evidenceRefs: [], stances: [] }, { key: "b", proposition: "B", evidenceRefs: [], stances: [] }] }, text: "" };
      if (input.node === "challenge-domain:r1") return { structured: { operation: "challenge-domain", verdict: "accept", domainFingerprint: region.domainFingerprint, viableCandidateIds: [...region.candidateIds] }, text: "" };
      if (input.node === "select-candidate:r1") return { structured: { operation: "select-candidate", domainFingerprint: region.domainFingerprint, basis: "lexicographic", selectedCandidateId: "r1:a", hardConstraints: [], comparisons: region.candidateIds.map((candidateId) => ({ candidateId, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: candidateId === "r1:a" ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) }, text: "" };
      if (input.node === "refine:r1") return { structured: { evidence: [], children: [], certifiedLeaf: { implementationScope: "edit", criterionIds: ["criterion:scope:r1:0"], evidenceRefs: [], mutationResources: ["target.txt"], checks: [{ criterionId: "criterion:scope:r1:0", commandOrObservation: "run focused test" }] }, activations: [] }, text: "" };
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(root, "existing.txt"), "after"); fs.writeFileSync(path.join(root, "added.txt"), "new"); return { structured: { status: "completed", summary: "done", changedFiles: ["existing.txt", "reported-only.txt"], checks: [], activations: [] }, text: "" }; }
      return { structured: { verdict: "pass", summary: "ok", findings: [], checks: [], activations: [] }, text: "" };
    } };
    const connector = solutionLodGraph({ agents, checkpointer: new MemorySaver() });
    for await (const value of await connector.graph.stream(connector.initial({ task: "change", directory: root, worktree: root, runId: "non-git" }), { configurable: { thread_id: "non-git", langgraphOpenCodeRuntime: runtime }, streamMode: "values", recursionLimit: 64 })) {
      const current = value as SolutionLodState;
      if (current.phase === "completed") break;
    }
    expect(changedFileDiscrepancies(["existing.txt", "reported-only.txt"], ["added.txt", "existing.txt"])).toEqual({ reportedOnly: ["reported-only.txt"], measuredOnly: ["added.txt"] });
  });

  it("runs verifier in a disposable directory/worktree and retains only its copy's mutations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-source-")); const state = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-state-")); roots.push(root, state);
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    fs.writeFileSync(path.join(root, "source.txt"), "source");
    let verifierPath = ""; let retained: string[] = [];
    const runtime = { call: async (input: any) => {
      const region = (input.state.network as SolutionNetwork).regions[0]!;
      if (input.node === "inspect:r1") return { structured: { region: { acceptanceCriteria: ["done"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] }, text: "" };
      if (input.node === "generate-domain:r1") return { structured: { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: [{ key: "a", proposition: "A", evidenceRefs: [], stances: [] }, { key: "b", proposition: "B", evidenceRefs: [], stances: [] }] }, text: "" };
      if (input.node === "challenge-domain:r1") return { structured: { operation: "challenge-domain", verdict: "accept", domainFingerprint: region.domainFingerprint, viableCandidateIds: [...region.candidateIds] }, text: "" };
      if (input.node === "select-candidate:r1") return { structured: { operation: "select-candidate", domainFingerprint: region.domainFingerprint, basis: "lexicographic", selectedCandidateId: "r1:a", hardConstraints: [], comparisons: region.candidateIds.map((candidateId) => ({ candidateId, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: candidateId === "r1:a" ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) }, text: "" };
      if (input.node === "refine:r1") return { structured: { evidence: [], children: [], certifiedLeaf: { implementationScope: "none", criterionIds: ["criterion:scope:r1:0"], evidenceRefs: [], mutationResources: ["target.txt"], checks: [{ criterionId: "criterion:scope:r1:0", commandOrObservation: "run focused test" }] }, activations: [] }, text: "" };
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(root, "implemented.txt"), "done"); return { structured: { status: "completed", summary: "done", changedFiles: ["implemented.txt"], checks: [], activations: [] }, text: "" }; }
      expect(input.directory).toBe(input.worktree); expect(input.worktree).not.toBe(root); verifierPath = input.worktree;
      fs.writeFileSync(path.join(input.worktree, "source.txt"), "verifier"); fs.writeFileSync(path.join(input.worktree, "retained.txt"), "retained");
      retained = [fs.readFileSync(path.join(input.worktree, "source.txt"), "utf8"), fs.readFileSync(path.join(input.worktree, "retained.txt"), "utf8")];
      return { structured: { verdict: "pass", summary: "ok", findings: [], checks: [], activations: [] }, text: "" };
    } };
    const connector = solutionLodGraph({ agents, checkpointer: new MemorySaver() });
    const retainVerifier = async () => {};
    for await (const value of await connector.graph.stream(connector.initial({ task: "verify", directory: root, worktree: root, runId: "verifier" }), { configurable: { thread_id: "verifier", langgraphOpenCodeRuntime: runtime, langgraphPrepareVerifierWorkspace: prepareVerifierWorkspace, langgraphReleaseVerifierWorkspace: retainVerifier }, streamMode: "values", recursionLimit: 64 })) {
      const current = value as SolutionLodState;
      if (current.phase === "completed") break;
    }
    expect(fs.readFileSync(path.join(root, "source.txt"), "utf8")).toBe("source");
    expect(fs.existsSync(path.join(root, "retained.txt"))).toBe(false);
    if (verifierPath) expect(retained).toEqual(["verifier", "retained"]);
    await releaseVerifierWorkspace("verifier");
  });
});
