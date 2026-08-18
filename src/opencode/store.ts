import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { AgentPromptTrace, AgentUsage, GraphProgressSnapshot, SolutionRoleModelAssignments } from "../core/types.js";

export interface PluginRunEvent {
  at: string;
  runId: string;
  rootSessionId: string;
  userMessageId?: string;
  graph: string;
  node: string;
  status: string;
  agent: string;
  model: string;
  text?: string;
  state?: unknown;
  sessionId?: string;
  usage?: AgentUsage;
  prompt?: AgentPromptTrace;
  mermaid?: string;
  topology?: { nodes: string[]; edges: Array<{ source: string; target: string }> };
  progress?: GraphProgressSnapshot;
}

export interface StoredRun {
  checkpointVersion?: number;
  runId: string;
  rootSessionId: string;
  userMessageId: string;
  graph: string;
  task: string;
  directory: string;
  worktree: string;
  modelAssignments?: SolutionRoleModelAssignments;
  status: "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled" | "pruned";
}

export interface SessionGraphState {
  enabled: boolean;
  graph?: string;
  modelAssignments?: SolutionRoleModelAssignments;
}

function stateBase(stateHome?: string): string {
  return stateHome || process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
}

function root(stateHome?: string): string {
  return path.join(stateBase(stateHome), "opencode-langgraph");
}

export function eventFile(rootSessionId: string): string {
  return path.join(root(), `${rootSessionId}.jsonl`);
}

export function appendPluginEvent(event: PluginRunEvent): void {
  fs.mkdirSync(root(), { recursive: true });
  fs.appendFileSync(eventFile(event.rootSessionId), `${JSON.stringify(event)}\n`);
}

export function readPluginEvents(rootSessionId: string, stateHome?: string): PluginRunEvent[] {
  const file = path.join(root(stateHome), `${rootSessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PluginRunEvent]; } catch { return []; }
  });
}

function sessionStateFile(sessionId: string, stateHome?: string): string {
  return path.join(root(stateHome), "sessions", `${sessionId}.json`);
}

export function readSessionGraphEnabled(sessionId: string, stateHome?: string): boolean {
  return readSessionGraphState(sessionId, stateHome)?.enabled === true;
}

export function readSessionGraphName(sessionId: string, stateHome?: string): string | undefined {
  return readSessionGraphState(sessionId, stateHome)?.graph;
}

export function readSessionGraphState(sessionId: string, stateHome?: string): SessionGraphState | undefined {
  try {
    return JSON.parse(fs.readFileSync(sessionStateFile(sessionId, stateHome), "utf8")) as SessionGraphState;
  } catch {
    return;
  }
}

export function writeSessionGraphEnabled(sessionId: string, enabled: boolean, stateHome?: string): void {
  writeSessionGraphState(sessionId, { ...readSessionGraphState(sessionId, stateHome), enabled }, stateHome);
}

export function writeSessionGraphName(sessionId: string, graph: string, stateHome?: string): void {
  writeSessionGraphState(sessionId, { enabled: false, ...readSessionGraphState(sessionId, stateHome), graph }, stateHome);
}

export function writeSessionGraphModelAssignments(sessionId: string, modelAssignments: SolutionRoleModelAssignments, stateHome?: string): void {
  writeSessionGraphState(sessionId, { enabled: false, ...readSessionGraphState(sessionId, stateHome), modelAssignments }, stateHome);
}

export function writeSessionGraphState(sessionId: string, state: SessionGraphState, stateHome?: string): void {
  const file = sessionStateFile(sessionId, stateHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function homeStateFile(worktree: string, stateHome?: string): string {
  const id = createHash("sha256").update(path.resolve(worktree)).digest("hex");
  return path.join(root(stateHome), "home", `${id}.json`);
}

export function readHomeGraphState(worktree: string, stateHome?: string): SessionGraphState | undefined {
  try {
    return JSON.parse(fs.readFileSync(homeStateFile(worktree, stateHome), "utf8")) as SessionGraphState;
  } catch {
    return;
  }
}

export function writeHomeGraphState(worktree: string, state: SessionGraphState, stateHome?: string): void {
  const file = homeStateFile(worktree, stateHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

export function clearHomeGraphState(worktree: string, stateHome?: string): void {
  try { fs.unlinkSync(homeStateFile(worktree, stateHome)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function adoptHomeGraphState(sessionId: string, worktree: string, stateHome?: string): SessionGraphState | undefined {
  const existing = readSessionGraphState(sessionId, stateHome);
  if (existing) return existing;
  const pending = readHomeGraphState(worktree, stateHome);
  if (!pending) return;
  writeSessionGraphState(sessionId, pending, stateHome);
  clearHomeGraphState(worktree, stateHome);
  return pending;
}

export function writeStoredRun(run: StoredRun): void {
  fs.mkdirSync(path.join(root(), "runs"), { recursive: true });
  fs.writeFileSync(path.join(root(), "runs", `${run.runId}.json`), JSON.stringify(run, null, 2));
}

export function readStoredRun(runId: string): StoredRun {
  return JSON.parse(fs.readFileSync(path.join(root(), "runs", `${runId}.json`), "utf8")) as StoredRun;
}

export function readLatestStoredRun(rootSessionId: string): StoredRun | undefined {
  const directory = path.join(root(), "runs");
  if (!fs.existsSync(directory)) return;
  let latest: { modified: number; run: StoredRun } | undefined;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as StoredRun;
      if (run.rootSessionId !== rootSessionId) continue;
      const modified = fs.statSync(file).mtimeMs;
      if (!latest || modified > latest.modified) latest = { modified, run };
    } catch {
      // Ignore an incomplete or externally edited run file.
    }
  }
  return latest?.run;
}

export function listProjectRuns(worktree: string, stateHome?: string): StoredRun[] {
  const directory = path.join(root(stateHome), "runs");
  if (!fs.existsSync(directory)) return [];
  const runs: Array<{ modified: number; run: StoredRun }> = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as StoredRun;
      if (path.resolve(run.worktree) !== path.resolve(worktree)) continue;
      runs.push({ modified: fs.statSync(file).mtimeMs, run });
    } catch {
      // Ignore an incomplete or externally edited run file.
    }
  }
  return runs.sort((a, b) => b.modified - a.modified).map((item) => item.run);
}

export function readLatestProjectRun(worktree: string, stateHome?: string): StoredRun | undefined {
  const directory = path.join(root(stateHome), "runs");
  if (!fs.existsSync(directory)) return;
  let latest: { modified: number; run: StoredRun } | undefined;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as StoredRun;
      if (path.resolve(run.worktree) !== path.resolve(worktree)) continue;
      const modified = fs.statSync(file).mtimeMs;
      if (!latest || modified > latest.modified) latest = { modified, run };
    } catch {
      // Ignore an incomplete or externally edited run file.
    }
  }
  return latest?.run;
}

export function readLatestProjectEvents(worktree: string, stateHome?: string): PluginRunEvent[] {
  const directory = path.join(root(stateHome), "runs");
  if (!fs.existsSync(directory)) return [];
  const matches: Array<{ modified: number; run: StoredRun }> = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as StoredRun;
      const modified = fs.statSync(file).mtimeMs;
      if (path.resolve(run.worktree) !== path.resolve(worktree)) continue;
      matches.push({ modified, run });
    } catch {
      // Ignore an incomplete or externally edited run file.
    }
  }
  for (const candidate of matches.sort((a, b) => b.modified - a.modified)) {
    const events = readPluginEvents(candidate.run.rootSessionId, stateHome);
    if (events.length) return events;
  }
  return [];
}
