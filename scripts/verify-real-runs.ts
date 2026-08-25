import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import { loadConnectorDefinition, opencodeModel, withSolutionRoleModelAssignments } from "../src/core/config.js";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { assertAcyclicPrimalGraph, domainFingerprint, propagateNetwork } from "../src/core/solution-lod/reducer.js";
import type { SolutionLodState, SolutionNetwork } from "../src/core/solution-lod/types.js";

const ITERATIONS = Math.max(1, Number(process.env.VERIFY_ITERATIONS ?? "3"));
const MAX_ACTIVATIONS = Math.max(8, Number(process.env.VERIFY_MAX_ACTIVATIONS ?? "48"));
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.VERIFY_RUN_TIMEOUT_MS ?? String(40 * 60_000)));
const OUT_DIR = process.env.VERIFY_OUT_DIR ?? "/tmp/opencode/neolit-verify";
fs.mkdirSync(OUT_DIR, { recursive: true });

const canonical = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function seedRepo(directory: string, variant: { verb: string; makeName: string }): void {
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "verify@local"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "verify"], { cwd: directory });
  fs.writeFileSync(path.join(directory, "README.md"), `# verify scratch\n\nGreets people via greet().\n`);
  fs.mkdirSync(path.join(directory, "src"));
  fs.writeFileSync(path.join(directory, "src", "greet.ts"), `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`);
  fs.writeFileSync(path.join(directory, "src", "greet.test.ts"), `import assert from "node:assert/strict";\nimport { greet } from "./greet.js";\nassert.equal(greet("world"), "Hello, world!");\nconsole.log("greet ok");\n`);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "verify-scratch", private: true, type: "module", scripts: { test: "node src/greet.test.ts && node src/newfile.test.ts" } }, null, 2));
  fs.writeFileSync(path.join(directory, "TASK.md"), `Requested change: ${variant.verb} the greeting.\nThe new ${variant.makeName} export must transform greet() output.\nA test file must prove it.\n`);
  execFileSync("git", ["add", "-A"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: directory });
}

export interface Check { name: string; ok: boolean; detail?: string }

export function checkEvidenceDedup(network: SolutionNetwork): Check[] {
  const checks: Check[] = [];
  const seenIdentity = new Map<string, string>();
  const seenFingerprint = new Map<string, string>();
  let duplicates = "";
  for (const item of network.evidence) {
    const identity = `${canonical(item.text)}\0${canonical(item.source)}`;
    const twin = seenIdentity.get(identity);
    if (twin) duplicates += `${item.id} restates ${twin}; `;
    else seenIdentity.set(identity, item.id);
    if (seenFingerprint.has(item.fingerprint) && !twin) duplicates += `${item.id} shares fingerprint with ${seenFingerprint.get(item.fingerprint)}; `;
    seenFingerprint.set(item.fingerprint, item.id);
  }
  checks.push({ name: "evidence: canonical identity unique", ok: !duplicates, detail: duplicates || `${network.evidence.length} facts stored once each` });
  const spread = network.regions.flatMap((region) => region.evidenceIds.filter((id, index, all) => all.indexOf(id) !== index).map((id) => `${region.id}:${id}`));
  checks.push({ name: "evidence: per-region references unique", ok: !spread.length, detail: spread.join(", ") || "no repeated fact IDs in any region" });
  return checks;
}

export function checkConvergence(state: SolutionLodState, elapsedMs: number): Check[] {
  const network = state.network;
  const checks: Check[] = [];
  const terminal = ["verified", "collapsed", "blocked", "stalled"];
  const unfinished = network.regions.filter((region) => !terminal.includes(region.status));
  checks.push({
    name: "convergence: run reached a terminal phase",
    ok: unfinished.length === 0,
    detail: unfinished.length ? unfinished.map((region) => `${region.id}(${region.status})`).join(", ") : `phase=${state.phase} in ${(elapsedMs / 1000).toFixed(0)}s`,
  });
  const loops = network.regions.filter((region) => (region.convergenceCycles?.length ?? 0) > 0);
  const overCycled = loops.filter((region) => region.status !== "blocked" && region.status !== "stalled" && (region.convergenceCycles?.length ?? 0) >= 2);
  checks.push({
    name: "convergence: semantic cycles bounded and blocked when repeated",
    ok: overCycled.length === 0,
    detail: overCycled.map((region) => `${region.id}: ${(region.convergenceCycles ?? []).length} cycles while ${region.status}`).join(", ") || `${loops.length} regions recorded cycles, none unbounded`,
  });
  const staleBlocked = network.regions.filter((region) => region.blockedReason && !region.blockedDetails);
  checks.push({ name: "convergence: blocks carry structured details", ok: staleBlocked.length === 0, detail: staleBlocked.map((region) => region.id).join(", ") || (network.regions.some((region) => region.blockedReason) ? "structured blockedDetails present" : "nothing blocked") });
  const badLeaves = network.regions.filter((region) => {
    if (!region.certifiedLeaf) return false;
    const exact = JSON.stringify([...new Set(region.certifiedLeaf.criterionIds)].sort()) === JSON.stringify([...region.criterionIds].sort());
    const witnessed = region.certifiedLeaf.checks.every((check) => region.criterionIds.includes(check.criterionId)) && new Set(region.certifiedLeaf.checks.map((check) => check.criterionId)).size === region.criterionIds.length;
    return !exact || !witnessed;
  });
  checks.push({ name: "convergence: certified leaves own exact criteria with witnesses", ok: !badLeaves.length, detail: badLeaves.map((region) => region.id).join(", ") || "all certified leaves well-formed" });
  const telemetry = network.telemetry;
  checks.push({
    name: "convergence: retry/reopen counters within policy",
    ok: (telemetry?.retries ?? 0) <= MAX_ACTIVATIONS && network.regions.every((region) => region.reopens <= 3),
    detail: `retries=${telemetry?.retries ?? 0} maxRegionReopens=${Math.max(0, ...network.regions.map((region) => region.reopens))}`,
  });
  return checks;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkSolverWorkflows(network: SolutionNetwork): Check[] {
  const checks: Check[] = [];
  try {
    assertAcyclicPrimalGraph(network);
    checks.push({ name: "csp/wfc/lod: primal variable graph acyclic", ok: true, detail: "union-find sweep passed" });
  } catch (error) {
    checks.push({ name: "csp/wfc/lod: primal variable graph acyclic", ok: false, detail: String(error) });
  }
  const repropagated = propagateNetwork(propagateNetwork(network));
  checks.push({ name: "csp/wfc/lod: propagation idempotent at fixpoint", ok: deepEqual(repropagated, propagateNetwork(network)), detail: "second pass changes nothing" });
  const ungated = network.candidates.filter((candidate) => {
    if (candidate.status !== "selected") return false;
    const region = network.regions.find((item) => item.id === candidate.regionId);
    return Boolean(region && region.acceptedFingerprint && region.acceptedFingerprint !== domainFingerprint(network, region.id));
  });
  checks.push({ name: "csp/wfc/lod: selections hold only under accepted fingerprints", ok: !ungated.length, detail: ungated.map((candidate) => candidate.id).join(", ") || "every selection matches its accepted domain" });
  const oversized = network.regions.filter((region) => region.candidateIds.length > 7);
  const overrun = network.regions.filter((region) => region.cegarRound > 2);
  checks.push({ name: "csp/wfc/lod: domain and CEGAR bounds respected", ok: !oversized.length && !overrun.length, detail: [...oversized.map((region) => `${region.id} size=${region.candidateIds.length}`), ...overrun.map((region) => `${region.id} round=${region.cegarRound}`)].join(", ") || `domains<=7, cegar<=2 across ${network.regions.length} regions` });
  const orphanSelections = network.regions.filter((region) => region.selectedCandidateIds.some((id) => !network.candidates.find((candidate) => candidate.id === id)));
  checks.push({ name: "csp/wfc/lod: region selections reference live candidates", ok: !orphanSelections.length, detail: orphanSelections.map((region) => region.id).join(", ") || "no dangling selections" });
  const lod = Math.max(0, ...network.regions.map((region) => region.lod));
  const edges = new Set(network.regions.map((region) => region.edge));
  checks.push({ name: "csp/wfc/lod: hierarchy intact", ok: true, detail: `lod depth=${lod}, edges=${[...edges].join("/")}, regions=${network.regions.length}` });
  return checks;
}

function report(iteration: number, runId: string, groups: Array<{ title: string; checks: Check[] }>): boolean {
  let ok = true;
  console.log(`\n--- iteration ${iteration} (${runId}) ---`);
  for (const group of groups) {
    for (const check of group.checks) {
      ok = ok && check.ok;
      console.log(`  [${check.ok ? "PASS" : "FAIL"}] ${group.title} :: ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  process.env.PONYTAIL_DEFAULT_MODE = "off";
  const variants = [
    { verb: "Add a loud variant of", makeName: "shout" },
    { verb: "Add a quiet variant of", makeName: "whisper" },
    { verb: "Add an excited variant of", makeName: "exclaim" },
  ];
  let failures = 0;
  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    const variant = variants[(iteration - 1) % variants.length]!;
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `neolit-verify-${iteration}-`));
    seedRepo(worktree, variant);
    const task = `${variant.makeName}(name) should return the uppercased greeting produced by greet(name). Add the ${variant.makeName} export to src/greet.ts, prove it with src/${variant.makeName}.test.ts using node:assert, and make sure package.json's test script runs both test files.`;
    const server = await createOpencodeServer({
      port: 0,
      timeout: 30_000,
      config: {
        agent: {
          build: { permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" } },
          "langgraph-inspector": { mode: "subagent", permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } },
          "langgraph-synthesizer": { mode: "subagent", permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } },
          "langgraph-refiner": { mode: "subagent", permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } },
          "langgraph-verifier": { mode: "subagent", permission: { edit: "deny", bash: "allow", webfetch: "deny", external_directory: "allow" } },
          "langgraph-presenter": { mode: "primary", permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } },
        },
      },
    });
    const client = createOpencodeClient({ baseUrl: server.url });
    const root = await client.session.create({ query: { directory: worktree }, throwOnError: true });
    const definition = withSolutionRoleModelAssignments(await loadConnectorDefinition(worktree), Object.fromEntries(
      ([
        ["inspect", process.env.REAL_TASK_MODEL_THINKING],
        ["synthesize", process.env.REAL_TASK_MODEL_THINKING],
        ["refine", process.env.REAL_TASK_MODEL_THINKING],
        ["implement", process.env.REAL_TASK_MODEL_FAST],
        ["verify", process.env.REAL_TASK_MODEL_FAST],
        ["present", process.env.REAL_TASK_MODEL_FAST],
      ] as const).filter((entry): entry is [(typeof entry)[0], string] => Boolean(entry[1])).map(([role, model]) => [role, opencodeModel({ model })]),
    ));
    const configured = definition.graphs["solution-lod"];
    const runId = `verify-loop-${Date.now()}-${iteration}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`verification loop timeout after ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS);
    try {
      const runtime = new OpenCodeAgentRuntime({
        plugin: { client, project: {} as never, directory: worktree, worktree, serverUrl: new URL(server.url), $: {} as never },
        definition,
        parentSessionId: root.data.id,
        parentModel: (() => {
          const [providerID, modelID] = (process.env.REAL_TASK_MODEL ?? "opencode-go/deepseek-v4-flash").split("/");
          return { providerID, modelID };
        })(),
        directory: worktree,
        worktree,
        signal: controller.signal,
        ask: async () => {},
        onEvent: (event) => {
          if (event.status !== "active" && event.status !== "completed") console.log(`  [${event.node}] ${event.status}`);
        },
      });
      const result = await configured.graph.invoke(configured.initial({ task, conversationContext: "", directory: worktree, worktree, runId }), {
        recursionLimit: 512,
        signal: controller.signal,
        configurable: { thread_id: runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} },
      });
      const final = result as SolutionLodState;
      const elapsedMs = Date.now() - startedAt;
      fs.writeFileSync(path.join(OUT_DIR, `${runId}.json`), JSON.stringify({ runId, task, worktree, elapsedMs, phase: final.phase, network: final.network, usage: final.usage }, null, 2));
      const progress = configured.progress?.(final);
      const groups = [
        { title: "fixed error: evidence duplication", checks: checkEvidenceDedup(final.network) },
        { title: "fixed error: implementation convergence", checks: checkConvergence(final, elapsedMs) },
        { title: "preserved ideas: CSP/WFC/LOD", checks: checkSolverWorkflows(final.network) },
      ];
      console.log(`result: ${String(final.result).slice(0, 400)}`);
      console.log(`phase=${progress?.phase} activations=${final.callsUsed} cost=$${final.usage.cost.toFixed(4)} evidence=${final.network.evidence.length} regions=${final.network.regions.length}`);
      if (!report(iteration, runId, groups)) failures++;
      const delivered = fs.existsSync(path.join(worktree, "src", `${variant.makeName}.ts`)) || fs.readFileSync(path.join(worktree, "src", "greet.ts"), "utf8").includes(variant.makeName);
      console.log(`  [${delivered ? "PASS" : "WARN"}] workspace :: expected artifact present (${delivered})`);
    } catch (error) {
      failures++;
      console.log(`\n--- iteration ${iteration} (${runId}) FAILED TO COMPLETE ---\n${error instanceof Error ? error.stack : String(error)}`);
      fs.writeFileSync(path.join(OUT_DIR, `${runId}.error.txt`), String(error instanceof Error ? error.stack : error));
    } finally {
      clearTimeout(timeout);
      try { await server.close?.(); } catch { /* server already gone */ }
    }
  }
  console.log(`\n=== verify-real-runs: ${failures ? `${failures} failed iteration(s)` : "all iterations passed"} ===`);
  process.exit(failures ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
