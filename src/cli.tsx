#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createRuntime, initialState } from "./pipeline.js";
import { asciiGraph, graphData } from "./graph-view.js";
import { runTui } from "./tui.js";
import { createRunPaths, createWorktree, removeWorktree, stateRoot } from "./worktree.js";
import type { AuditEvent, RunPaths } from "./types.js";

interface Metadata { runId: string; task: string; repo: string; worktree: string; status: "running" | "complete" | "failed"; createdAt: string }

function pathsFor(runId: string): RunPaths {
  const root = path.join(stateRoot(), "runs", runId);
  return { root, audit: path.join(root, "audit.jsonl"), artifacts: path.join(root, "artifacts"), checkpoint: path.join(root, "checkpoints.sqlite"), patch: path.join(root, "result.patch") };
}

function writeMetadata(paths: RunPaths, metadata: Metadata): void { fs.writeFileSync(path.join(paths.root, "run.json"), JSON.stringify(metadata, null, 2)); }
function readMetadata(runId: string): Metadata { return JSON.parse(fs.readFileSync(path.join(stateRoot(), "runs", runId, "run.json"), "utf8")) as Metadata; }

async function start(task: string, repoInput: string, noTui: boolean, json: boolean): Promise<void> {
  const repo = fs.realpathSync(repoInput);
  const paths = createRunPaths();
  const runId = path.basename(paths.root);
  const worktree = createWorktree(repo, runId);
  const metadata: Metadata = { runId, task, repo, worktree, status: "running", createdAt: new Date().toISOString() };
  writeMetadata(paths, metadata);
  const runtime = createRuntime(repo, paths);
  runtime.events.record({ type: "run", status: "active", message: `Worktree: ${worktree}` });
  const execute = async () => {
    try {
      const result = await runtime.graph.invoke(initialState(runId, task, repo, worktree), { configurable: { thread_id: runId } });
      metadata.status = "complete";
      writeMetadata(paths, metadata);
      runtime.events.record({ type: "run", status: "completed", message: result.route === "exploratory" ? `Report: ${path.join(paths.artifacts, "report.md")}` : `Patch: ${paths.patch}` });
      removeWorktree(repo, worktree);
      metadata.worktree = "";
      writeMetadata(paths, metadata);
      return result;
    } catch (error) {
      metadata.status = "failed";
      writeMetadata(paths, metadata);
      throw error;
    }
  };
  if (!noTui && process.stdout.isTTY) {
    await runTui(runtime, execute);
    return;
  }
  try {
    const result = await execute();
    const output = { runId, route: result.route, patch: result.patch ? paths.patch : undefined, report: result.report ? path.join(paths.artifacts, "report.md") : undefined, validation: result.validation };
    process.stdout.write(json ? `${JSON.stringify(output)}\n` : `Run ${runId} complete\n${output.patch ? `Patch: ${output.patch}` : `Report: ${output.report}`}\n`);
  } catch (error) {
    process.stderr.write(`Run ${runId} failed; resume with: neolit resume ${runId}\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function hydrateAudit(runtime: ReturnType<typeof createRuntime>, auditFile: string): void {
  if (!fs.existsSync(auditFile)) return;
  for (const line of fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean)) {
    runtime.events.ingest(JSON.parse(line) as AuditEvent);
  }
}

const program = new Command().name("neolit").description("Progressive-cooling AI code generation").version("0.2.0");

program.command("run", { isDefault: true }).argument("<task>").option("--repo <path>", "target repository", process.cwd()).option("--no-tui").option("--json").action(async (task: string, options) => start(task, options.repo, options.tui === false, Boolean(options.json)));
program.command("resume").argument("<run-id>").option("--no-tui").action(async (runId: string, options) => {
  const metadata = readMetadata(runId);
  if (!metadata.worktree) throw new Error("Completed run has no worktree to resume");
  const paths = pathsFor(runId);
  const runtime = createRuntime(metadata.repo, paths);
  hydrateAudit(runtime, paths.audit);
  const execute = async () => {
    const result = await runtime.graph.invoke(null, { configurable: { thread_id: runId } });
    metadata.status = "complete";
    runtime.events.record({ type: "run", status: "completed", message: result.route === "exploratory" ? `Report: ${path.join(paths.artifacts, "report.md")}` : `Patch: ${paths.patch}` });
    removeWorktree(metadata.repo, metadata.worktree);
    metadata.worktree = "";
    writeMetadata(paths, metadata);
    return result;
  };
  if (options.tui !== false && process.stdout.isTTY) await runTui(runtime, execute); else await execute();
});
program.command("attach").argument("<run-id>").action(async (runId: string) => {
  const metadata = readMetadata(runId);
  const paths = pathsFor(runId);
  const runtime = createRuntime(metadata.repo, paths);
  hydrateAudit(runtime, paths.audit);
  let offset = fs.existsSync(paths.audit) ? fs.statSync(paths.audit).size : 0;
  const poll = setInterval(() => {
    if (!fs.existsSync(paths.audit)) return;
    const size = fs.statSync(paths.audit).size;
    if (size <= offset) return;
    const descriptor = fs.openSync(paths.audit, "r");
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    fs.closeSync(descriptor);
    offset = size;
    for (const line of buffer.toString("utf8").split("\n").filter(Boolean)) runtime.events.ingest(JSON.parse(line) as AuditEvent);
  }, 250);
  try { await runTui(runtime, undefined, metadata.status); } finally { clearInterval(poll); }
});
program.command("graph").option("--format <format>", "ascii, mermaid, or json", "ascii").option("--output <file>").action(async (options) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-graph-"));
  const paths: RunPaths = { root, audit: path.join(root, "audit.jsonl"), artifacts: path.join(root, "artifacts"), checkpoint: path.join(root, "checkpoints.sqlite"), patch: path.join(root, "result.patch") };
  fs.mkdirSync(paths.artifacts);
  try {
    const runtime = createRuntime(process.cwd(), paths);
    const drawable = await graphData(runtime.graph);
    const value = options.format === "json" ? JSON.stringify(drawable.toJSON(), null, 2) : options.format === "mermaid" ? drawable.drawMermaid() : await asciiGraph(runtime.graph);
    if (options.output) fs.writeFileSync(options.output, value); else process.stdout.write(`${value}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
await program.parseAsync();
