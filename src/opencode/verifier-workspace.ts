import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function workspaceRoot(runId: string): string {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const key = createHash("sha256").update(runId).digest("hex").slice(0, 24);
  return path.join(stateBase, "opencode-langgraph", "workspaces", key);
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
  await fs.promises.cp(source, target, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      const resolved = path.resolve(entry);
      return relative !== ".git" && !relative.startsWith(`.git${path.sep}`) && resolved !== resolvedTarget && !resolved.startsWith(`${resolvedTarget}${path.sep}`);
    },
  });
  return target;
}

export async function releaseVerifierWorkspace(runId: string): Promise<void> {
  await fs.promises.rm(workspaceRoot(runId), { recursive: true, force: true });
}
