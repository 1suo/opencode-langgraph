import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function workspaceRoot(runId: string): string {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const key = createHash("sha256").update(runId).digest("hex").slice(0, 24);
  return path.join(stateBase, "opencode-langgraph", "workspaces", key);
}

/** Content fingerprint used to classify recovery; Git metadata is intentionally excluded. */
export function workspaceFingerprint(worktree: string): string {
  const root = path.resolve(worktree);
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(file);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${fs.readlinkSync(file)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(fs.readFileSync(file));
        hash.update("\0");
      }
    }
  };
  try { visit(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hash.update("missing");
  }
  return hash.digest("hex");
}

export function workspaceDirtyPaths(worktree: string): string[] {
  try {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    const entries = raw.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C")) index++;
      files.push(entry.slice(3));
    }
    return [...new Set(files)].sort();
  } catch { return []; }
}

/** Dependency-free content snapshot for workspaces that are not Git repositories. */
export function workspaceSnapshot(worktree: string): Map<string, string> {
  const root = path.resolve(worktree); const result = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) result.set(relative, `link:${fs.readlinkSync(absolute)}`);
      else if (entry.isFile()) result.set(relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
    }
  };
  try { visit(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result;
}

export async function prepareVerifierWorkspace(runId: string, worktree: string, existing?: string): Promise<string> {
  if (existing && fs.existsSync(existing)) return existing;
  const source = path.resolve(worktree);
  if (source === path.parse(source).root || source === path.resolve(os.homedir())) throw new Error(`Refusing to mirror unsafe verifier worktree: ${source}`);
  const target = path.join(workspaceRoot(runId), "verifier");
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === source || resolvedTarget.startsWith(`${source}${path.sep}`)) throw new Error(`Verifier workspace must be outside its source worktree: ${source}`);
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  let gitRepository = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", source, target], { stdio: "ignore" });
    gitRepository = true;
  } catch {
    await fs.promises.rm(target, { recursive: true, force: true });
  }
  await fs.promises.cp(source, target, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      const resolved = path.resolve(entry);
      return relative !== ".git" && !relative.startsWith(`.git${path.sep}`) && resolved !== resolvedTarget && !resolved.startsWith(`${resolvedTarget}${path.sep}`);
    },
  });
  if (gitRepository) {
    const sourceIndex = execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: source, encoding: "utf8" }).trim();
    const targetIndex = execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: target, encoding: "utf8" }).trim();
    await fs.promises.copyFile(path.resolve(source, sourceIndex), path.resolve(target, targetIndex));
  }
  return target;
}

export async function releaseVerifierWorkspace(runId: string): Promise<void> {
  await fs.promises.rm(workspaceRoot(runId), { recursive: true, force: true });
}
