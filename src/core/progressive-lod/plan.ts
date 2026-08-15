import type { AnalysisOutput, Constraint, Evidence, PlanNode, ProgressiveLodState } from "./types.js";

function key(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }

export function assertAcyclic(nodes: PlanNode[]): void {
  const ids = new Set(nodes.map((node) => node.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Plan dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (ids.has(dependency)) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function selectActiveNode(nodes: PlanNode[]): PlanNode | undefined {
  const done = new Set(nodes.filter((node) => node.status === "verified" || node.status === "removed").map((node) => node.id));
  return nodes
    .filter((node) => (node.status === "pending" || node.status === "active") && node.dependencies.every((id) => done.has(id)))
    .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))[0];
}

function commonRefinements(output: AnalysisOutput) {
  const candidates = output.candidates;
  if (candidates.length < 2) return [];
  return candidates[0].refinements.filter((refinement) => candidates.every((candidate) => candidate.refinements.some((other) => key(other.title) === key(refinement.title) && other.action === refinement.action)));
}

export interface MergeResult { plan: PlanNode[]; evidence: Evidence[]; constraints: Constraint[]; nextId: number; activeNodeId?: string; humanQuestion: string; discoveries: string[] }

export function mergeAnalysis(state: ProgressiveLodState, output: AnalysisOutput): MergeResult {
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  if (!active) throw new Error("Cannot merge analysis without an active plan node");
  output = { ...output, candidates: output.candidates.slice(0, state.budget.candidates) };
  const evidence = [...state.evidence, ...output.evidence.map((item, index) => ({ ...item, id: `e${state.evidence.length + index + 1}` } satisfies Evidence))];
  const constraints = [...state.constraints, ...output.constraints.map((item, index) => ({ ...item, id: `c${state.constraints.length + index + 1}` } satisfies Constraint))];
  const plan = state.plan.map((node) => ({ ...node, dependencies: [...node.dependencies], files: [...node.files], evidenceIds: [...node.evidenceIds] }));
  const target = plan.find((node) => node.id === active.id)!;
  target.contextCycles++;
  if (output.evaluation.needsHuman) {
    target.status = "active";
    return { plan, evidence, constraints, nextId: state.nextId, activeNodeId: target.id, humanQuestion: output.evaluation.question || `Clarify ${target.title}`, discoveries: [...state.discoveries, output.summary] };
  }
  if (output.evaluation.needsMoreContext && target.contextCycles < state.budget.contextCyclesPerNode) {
    target.status = "active";
    return { plan, evidence, constraints, nextId: state.nextId, activeNodeId: target.id, humanQuestion: "", discoveries: [...state.discoveries, output.summary] };
  }
  const selected = output.candidates[Math.min(output.evaluation.selected, output.candidates.length - 1)];
  const shared = commonRefinements(output);
  const refinements = shared.length ? shared : selected.refinements;
  if (!refinements.length) throw new Error("Analysis produced no mergeable refinement");
  let nextId = state.nextId;
  target.status = "removed";
  for (const refinement of refinements) {
    if (refinement.action === "remove") continue;
    if (refinement.action === "reopen_parent") {
      const parent = plan.find((node) => node.id === target.parentId);
      if (parent && parent.reopenCount < state.budget.reopens) {
        const invalid = new Set([parent.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of plan) if (node.parentId && invalid.has(node.parentId) && !invalid.has(node.id)) { invalid.add(node.id); changed = true; }
        }
        for (const node of plan) if (node.id !== parent.id && invalid.has(node.id)) node.status = "removed";
        parent.status = "pending"; parent.reopenCount++;
      }
      continue;
    }
    if (plan.length >= state.budget.nodes) break;
    const id = `p${nextId++}`;
    plan.push({
      id, parentId: target.id, title: refinement.title, description: refinement.description,
      level: refinement.level, depth: target.depth + 1, status: refinement.implementable ? "ready" : "pending",
      dependencies: refinement.dependencies.filter((dependency) => plan.some((node) => node.id === dependency)),
      files: refinement.files, evidenceIds: output.evidence.length ? evidence.slice(-output.evidence.length).map((item) => item.id) : [],
      confidence: output.evaluation.confidence, contextCycles: 0, reopenCount: 0,
    });
  }
  assertAcyclic(plan);
  const next = selectActiveNode(plan);
  if (next) next.status = "active";
  return { plan, evidence, constraints, nextId, activeNodeId: next?.id, humanQuestion: "", discoveries: [...state.discoveries, output.summary] };
}

export function budgetExceeded(state: ProgressiveLodState): boolean {
  return state.callsUsed >= state.budget.calls - state.budget.reservedCalls || Date.now() - state.startedAt >= state.budget.minutes * 60_000;
}

export function implementationOrder(nodes: PlanNode[]): PlanNode[] {
  const ready = nodes.filter((node) => node.status === "ready" || node.status === "failed");
  const result: PlanNode[] = [];
  const remaining = new Map(ready.map((node) => [node.id, node]));
  while (remaining.size) {
    const available = [...remaining.values()].filter((node) => node.dependencies.every((id) => !remaining.has(id))).sort((a, b) => a.id.localeCompare(b.id));
    if (!available.length) throw new Error("Implementable plan contains a dependency cycle");
    for (const node of available) { result.push(node); remaining.delete(node.id); }
  }
  return result;
}
