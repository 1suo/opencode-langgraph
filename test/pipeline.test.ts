import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, initialState } from "../src/pipeline.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import type { RunPaths } from "../src/types.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("pipeline integration", () => {
  it("executes the agent-free trivial route in an isolated worktree", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-repo-")); roots.push(repo);
    fs.writeFileSync(path.join(repo, "note.txt"), "hello\n");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@neolit.local"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Neolit Test"], { cwd: repo });
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-run-")); roots.push(runRoot);
    const paths: RunPaths = { root: runRoot, audit: path.join(runRoot, "audit.jsonl"), artifacts: path.join(runRoot, "artifacts"), checkpoint: path.join(runRoot, "checkpoints.sqlite"), patch: path.join(runRoot, "result.patch") };
    fs.mkdirSync(paths.artifacts);
    const worktree = createWorktree(repo, "run");
    try {
      const runtime = createRuntime(repo, paths);
      const result = await runtime.graph.invoke(initialState("run", "replace \"hello\" with \"world\" in note.txt", repo, worktree), { configurable: { thread_id: "run" } });
      expect(result.route).toBe("trivial");
      expect(result.validation.ok).toBe(true);
      expect(result.patch).toContain("world");
      expect(fs.readFileSync(path.join(repo, "note.txt"), "utf8")).toBe("hello\n");
    } finally { removeWorktree(repo, worktree); }
  });
});
