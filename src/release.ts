import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${capture ? `: ${result.stderr}` : ""}`);
  return result.stdout?.trim() ?? "";
}

export function release(): void {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
  if (run("git", ["branch", "--show-current"], true) !== "main") throw new Error("Release requires main branch");
  if (run("git", ["status", "--porcelain"], true)) throw new Error("Release requires a clean worktree");
  const tag = `v${pkg.version}`;
  if (!run("git", ["tag", "--list", tag], true)) throw new Error(`Create matching tag ${tag} before release`);
  run("npm", ["whoami"]);
  run("gh", ["auth", "status"]);
  run("npm", ["run", "check"]);
  run("npm", ["pack", "--dry-run"]);
  run("npm", ["publish"]);
  run("git", ["push", "origin", "main", "--follow-tags"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) release();
