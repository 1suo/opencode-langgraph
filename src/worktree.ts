import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RunPaths } from "./types.js";

function git(repo: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function assertRepository(repo: string): void {
  if (git(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error(`${repo} is not a git repository`);
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`Target repository must be clean before Neolit creates an isolated worktree: ${repo}\n${status}`);
}

export function stateRoot(): string {
  return process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "neolit") : path.join(os.homedir(), ".local", "state", "neolit");
}

export function createRunPaths(runId = randomUUID()): RunPaths {
  const root = path.join(stateRoot(), "runs", runId);
  const artifacts = path.join(root, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  return { root, artifacts, audit: path.join(root, "audit.jsonl"), checkpoint: path.join(root, "checkpoints.sqlite"), patch: path.join(root, "result.patch") };
}

export function createWorktree(repo: string, runId: string): string {
  assertRepository(repo);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-"));
  const worktree = path.join(parent, runId);
  git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
  return worktree;
}

export function resetWorktree(worktree: string): void {
  git(worktree, ["reset", "--hard", "HEAD"]);
  git(worktree, ["clean", "-fd"]);
}

export function snapshotTree(worktree: string): Map<string, Buffer> {
  const tracked = git(worktree, ["ls-files"]).split("\n").filter(Boolean);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"], true).split("\n").filter(Boolean);
  return new Map([...tracked, ...untracked].map((file) => [file, fs.readFileSync(path.join(worktree, file))]));
}

export function assertOnlyFilesChanged(worktree: string, before: Map<string, Buffer>, allowed: Set<string>): void {
  const after = snapshotTree(worktree);
  if (before.size !== after.size || [...before.keys()].some((file) => !after.has(file))) throw new Error("Hostile runner created or deleted files");
  for (const [file, content] of before) {
    if (!allowed.has(file) && !content.equals(after.get(file)!)) throw new Error(`Hostile runner changed undeclared file: ${file}`);
  }
}

export function makePatch(worktree: string, destination: string): string {
  const tracked = git(worktree, ["diff", "--binary", "HEAD"]);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"], true).split("\n").filter(Boolean);
  const additions = untracked.map((file) => git(worktree, ["diff", "--binary", "--no-index", "/dev/null", file], true)).join("\n");
  const patch = [tracked, additions].filter(Boolean).join("\n");
  fs.writeFileSync(destination, patch);
  return patch;
}

export function removeWorktree(repo: string, worktree: string): void {
  git(repo, ["worktree", "remove", "--force", worktree], true);
  fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
}
