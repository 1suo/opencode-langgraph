import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { NeolitConfig, ValidationResult } from "./types.js";

export function safeRelativePath(worktree: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.includes("\0")) throw new Error(`Unsafe path: ${file}`);
  const resolved = path.resolve(worktree, file);
  const relative = path.relative(worktree, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.startsWith(".git")) throw new Error(`Path escapes worktree: ${file}`);
  return resolved;
}

export function runValidation(worktree: string, config: NeolitConfig): ValidationResult {
  const checks: ValidationResult["checks"] = [];
  const markers = spawnSync("rg", ["-n", "NEOLIT:GAP", "."], { cwd: worktree, encoding: "utf8" });
  checks.push({ name: "gap-markers-removed", ok: markers.status === 1, detail: markers.status === 0 ? markers.stdout.slice(0, 1000) : undefined });
  for (const check of config.validation) {
    const result = spawnSync(check.command, check.args, { cwd: worktree, encoding: "utf8", timeout: 300_000 });
    checks.push({ name: check.name, ok: result.status === 0, detail: result.status === 0 ? undefined : `${result.stdout}\n${result.stderr}`.slice(-4000) });
  }
  const changed = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: worktree, encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktree, encoding: "utf8" });
  checks.push({ name: "has-output", ok: Boolean(changed.stdout.trim() || untracked.stdout.trim()) });
  return { ok: checks.every((check) => check.ok), checks };
}

export function writeFiles(worktree: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const destination = safeRelativePath(worktree, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}
