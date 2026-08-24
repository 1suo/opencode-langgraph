import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { AgentPromptTrace, AgentUsage, GraphProgressSnapshot, SolutionRoleModelAssignments, UsageStreamingEstimate } from "../core/types.js";
import type { SolutionTelemetry } from "../core/solution-lod/types.js";
import { processIdentity, processOwnerAlive } from "./worktree-lock.js";
import { workspaceFingerprint } from "./verifier-workspace.js";

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
  structured?: unknown;
  sessionId?: string;
  usage?: AgentUsage;
  streaming?: UsageStreamingEstimate;
  prompt?: AgentPromptTrace;
  mermaid?: string;
  topology?: { nodes: string[]; edges: Array<{ source: string; target: string }> };
  progress?: GraphProgressSnapshot;
}

export interface StoredRun {
  revision?: number;
  checkpointVersion?: number;
  runId: string;
  rootSessionId: string;
  userMessageId: string;
  graph: string;
  task: string;
  directory: string;
  worktree: string;
  modelAssignments?: SolutionRoleModelAssignments;
  hostPid?: number;
  hostIdentity?: string;
  mutation?: {
    node: string;
    phase: "active" | "observed" | "checkpointed";
    before: string;
    after?: string;
    at: string;
  };
  recovery?: { kind: "replay-safe" | "review-required"; reason: string };
  dirtyWarning?: {
    at: string;
    node: string;
    dirtyPaths: string[];
    plannedResources?: string[];
    overlaps: string[];
    policy: string;
    outcomes: string[];
  };
  operator?: {
    lastOutcome?: { at: string; kind: "paused" | "cancelled" | "review-required" | "handoff-blocked"; message: string };
    handoff?: { at: string; summary: unknown; outcomes: string[] };
  };
  metrics?: {
    startedAt: number;
    updatedAt: number;
    elapsedMs: number;
    callsUsed?: number;
    activations?: number;
    reopens?: number;
    regions?: number;
    usage?: AgentUsage;
    telemetry?: SolutionTelemetry;
  };
  status: "queued" | "running" | "pausing" | "paused" | "interrupted" | "completed" | "failed" | "cancelled" | "pruned";
}

export interface SessionGraphState {
  enabled: boolean;
  graph?: string;
  modelAssignments?: SolutionRoleModelAssignments;
}

export function classifyMutationRecovery(run: StoredRun): StoredRun["recovery"] | undefined {
  if (!run.mutation) return run.recovery;
  if (run.mutation.phase === "checkpointed") return;
  let unchanged = false;
  try { unchanged = run.mutation.before !== "unavailable" && workspaceFingerprint(run.worktree) === run.mutation.before; } catch { /* inaccessible workspaces require review */ }
  return {
    kind: unchanged ? "replay-safe" : "review-required",
    reason: unchanged ? "The incomplete mutation did not change the workspace." : "Workspace changes may have occurred before the mutation result reached a durable checkpoint.",
  };
}

function stateBase(stateHome?: string): string {
  return stateHome || process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
}

function root(stateHome?: string): string {
  return path.join(stateBase(stateHome), "opencode-langgraph");
}

function storedRunFile(runId: string, stateHome?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  return path.join(root(stateHome), "runs", `${runId}.json`);
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
  withRunLock(run.runId, undefined, () => {
    const file = storedRunFile(run.runId);
    let current: StoredRun | undefined;
    try { current = readStoredRun(run.runId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current?.revision !== undefined && run.revision !== current.revision) throw new Error(`Stored run ${run.runId} changed concurrently (expected revision ${String(run.revision)}, current ${current.revision})`);
    const written = current?.revision === undefined ? run : { ...run, revision: current.revision + 1 };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(written, null, 2));
    fs.renameSync(temporary, file);
  });
}

function withRunLock<T>(runId: string, stateHome: string | undefined, action: () => T): T {
  const file = storedRunFile(runId, stateHome);
  const lock = `${file}.lock`;
  const token = randomUUID();
  const processStart = processIdentity(process.pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, processStart, token }), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; processStart?: string };
        if (!processOwnerAlive(owner.pid ?? 0, owner.processStart)) { fs.unlinkSync(lock); continue; }
      } catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 1_000) fs.unlinkSync(lock); } catch { /* another writer owns or recovered it */ }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting to update run ${runId}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string };
      if (owner.token === token) fs.unlinkSync(lock);
    } catch { /* recovered or removed */ }
  }
}

/** Locked read-modify-write. The revision prevents callers from silently restoring stale fields. */
export function updateStoredRun(runId: string, update: (current: StoredRun) => StoredRun, stateHome?: string): StoredRun {
  return withRunLock(runId, stateHome, () => {
    const current = readStoredRun(runId, stateHome);
    const next = update(current);
    if (next.runId !== runId) throw new Error(`Cannot change stored run ID ${runId}`);
    const written = { ...next, revision: (current.revision ?? 0) + 1 };
    const file = storedRunFile(runId, stateHome);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(written, null, 2));
    fs.renameSync(temporary, file);
    return written;
  });
}

type ScannedRun = { modified: number; run: StoredRun };

function scanStoredRuns(stateHome?: string): ScannedRun[] {
  const directory = path.join(root(stateHome), "runs");
  if (!fs.existsSync(directory)) return [];
  const runs: ScannedRun[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try { runs.push({ modified: fs.statSync(file).mtimeMs, run: JSON.parse(fs.readFileSync(file, "utf8")) as StoredRun }); }
    catch { /* Ignore an incomplete or externally edited run file. */ }
  }
  return runs.sort((a, b) => b.modified - a.modified);
}

export function reconcileRuns(): void {
  for (const run of listAllRuns()) {
    if (run.status !== "running" && run.status !== "queued" && run.status !== "pausing") continue;
    if (run.hostPid !== undefined && processOwnerAlive(run.hostPid, run.hostIdentity)) continue;
    let recovered = false;
    const reconciled = updateStoredRun(run.runId, (current) => {
      if (!(["running", "queued", "pausing"] as StoredRun["status"][]).includes(current.status) || (current.hostPid !== undefined && processOwnerAlive(current.hostPid, current.hostIdentity))) return current;
      recovered = true;
      const recovery = classifyMutationRecovery(current);
      const now = Date.now();
      return { ...current, status: recovery ? "interrupted" : "failed", ...(recovery ? { recovery } : {}), ...(current.metrics ? { metrics: { ...current.metrics, updatedAt: now, elapsedMs: now - current.metrics.startedAt } } : {}) };
    });
    if (!recovered) continue;
    const recovery = reconciled.recovery;
    const status = reconciled.status;
    appendPluginEvent({
      at: new Date().toISOString(),
      runId: run.runId,
      rootSessionId: reconciled.rootSessionId,
      userMessageId: reconciled.userMessageId,
      graph: reconciled.graph,
      node: "__end__",
      status,
      agent: "langgraph",
      model: "langgraph",
      text: recovery ? recovery.reason : "Host process exited before the run finished",
    });
  }
}

export function readStoredRun(runId: string, stateHome?: string): StoredRun {
  return JSON.parse(fs.readFileSync(storedRunFile(runId, stateHome), "utf8")) as StoredRun;
}

export function readLatestStoredRun(rootSessionId: string): StoredRun | undefined {
  return scanStoredRuns().find(({ run }) => run.rootSessionId === rootSessionId)?.run;
}

export function listAllRuns(stateHome?: string): StoredRun[] {
  return scanStoredRuns(stateHome).map((item) => item.run);
}

/** Failed runs from one session within the recency window — the runaway-start guard's input. */
export function countRecentFailedRuns(sessionID: string, windowMs: number, stateHome?: string): number {
  const cutoff = Date.now() - windowMs;
  return scanStoredRuns(stateHome).filter(({ modified, run }) => modified >= cutoff && run.rootSessionId === sessionID && run.status === "failed").length;
}

export function listProjectRuns(worktree: string, stateHome?: string): StoredRun[] {
  const resolved = path.resolve(worktree);
  return scanStoredRuns(stateHome).filter(({ run }) => path.resolve(run.worktree) === resolved).map(({ run }) => run);
}

export function readLatestProjectRun(worktree: string, stateHome?: string): StoredRun | undefined {
  return listProjectRuns(worktree, stateHome)[0];
}

export function readLatestProjectEvents(worktree: string, stateHome?: string): PluginRunEvent[] {
  for (const run of listProjectRuns(worktree, stateHome)) {
    const events = readPluginEvents(run.rootSessionId, stateHome);
    if (events.length) return events;
  }
  return [];
}
