import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { FileContext, NeolitConfig } from "./types.js";

const ignored = [".git/", "node_modules/", "dist/", "coverage/", ".neolit/"];

export function accumulateContext(repo: string, task: string, config: NeolitConfig): FileContext[] {
  const result = spawnSync("rg", ["--files", "-g", "!node_modules", "-g", "!.git", "-g", "!dist"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) throw new Error(`Unable to enumerate repository: ${result.stderr}`);
  const terms = task.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  const files = result.stdout.split("\n").filter(Boolean).filter((file) => !ignored.some((prefix) => file.startsWith(prefix)));
  const ranked = files.map((file) => ({ file, score: terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 3 : 0), 0) })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const output: FileContext[] = [];
  let bytes = 0;
  for (const { file } of ranked) {
    if (output.length >= config.contextFiles || bytes >= config.contextBytes) break;
    const full = path.join(repo, file);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 100_000) continue;
    const content = fs.readFileSync(full, "utf8");
    bytes += Buffer.byteLength(content);
    output.push({ path: file, content });
  }
  return output;
}

export function formatContext(context: FileContext[]): string {
  return context.map((file) => `--- ${file.path}\n${file.content}`).join("\n\n");
}
