import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RunEvents } from "./events.js";
import type { RunnerConfig } from "./types.js";

export interface RunAgentOptions {
  role: string;
  prompt: string;
  cwd: string;
  config: RunnerConfig;
  artifacts: string;
  events: RunEvents;
  schemaFile?: string;
}

function extractOpenCodeText(output: string): string {
  const pieces: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const part = value.part as Record<string, unknown> | undefined;
      if (typeof part?.text === "string") pieces.push(part.text);
      else if (typeof value.text === "string") pieces.push(value.text);
    } catch { /* raw output is handled below */ }
  }
  return pieces.length ? pieces.join("") : output;
}

export async function runAgent(options: RunAgentOptions): Promise<string> {
  const stamp = `${Date.now()}-${options.role.replace(/[^a-z0-9_-]/gi, "-")}`;
  const promptFile = path.join(options.artifacts, `${stamp}.prompt.txt`);
  const outputFile = path.join(options.artifacts, `${stamp}.output.txt`);
  fs.writeFileSync(promptFile, options.prompt);
  const invocationCwd = options.config.command === "opencode" ? fs.mkdtempSync(path.join(os.tmpdir(), "neolit-agent-")) : options.cwd;
  const args = [...options.config.args, "--model", options.config.model];
  if (options.schemaFile && options.config.command === "codex") args.push("--output-schema", options.schemaFile);
  if (options.config.command === "opencode") args.push("--dir", invocationCwd, options.prompt); else args.push("-");
  options.events.record({ type: "runner", node: options.role, status: "active", message: `${options.config.command} ${options.config.model}` });
  let output: string;
  try {
  output = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.config.command, args, { cwd: invocationCwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); options.events.record({ type: "log", node: options.role, message: String(chunk).trimEnd() }); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); options.events.record({ type: "log", node: options.role, message: String(chunk).trimEnd() }); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${options.config.command} exited ${code}: ${stderr.slice(-2000)}`)));
    child.stdin.end(options.config.command === "opencode" ? undefined : options.prompt);
  });
  } finally {
    if (invocationCwd !== options.cwd) fs.rmSync(invocationCwd, { recursive: true, force: true });
  }
  fs.writeFileSync(outputFile, output);
  options.events.record({ type: "runner", node: options.role, status: "completed", data: { promptFile, outputFile } });
  return options.config.command === "opencode" ? extractOpenCodeText(output) : output;
}

export function parseJsonResponse<T>(output: string): T {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  try { return JSON.parse(clean) as T; } catch { /* find fenced or embedded JSON */ }
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced) as T;
  const starts = [clean.indexOf("["), clean.indexOf("{")].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    for (let end = clean.length; end > start; end -= 1) {
      try { return JSON.parse(clean.slice(start, end)) as T; } catch { /* continue */ }
    }
  }
  throw new Error("Agent did not return valid JSON");
}
