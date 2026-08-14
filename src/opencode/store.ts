import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
  mermaid?: string;
  topology?: { nodes: string[]; edges: Array<{ source: string; target: string }> };
}

export interface StoredRun {
  runId: string;
  rootSessionId: string;
  userMessageId: string;
  graph: string;
  task: string;
  directory: string;
  worktree: string;
  status: "running" | "interrupted" | "completed" | "failed";
}

export interface SessionGraphState {
  enabled: boolean;
}

function stateBase(stateHome?: string): string {
  return stateHome || process.env.OPENCODE_LANGGRAPH_STATE_HOME || process.env.NEOLIT_STATE_HOME || path.join(os.homedir(), ".local", "state");
}

function root(stateHome?: string): string {
  return path.join(stateBase(stateHome), "opencode-langgraph");
}

function legacyRoot(stateHome?: string): string {
  return path.join(stateBase(stateHome), "neolit", "opencode");
}

export function eventFile(rootSessionId: string): string {
  return path.join(root(), `${rootSessionId}.jsonl`);
}

export function appendPluginEvent(event: PluginRunEvent): void {
  fs.mkdirSync(root(), { recursive: true });
  fs.appendFileSync(eventFile(event.rootSessionId), `${JSON.stringify(event)}\n`);
}

export function appendProjectEvent(worktree: string, event: PluginRunEvent): void {
  const directory = path.join(worktree, ".neolit", ".runtime");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, `${event.rootSessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

export function readLatestLocalEvents(worktree: string): PluginRunEvent[] {
  const directory = path.join(worktree, ".neolit", ".runtime");
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name));
  const latest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!latest) return [];
  return fs.readFileSync(latest, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PluginRunEvent]; } catch { return []; }
  });
}

export function readPluginEvents(rootSessionId: string, stateHome?: string): PluginRunEvent[] {
  const primary = path.join(root(stateHome), `${rootSessionId}.jsonl`);
  const legacy = path.join(legacyRoot(stateHome), `${rootSessionId}.jsonl`);
  const file = fs.existsSync(primary) ? primary : legacy;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PluginRunEvent]; } catch { return []; }
  });
}

function sessionStateFile(sessionId: string, stateHome?: string): string {
  return path.join(root(stateHome), "sessions", `${sessionId}.json`);
}

export function readSessionGraphEnabled(sessionId: string, stateHome?: string): boolean {
  try {
    const primary = sessionStateFile(sessionId, stateHome);
    const legacy = path.join(legacyRoot(stateHome), "sessions", `${sessionId}.json`);
    const state = JSON.parse(fs.readFileSync(fs.existsSync(primary) ? primary : legacy, "utf8")) as SessionGraphState;
    return state.enabled === true;
  } catch {
    return false;
  }
}

export function writeSessionGraphEnabled(sessionId: string, enabled: boolean, stateHome?: string): void {
  const file = sessionStateFile(sessionId, stateHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled } satisfies SessionGraphState));
}

export function writeStoredRun(run: StoredRun): void {
  fs.mkdirSync(path.join(root(), "runs"), { recursive: true });
  fs.writeFileSync(path.join(root(), "runs", `${run.runId}.json`), JSON.stringify(run, null, 2));
}

export function readStoredRun(runId: string): StoredRun {
  const primary = path.join(root(), "runs", `${runId}.json`);
  const legacy = path.join(legacyRoot(), "runs", `${runId}.json`);
  return JSON.parse(fs.readFileSync(fs.existsSync(primary) ? primary : legacy, "utf8")) as StoredRun;
}

export function readLatestStoredRun(rootSessionId: string): StoredRun | undefined {
  let latest: { modified: number; run: StoredRun } | undefined;
  for (const directory of [path.join(root(), "runs"), path.join(legacyRoot(), "runs")]) {
    if (!fs.existsSync(directory)) continue;
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
  }
  return latest?.run;
}

export function readLatestProjectEvents(worktree: string, stateHome?: string): PluginRunEvent[] {
  const matches: Array<{ modified: number; run: StoredRun }> = [];
  for (const directory of [path.join(root(stateHome), "runs"), path.join(legacyRoot(stateHome), "runs")]) {
    if (!fs.existsSync(directory)) continue;
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
  }
  for (const candidate of matches.sort((a, b) => b.modified - a.modified)) {
    const events = readPluginEvents(candidate.run.rootSessionId, stateHome);
    if (events.length) return events;
  }
  return [];
}
