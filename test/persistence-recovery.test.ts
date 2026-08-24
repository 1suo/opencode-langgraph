import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DurableFileSaver } from "../src/core/durable-checkpointer.js";
import { initialNetwork, resetPrunedRegion } from "../src/core/solution-lod/reducer.js";
import { solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { applyPruneOverrides, buildHandoffSummary, classifyResumeReplay, plannedMutationResources, recordMutationBoundary, server, updateRunMetrics } from "../src/opencode/server.js";
import { classifyMutationRecovery, readStoredRun, reconcileRuns, updateStoredRun, writeStoredRun, type StoredRun } from "../src/opencode/store.js";
import { processIdentity, worktreeLeaseController } from "../src/opencode/worktree-lock.js";
import { workspaceFingerprint } from "../src/opencode/verifier-workspace.js";

const directories: string[] = [];
const priorStateHome = process.env.OPENCODE_LANGGRAPH_STATE_HOME;

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return { runId: "run", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: "/repo", worktree: "/repo", status: "running", ...overrides };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  if (priorStateHome === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
  else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorStateHome;
});

describe("persistence concurrency", () => {
  it("rejects a stale same-run write after a locked mutation", () => {
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = temporary("neolit-run-cas-");
    writeStoredRun(run());
    const first = updateStoredRun("run", (current) => ({ ...current, status: "paused" }));
    updateStoredRun("run", (current) => ({ ...current, status: "pruned" }));
    expect(() => writeStoredRun({ ...first, status: "cancelled" })).toThrow(/changed concurrently/);
    expect(readStoredRun("run")).toMatchObject({ revision: 2, status: "pruned" });
  });

  it("recovers a stored-run lock after PID reuse", () => {
    const state = temporary("neolit-run-reused-pid-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    writeStoredRun(run());
    const lock = path.join(state, "opencode-langgraph", "runs", "run.json.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, processStart: "different-process", token: "stale" }));
    expect(updateStoredRun("run", (current) => ({ ...current, status: "paused" })).status).toBe("paused");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("recovers a checkpoint lock left by a dead owner", async () => {
    const directory = temporary("neolit-checkpoint-cas-");
    const saver = new DurableFileSaver(directory);
    const thread = "thread";
    const file = path.join(directory, `${createHash("sha256").update(thread).digest("hex")}.json`);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2_147_483_647, token: "dead" }));
    const checkpoint = { v: 1, id: "checkpoint", ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [] };
    await saver.put({ configurable: { thread_id: thread } }, checkpoint, { source: "input", step: 0, parents: {} });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("recovers a checkpoint lock whose live PID belongs to a different process start", async () => {
    const directory = temporary("neolit-checkpoint-reused-pid-");
    const thread = "reused";
    const file = path.join(directory, `${createHash("sha256").update(thread).digest("hex")}.json`);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, processStart: "different-process", token: "stale" }));
    const checkpoint = { v: 1, id: "checkpoint", ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [] };
    await new DurableFileSaver(directory, 100).put({ configurable: { thread_id: thread } }, checkpoint, { source: "input", step: 0, parents: {} });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("times out instead of spinning on a genuinely live checkpoint owner", async () => {
    const directory = temporary("neolit-checkpoint-timeout-");
    const thread = "busy";
    const file = path.join(directory, `${createHash("sha256").update(thread).digest("hex")}.json`);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, processStart: processIdentity(process.pid), token: "live" }));
    const checkpoint = { v: 1, id: "checkpoint", ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [] };
    await expect(new DurableFileSaver(directory, 30).put({ configurable: { thread_id: thread } }, checkpoint, { source: "input", step: 0, parents: {} })).rejects.toThrow(/Timed out waiting for checkpoint lock/);
  });

  it("serializes writes from separate saver instances for one thread", async () => {
    const directory = temporary("neolit-checkpoint-concurrent-");
    const config = { configurable: { thread_id: "shared", checkpoint_ns: "", checkpoint_id: "checkpoint" } };
    await Promise.all([
      new DurableFileSaver(directory).putWrites(config, [["left", 1]], "task-left"),
      new DurableFileSaver(directory).putWrites(config, [["right", 2]], "task-right"),
    ]);
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8")) as { writes: Record<string, Record<string, unknown>> };
    expect(Object.keys(Object.values(snapshot.writes)[0])).toHaveLength(2);
  });

  it("adds a missing resume input write without writing checkpoint channels", async () => {
    const directory = temporary("neolit-checkpoint-resume-");
    const saver = new DurableFileSaver(directory);
    const config = { configurable: { thread_id: "resume" } };
    await saver.put(config, { v: 4, id: "checkpoint", ts: new Date().toISOString(), channel_values: { results: [{ activationId: "a1" }] }, channel_versions: {}, versions_seen: {} }, { source: "loop", step: 0, writes: {}, parents: [] });
    await saver.ensureInputWrite("resume");
    const tuple = await saver.getTuple(config);
    expect(tuple?.checkpoint.channel_values.results).toEqual([{ activationId: "a1" }]);
    expect(tuple?.pendingWrites).toEqual([["__input__", "__start__", null]]);
  });
});

describe("stale mutation recovery", () => {
  it("classifies unchanged workspace state as replay-safe and an observed pre-checkpoint mutation as review-required", () => {
    const state = temporary("neolit-recovery-state-");
    const project = temporary("neolit-recovery-project-");
    const safeProject = temporary("neolit-recovery-safe-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    fs.writeFileSync(path.join(project, "source.txt"), "before");
    fs.writeFileSync(path.join(safeProject, "source.txt"), "unchanged");
    const before = workspaceFingerprint(project);
    writeStoredRun(run({ runId: "safe", worktree: safeProject, hostPid: 2_147_483_647, mutation: { node: "implement:r1", phase: "active", before: workspaceFingerprint(safeProject), at: new Date().toISOString() } }));
    writeStoredRun(run({ runId: "review", worktree: project, hostPid: 2_147_483_647 }));
    recordMutationBoundary("review", project, "implement:r2", "active");
    fs.writeFileSync(path.join(project, "source.txt"), "after");
    recordMutationBoundary("review", project, "implement:r2", "completed");
    reconcileRuns();
    expect(readStoredRun("safe")).toMatchObject({ status: "interrupted", recovery: { kind: "replay-safe" } });
    expect(readStoredRun("review")).toMatchObject({ status: "interrupted", recovery: { kind: "review-required" } });
  });

  it("recovers a child process crash after mutation observation but before checkpoint", async () => {
    const state = temporary("neolit-child-crash-state-");
    const project = temporary("neolit-child-crash-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    fs.writeFileSync(path.join(project, "source.txt"), "before");
    writeStoredRun(run({ runId: "child-crash", worktree: project }));
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { recordMutationBoundary } from "./src/opencode/server.ts";
      import { updateStoredRun } from "./src/opencode/store.ts";
      import { processIdentity } from "./src/opencode/worktree-lock.ts";
      const runId = "child-crash";
      const worktree = ${JSON.stringify(project)};
      updateStoredRun(runId, current => ({ ...current, hostPid: process.pid, hostIdentity: processIdentity(process.pid), status: "running" }));
      recordMutationBoundary(runId, worktree, "implement:r1", "active");
      fs.writeFileSync(path.join(worktree, "source.txt"), "child mutation");
      recordMutationBoundary(runId, worktree, "implement:r1", "completed");
      process.exit(73);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: { ...process.env, OPENCODE_LANGGRAPH_STATE_HOME: state }, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(73);
    reconcileRuns();
    expect(readStoredRun("child-crash")).toMatchObject({ status: "interrupted", mutation: { phase: "observed" }, recovery: { kind: "review-required" } });
  });

  it("blocks resume after pausing during an active mutation that changed the workspace", async () => {
    const state = temporary("neolit-paused-mutation-state-");
    const project = temporary("neolit-paused-mutation-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    fs.writeFileSync(path.join(project, "source.txt"), "before");
    writeStoredRun(run({ checkpointVersion: 8, worktree: project }));
    recordMutationBoundary("run", project, "implement:r1", "active");
    fs.writeFileSync(path.join(project, "source.txt"), "side effect");
    updateStoredRun("run", (current) => ({ ...current, status: "paused" }));

    let clientCalls = 0;
    const hooks = await server({ client: new Proxy({}, { get() { clientCalls++; return undefined; } }), directory: project, worktree: project } as never);
    const execute = hooks.tool?.langgraph_resume.execute as (args: { runId: string }, context: never) => Promise<string>;
    const context = { sessionID: "root", directory: project, worktree: project, abort: new AbortController().signal } as never;
    await expect(execute({ runId: "run" }, context)).rejects.toThrow(/uncheckpointed workspace mutations/);
    expect(readStoredRun("run")).toMatchObject({ status: "paused", recovery: { kind: "review-required" }, mutation: { phase: "active" } });
    expect(clientCalls).toBe(0);
    expect(fs.existsSync(path.join(state, "opencode-langgraph", "locks"))).toBe(false);
  });

  it("pauses a live leased activation and blocks replay after its side effect", async () => {
    const state = temporary("neolit-live-pause-state-");
    const project = temporary("neolit-live-pause-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    fs.writeFileSync(path.join(project, "source.txt"), "before");
    const runId = "live-pause";
    writeStoredRun(run({ runId, checkpointVersion: 8, worktree: project, hostPid: process.pid, hostIdentity: processIdentity(process.pid) }));
    const checkpointer = new DurableFileSaver(path.join(state, "opencode-langgraph", "checkpoints"));
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer });
    await checkpointer.put(
      { configurable: { thread_id: runId } },
      { v: 4, id: "1ef5livepause000000000000000000", ts: new Date().toISOString(), channel_values: configured.initial({ task: "task", directory: project, worktree: project, runId }), channel_versions: {}, versions_seen: {} },
      { source: "loop", step: 0, writes: {}, parents: [] },
    );
    const lease = worktreeLeaseController(project, new AbortController().signal);
    await lease.acquire();
    recordMutationBoundary(runId, project, "implement:r1", "active");
    const activation = (async () => {
      while (readStoredRun(runId).status !== "pausing") await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(path.join(project, "source.txt"), "live side effect");
      recordMutationBoundary(runId, project, "implement:r1", "completed");
      updateStoredRun(runId, (current) => ({ ...current, status: "paused", recovery: classifyMutationRecovery(current) }));
      lease.release();
    })();
    const hooks = await server({ client: {}, directory: project, worktree: project } as never);
    const context = { sessionID: "root", directory: project, worktree: project, abort: new AbortController().signal } as never;
    const pause = hooks.tool?.langgraph_pause.execute as (args: { runId: string }, context: never) => Promise<string>;
    expect(JSON.parse(await pause({ runId }, context))).toMatchObject({ status: "paused" });
    await activation;
    const resume = hooks.tool?.langgraph_resume.execute as (args: { runId: string }, context: never) => Promise<string>;
    await expect(resume({ runId }, context)).rejects.toThrow(/uncheckpointed workspace mutations/);
    expect(readStoredRun(runId)).toMatchObject({ recovery: { kind: "review-required" }, operator: { lastOutcome: { kind: "review-required" } } });
  });
});

describe("operator policy", () => {
  it("warns before a planned mutation overlaps existing dirt and never commits or stashes", () => {
    const state = temporary("neolit-dirty-state-");
    const project = temporary("neolit-dirty-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    execFileSync("git", ["init", "-q"], { cwd: project });
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "target.ts"), "base\n");
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: project });
    fs.writeFileSync(path.join(project, "src", "target.ts"), "user dirt\n");
    writeStoredRun(run({ worktree: project }));
    const stateV8 = { plannedMutationResources: [{ path: "src/target.ts", access: "write" }] };
    expect(plannedMutationResources(stateV8, "implement:r1")).toEqual(["src/target.ts"]);
    const warning = recordMutationBoundary("run", project, "implement:r1", "active", stateV8);
    expect(warning).toMatchObject({ overlaps: ["src/target.ts"], plannedResources: ["src/target.ts"] });
    expect(warning?.policy).toMatch(/will not commit, stash, reset, or discard/);
    writeStoredRun(run({ runId: "fallback", worktree: project }));
    const fallback = recordMutationBoundary("fallback", project, "implement:r2", "active", {});
    expect(fallback).toMatchObject({ overlaps: ["src/target.ts"] });
    expect(fallback?.plannedResources).toBeUndefined();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" })).toContain("src/target.ts");
    expect(execFileSync("git", ["show", "HEAD:src/target.ts"], { cwd: project, encoding: "utf8" })).toBe("base\n");
  });

  it("blocks a manual mechanism switch and persists a recoverable handoff summary", async () => {
    const state = temporary("neolit-handoff-state-");
    const project = temporary("neolit-handoff-project-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    writeStoredRun(run({ worktree: project, hostPid: process.pid, hostIdentity: processIdentity(process.pid) }));
    const summary = buildHandoffSummary(run(), { phase: "implementing", network: {
      regions: [{ id: "r1", objective: "change", status: "implementing", scopeId: "scope:r1", selectedCandidateIds: ["c1"] }],
      candidates: [{ id: "c1", regionId: "r1", proposition: "Use native path" }], evidence: [{ id: "e1", text: "fact", source: "repo" }], artifacts: [{ id: "o1", content: "partial" }],
    } });
    expect(summary).toMatchObject({ phase: "implementing", selectedCandidates: [{ id: "c1" }], unfinishedRegions: [{ id: "r1" }] });
    const hooks = await server({ client: { session: { get: async () => ({ data: { id: "root", parentID: undefined } }) } }, directory: project, worktree: project } as never);
    const output = { message: { id: "message", sessionID: "root", role: "user", agent: "build", time: { created: Date.now() } }, parts: [{ id: "part", messageID: "message", sessionID: "root", type: "text", text: "Switch to manual execution" }] };
    await hooks["chat.message"]?.({ sessionID: "root", messageID: "message" }, output as never);
    expect(output.parts.at(-1)).toMatchObject({ synthetic: true });
    expect((output.parts.at(-1) as { text: string }).text).toMatch(/no handoff occurred/i);
    expect(readStoredRun("run")).toMatchObject({ status: "running", operator: { lastOutcome: { kind: "handoff-blocked" }, handoff: { outcomes: expect.arrayContaining([expect.stringMatching(/cancel explicitly/)]) } } });
    const cancel = hooks.tool?.langgraph_cancel.execute as (args: { runId: string }, context: never) => Promise<string>;
    const cancelled = JSON.parse(await cancel({ runId: "run" }, { sessionID: "root", directory: project, worktree: project } as never));
    expect(cancelled).toMatchObject({ status: "cancelled", outcomes: expect.arrayContaining([expect.stringMatching(/handoff summary/)]) });
    expect(readStoredRun("run")).toMatchObject({ status: "cancelled", operator: { lastOutcome: { kind: "cancelled" }, handoff: { summary: { runId: "run" } } } });
  });

  it("persists run-level telemetry exposed by graph state", () => {
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = temporary("neolit-metrics-state-");
    writeStoredRun(run());
    updateRunMetrics("run", { callsUsed: 4, usage: { turns: 2, input: 10, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, network: { activations: [{}, {}, {}], regions: [{ reopens: 2 }, { reopens: 1 }] } });
    expect(readStoredRun("run").metrics).toMatchObject({ callsUsed: 4, activations: 3, regions: 2, reopens: 3, usage: { turns: 2, cost: 0.02 } });
  });
});

describe("prune overrides", () => {
  it("regenerates deterministic criterion identities with acceptance criteria", () => {
    const network = initialNetwork("task");
    network.regions[0].acceptanceCriteria = ["old"];
    network.regions[0].criterionIds = ["criterion:stale"];
    const updated = applyPruneOverrides(network, "r1", { acceptanceCriteria: ["first", "second"] });
    expect(updated.regions[0].acceptanceCriteria).toEqual(["first", "second"]);
    expect(updated.regions[0].criterionIds).toEqual(["criterion:scope:r1:0", "criterion:scope:r1:1"]);
  });

  it("retires the target domain but preserves history and user overrides", () => {
    const network = initialNetwork("task");
    const region = network.regions[0];
    region.acceptanceCriteria = ["old"];
    region.criterionIds = ["criterion:old"];
    region.candidateIds = ["r1:old"];
    region.selectedCandidateIds = ["r1:old"];
    region.domainFingerprint = "domain";
    region.acceptedFingerprint = "domain";
    network.candidates.push({ id: "r1:old", key: "old", regionId: "r1", proposition: "old choice", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [] });
    network.artifacts.push({ id: "o1", regionId: "r1", kind: "note", summary: "historical output" });
    const reset = resetPrunedRegion(network, "r1");
    const updated = applyPruneOverrides(reset, "r1", { objective: "new goal", allowedVariables: ["explicit"], acceptanceCriteria: ["new criterion"] });
    expect(updated.regions[0]).toMatchObject({ objective: "new goal", allowedVariables: ["explicit"], acceptanceCriteria: ["new criterion"], criterionIds: ["criterion:scope:r1:0"], candidateIds: [], selectedCandidateIds: [], domainFingerprint: null, acceptedFingerprint: null, domainPhase: "ungenerated" });
    expect(updated.candidates[0]).toMatchObject({ id: "r1:old", historical: true });
    expect(updated.artifacts).toEqual(network.artifacts);
  });
});

describe("resume lifecycle", () => {
  it("classifies pause/prune as checkpoint replay and reacquires a fresh lease", async () => {
    const state = temporary("neolit-resume-lock-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    expect(classifyResumeReplay(run({ status: "paused" }))).toBe("checkpoint-replay");
    expect(classifyResumeReplay(run({ status: "pruned" }))).toBe("checkpoint-replay");
    expect(classifyResumeReplay(run({ status: "interrupted" }))).toBe("human-resume");
    expect(classifyResumeReplay(run({ status: "interrupted", recovery: { kind: "review-required", reason: "changed" } }))).toBe("review-required");

    const signal = new AbortController().signal;
    const initial = worktreeLeaseController("/repo", signal);
    await initial.acquire();
    initial.release();
    const resumed = worktreeLeaseController("/repo", signal);
    await resumed.acquire();
    resumed.release();
  });

  it("recovers an owner record after PID reuse", async () => {
    const state = temporary("neolit-reused-owner-");
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    const worktree = "/repo";
    const key = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    const lock = path.join(state, "opencode-langgraph", "locks", key);
    fs.mkdirSync(path.join(lock, "queue"), { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ ticket: "old", pid: process.pid, processStart: "different-process" }));
    const controller = worktreeLeaseController(worktree, new AbortController().signal);
    await controller.acquire();
    controller.release();
  });
});
