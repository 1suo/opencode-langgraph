import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { loadConnectorDefinition, withSolutionRoleModelAssignments } from "../src/core/config.js";
import { reopenRegion } from "../src/core/solution-lod/reducer.js";
import type { StoredRun } from "../src/opencode/store.js";

const runId = "69bf19af-7a6b-4b89-b1fe-6c032bf3fd9c";
const stateRoot = "/home/isuo/.local/state/opencode-langgraph";
const runFile = `${stateRoot}/runs/${runId}.json`;
const saved = JSON.parse(readFileSync(runFile, "utf8")) as StoredRun;
if (saved.status !== "paused") throw new Error(`Expected paused run, got ${saved.status}`);

const loaded = await loadConnectorDefinition(saved.worktree);
const definition = withSolutionRoleModelAssignments(loaded, saved.modelAssignments);
const configured = definition.graphs[saved.graph];
if (!configured) throw new Error(`Missing graph ${saved.graph}`);
const config = { configurable: { thread_id: runId } };
const snapshot = await configured.graph.getState(config);
const values = snapshot.values as Record<string, any>;
const objective = `${saved.task}\n\nOrchestration requirement: preserve every part of this objective. At L0 choose only the broad solution family. Do not implement L0 directly. The selected candidate must expose explicit partOf child regions that together cover: (1) exhaustive inventory of the design system plus every core, shared, and derived UI component; (2) separation of centralized system ownership from component usage and a complete violation inventory; (3) a semantic default typography contract and migration of inappropriate or inconsistent sizes; (4) PrimeVue/Aura-first generic controls, containers, borders, radii, shadows, layouts, and all interaction/focus/disabled/error/loading states, removing redundant overrides; (5) retained domain-specific/shared primitives and necessary data-driven styling with clear ownership boundaries; (6) migration of all derived UI usages and recurring layouts; (7) repository-wide automated enforcement against visual drift; (8) documentation/audit; and (9) final repository-wide verification. Each child must have observable acceptance criteria. These are independent required deliverables, not routine implementation steps.`;
const reopened = reopenRegion(values.network, "r1", "L0 incorrectly collapsed a huge multi-deliverable task into one implementation activation");
const network = {
  ...reopened,
  regions: reopened.regions.map((region: any) => region.id === "r1" ? {
    ...region,
    objective,
    allowedVariables: ["broad solution family and decomposition into complete required deliverables"],
    acceptanceCriteria: ["The chosen L0 solution preserves the complete user objective and exposes all required implementation work as explicit partOf children; L0 itself is not actionable."],
    activationIds: [],
  } : region),
  activations: reopened.activations.filter((activation: any) => activation.regionId !== "r1" || activation.status === "completed"),
};
const updated = { ...values, network, activeActivationId: undefined, result: "", phase: "pruned" };
await configured.graph.updateState(config, updated, "__start__");
writeFileSync(runFile, JSON.stringify({ ...saved, status: "pruned" }, null, 2));
appendFileSync(`${stateRoot}/${saved.rootSessionId}.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), runId, rootSessionId: saved.rootSessionId, userMessageId: saved.userMessageId, graph: saved.graph, node: "__prune__:r1", status: "pruned", agent: "connector", model: "connector", text: "Pruned r1 and restored the complete objective with mandatory partOf decomposition.", state: updated })}\n`);
console.log(JSON.stringify({ runId, status: "pruned", objective }, null, 2));
