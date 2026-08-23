import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import { loadConnectorDefinition, opencodeModel, withSolutionRoleModelAssignments } from "../src/core/config.js";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";

const task = process.argv[2] ?? (process.env.REAL_TASK_RESUME_RUN_ID ? "(resumed run)" : undefined);
const worktree = process.argv[3] ?? process.cwd();
if (!task) {
  console.error("usage: tsx scripts/real-task.ts <task> [worktree]  (set REAL_TASK_RESUME_RUN_ID to resume)");
  process.exit(2);
}

process.env.PONYTAIL_DEFAULT_MODE = "off";

const server = await createOpencodeServer({
  port: 0,
  timeout: 30000,
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
const rootSessionId = root.data.id;

const definition = withSolutionRoleModelAssignments(await loadConnectorDefinition(worktree), Object.fromEntries(
  ([
    ["inspect", process.env.REAL_TASK_MODEL_THINKING],
    ["synthesize", process.env.REAL_TASK_MODEL_THINKING],
    ["refine", process.env.REAL_TASK_MODEL_THINKING],
    ["implement", process.env.REAL_TASK_MODEL_FAST],
    ["verify", process.env.REAL_TASK_MODEL_FAST],
    ["present", process.env.REAL_TASK_MODEL_FAST],
  ] as const).filter((entry): entry is [typeof entry[0], string] => Boolean(entry[1])).map(([role, model]) => [role, opencodeModel({ model })]),
));
const configured = definition.graphs["solution-lod"];
const runId = process.env.REAL_TASK_RESUME_RUN_ID ?? `harness-${Date.now()}`;

const runtime = new OpenCodeAgentRuntime({
  plugin: { client, project: {} as never, directory: worktree, worktree, serverUrl: new URL(server.url), $: {} as never },
  definition,
  parentSessionId: rootSessionId,
  parentModel: (() => {
    const [providerID, modelID] = (process.env.REAL_TASK_MODEL ?? "deepseek/deepseek-v4-pro").split("/");
    return { providerID, modelID };
  })(),
  directory: worktree,
  worktree,
  signal: new AbortController().signal,
  ask: async () => {},
  onEvent: (event) => console.log(`  [${event.node}] ${event.status}${event.text ? ` — ${event.text.replace(/\s+/g, " ").slice(0, 120)}` : ""}`),
});

console.log(`task: ${task}`);
console.log(`worktree: ${worktree}`);
console.log(`runId: ${runId}\n`);

const resume = Boolean(process.env.REAL_TASK_RESUME_RUN_ID);
const input = resume ? null : configured.initial({ task, conversationContext: "", directory: worktree, worktree, runId });
const result = await configured.graph.invoke(input as never, {
  recursionLimit: 512,
  configurable: {
    thread_id: runId,
    langgraphOpenCodeRuntime: runtime,
    langgraphAcquireWorktree: async () => {},
  },
});

const progress = configured.progress?.(result);
console.log(`\n=== RESULT ===`);
console.log(configured.result?.(result));
console.log(`\n=== PHASE: ${progress?.phase} ===`);
const network = (result as { network: { regions: unknown[]; candidates: unknown[]; constraints: unknown[]; activations: unknown[] } }).network;
console.log(`regions=${network.regions.length} constraints=${network.constraints.length} activations=${network.activations.length}`);
for (const region of network.regions as Array<{ id: string; lod: number; status: string; delivery: string; selectedCandidateIds: string[]; contradiction?: string }>) {
  console.log(`  region ${region.id} lod=${region.lod} status=${region.status} delivery=${region.delivery} selected=${region.selectedCandidateIds.length}${region.contradiction ? ` contradiction="${region.contradiction.slice(0, 100)}"` : ""}`);
}
for (const candidate of network.candidates as Array<{ id: string; regionId: string; status: string; proposition: string; eliminationReasons: string[] }>) {
  console.log(`  candidate ${candidate.id} [${candidate.status}] | ${candidate.proposition.slice(0, 70)}${candidate.eliminationReasons.length ? ` << ${candidate.eliminationReasons.join("; ").slice(0, 90)}` : ""}`);
}
for (const constraint of network.constraints as Array<{ kind: string; subject: string; target: string; reason: string }>) {
  console.log(`  constraint ${constraint.kind}: ${constraint.subject} -> ${constraint.target} (${constraint.reason.slice(0, 60)})`);
}

await server.close();
process.exit(progress?.phase === "completed" ? 0 : 1);
