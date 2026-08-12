import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-demo-"));
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "neolit-demo", type: "module", scripts: { test: "node --test" } }, null, 2));
fs.writeFileSync(path.join(repo, "src", "math.js"), "export const add = (a, b) => a + b;\n");
fs.writeFileSync(path.join(repo, "neolit.config.json"), JSON.stringify({ validation: [{ name: "tests", command: "npm", args: ["test"] }] }, null, 2));
spawnSync("git", ["init", "-q"], { cwd: repo });
spawnSync("git", ["config", "user.email", "demo@neolit.local"], { cwd: repo });
spawnSync("git", ["config", "user.name", "Neolit Demo"], { cwd: repo });
spawnSync("git", ["add", "."], { cwd: repo });
spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
console.log(`Demo repository: ${repo}`);
const cli = path.resolve("dist/src/cli.js");
const result = spawnSync(process.execPath, [cli, "run", "Implement a clamp(value, min, max) feature in src/math.js with Node tests; preserve add", "--repo", repo, "--no-tui"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
