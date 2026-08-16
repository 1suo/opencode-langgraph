import { createHash } from "node:crypto";
import type { DetailDecision, Evidence, PlanNode, ProgressiveLodState, VerificationOutput } from "./types.js";

function planNumber(value: string): number { const parsed = Number(value.replace(/^p/, "")); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER; }
function byPlanId(left: PlanNode, right: PlanNode): number { return planNumber(left.id) - planNumber(right.id) || left.id.localeCompare(right.id); }
export function liveNodeCount(nodes: PlanNode[]): number { return nodes.filter((node) => node.status !== "removed" && node.status !== "expanded").length; }

export function assertAcyclic(nodes: PlanNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Plan dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function planningResolved(node: PlanNode | undefined): boolean {
  return !node || node.status === "ready" || node.status === "implemented" || node.status === "verified" || node.status === "expanded" || node.status === "removed";
}

export function selectActiveNode(nodes: PlanNode[]): PlanNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => node.status === "pending" && node.dependencies.every((id) => planningResolved(byId.get(id))))
    .sort((a, b) => a.depth - b.depth || byPlanId(a, b))[0];
}

export function mergeResearch(state: ProgressiveLodState, raw: { evidence: Array<Omit<Evidence, "id" | "fingerprint">>; constraints: Array<{ text: string; source: string }>; unknowns: string[] }): Pick<ProgressiveLodState, "evidence" | "constraints" | "research"> {
  const evidence = [...state.evidence];
  for (const item of raw.evidence) {
    const fingerprint = createHash("sha256").update(`${item.source}\0${item.claim}\0${item.excerpt}`).digest("hex").slice(0, 16);
    if (evidence.some((existing) => existing.fingerprint === fingerprint)) continue;
    evidence.push({ ...item, id: `e${evidence.length + 1}`, fingerprint });
  }
  const constraints = [...state.constraints];
  for (const item of raw.constraints) if (!constraints.some((existing) => existing.text === item.text && existing.source === item.source && existing.nodeId === state.activeNodeId)) constraints.push({ ...item, id: `c${constraints.length + 1}`, nodeId: state.activeNodeId });
  const added = evidence.slice(state.evidence.length);
  return { evidence, constraints, research: { unknowns: raw.unknowns, evidence: added, constraints: constraints.slice(state.constraints.length) } };
}

export interface DecisionMerge {
  plan: PlanNode[];
  activeNodeId?: string;
  nextId: number;
  humanQuestion: string;
  decisions: Record<string, string>;
}

export function applyDecision(state: ProgressiveLodState, decision: DetailDecision, agent = "decider"): DecisionMerge {
  const plan = state.plan.map((node) => ({ ...node, dependencies: [...node.dependencies], evidenceIds: [...node.evidenceIds], agents: [...(node.agents ?? [])] }));
  const target = plan.find((node) => node.id === state.activeNodeId);
  if (!target) throw new Error("Detail decision requires an active plan node");
  const evidenceIds = state.research?.evidence.map((item) => item.id) ?? [];
  target.evidenceIds = [...new Set([...target.evidenceIds, ...evidenceIds])];
  target.contextCycles++;
  target.agents = [...new Set([...(target.agents ?? []), agent])];
  const decisions = { ...state.decisions, [target.id]: decision.disposition };
  let nextId = state.nextId;
  let humanQuestion = "";

  if (decision.disposition === "ready") {
    target.leaf = { objective: decision.objective, targets: decision.targets, acceptanceCriteria: decision.acceptanceCriteria, verification: decision.verification };
    target.status = "ready";
  } else if (decision.disposition === "refine" || decision.disposition === "split") {
    const children = decision.disposition === "refine" ? [decision.child] : decision.children;
    if (liveNodeCount(plan) - 1 + children.length > state.budget.nodes) throw new Error("Detail decision exceeds the live plan-node budget");
    const ancestorIds = new Set<string>([target.id]);
    let parentId = target.parentId;
    while (parentId) {
      ancestorIds.add(parentId);
      parentId = plan.find((node) => node.id === parentId)?.parentId;
    }
    if (children.some((child) => child.dependencies.some((dependency) => ancestorIds.has(dependency)))) throw new Error("Detail decision child cannot depend on itself or an ancestor concern");
    const localIds = new Map(children.map((child, index) => [child.key, `p${nextId + index}`]));
    target.status = "expanded";
    for (const child of children) {
      const id = `p${nextId++}`;
      plan.push({
        id, parentId: target.id, title: child.title, description: child.question, level: child.title, depth: target.depth + 1,
        status: "pending", dependencies: child.dependencies.map((dependency) => localIds.get(dependency) ?? dependency).filter((dependency) => plan.some((node) => node.id === dependency) || [...localIds.values()].includes(dependency)),
        evidenceIds: [...target.evidenceIds], confidence: target.confidence, contextCycles: 0, reopenCount: 0,
        agents: [agent],
        scoutSessionId: target.scoutSessionId, scoutSessionMode: decision.disposition === "refine" ? "continue" : target.scoutSessionId ? "fork" : "fresh", scoutTurns: target.scoutTurns,
      });
    }
  } else if (decision.disposition === "remove") {
    target.status = "removed";
  } else if (decision.disposition === "reopen_parent") {
    const parent = plan.find((node) => node.id === target.parentId);
    if (!parent || parent.reopenCount >= state.budget.reopens) throw new Error("Plan parent cannot be reopened");
    target.status = "removed"; parent.status = "pending"; parent.reopenCount++;
    parent.replanIssues = [...(parent.replanIssues ?? []), { source: "decision", leafId: target.id, text: decision.reason ?? `Concern ${target.title} requires its parent to be reconsidered.` }];
  } else {
    target.status = "active";
    humanQuestion = decision.question;
  }
  assertAcyclic(plan);
  const active = humanQuestion ? target : selectActiveNode(plan);
  if (active && active.status === "pending") active.status = "active";
  return { plan, activeNodeId: active?.id, nextId, humanQuestion, decisions };
}

export function nextImplementationLeaf(nodes: PlanNode[]): PlanNode | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolved = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    const dependency = byId.get(id);
    if (!dependency || dependency.status === "removed" || dependency.status === "implemented" || dependency.status === "verified") return true;
    if (dependency.status !== "expanded") return false;
    const children = nodes.filter((node) => node.parentId === id && node.status !== "removed");
    return children.length > 0 && children.every((child) => resolved(child.id, new Set([...seen, id])));
  };
  return nodes.filter((node) => node.status === "ready" && node.dependencies.every((id) => resolved(id))).sort(byPlanId)[0];
}

export function implementationOrder(nodes: PlanNode[]): PlanNode[] {
  const ready = nodes.filter((node) => node.status === "ready" || node.status === "failed");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leafDependencies = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) throw new Error(`Plan dependency cycle at ${id}`);
    const dependency = byId.get(id);
    if (!dependency || dependency.status !== "expanded") return [id];
    const children = nodes.filter((node) => node.parentId === id && node.status !== "removed");
    return children.flatMap((child) => leafDependencies(child.id, new Set([...seen, id])));
  };
  const result: PlanNode[] = [];
  const remaining = new Map(ready.map((node) => [node.id, node]));
  while (remaining.size) {
    const available = [...remaining.values()].filter((node) => node.dependencies.flatMap((id) => leafDependencies(id)).every((id) => !remaining.has(id))).sort(byPlanId);
    if (!available.length) throw new Error("Implementable plan contains a dependency cycle");
    for (const node of available) { result.push(node); remaining.delete(node.id); }
  }
  return result;
}

function verifiedFailureIds(nodes: PlanNode[], requested: string[]): Set<string> {
  const eligible = new Set(nodes.filter((node) => node.status === "implemented" || node.status === "implementing" || node.status === "failed").map((node) => node.id));
  const valid = new Set(requested.filter((id) => eligible.has(id)));
  return valid.size ? valid : eligible;
}

export function applyVerification(nodes: PlanNode[], verification: VerificationOutput): PlanNode[] {
  const failed = verification.passed ? new Set<string>() : verifiedFailureIds(nodes, verification.failedNodeIds);
  return nodes.map((node) => node.status === "implemented" || node.status === "implementing"
    ? { ...node, status: verification.passed || !failed.has(node.id) ? "verified" as const : "failed" as const }
    : node);
}

export function reopenFailedPlan(nodes: PlanNode[], requested: string[], reopenLimit: number): { plan: PlanNode[]; activeNodeId?: string; reopenedNodeIds: string[]; invalidatedNodeIds: string[] } {
  const failedIds = verifiedFailureIds(nodes, requested);
  const failedNodes = nodes.filter((node) => failedIds.has(node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reopenIds = new Set(failedNodes.map((node) => node.parentId ?? node.id).filter((id) => (byId.get(id)?.reopenCount ?? reopenLimit) < reopenLimit));
  const invalid = new Set<string>();
  for (const root of reopenIds) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) if (node.parentId && (node.parentId === root || invalid.has(node.parentId)) && !invalid.has(node.id)) { invalid.add(node.id); changed = true; }
    }
  }
  const plan = nodes.map((node) => reopenIds.has(node.id) ? { ...node, status: "pending" as const, reopenCount: node.reopenCount + 1, leaf: undefined }
    : invalid.has(node.id) ? { ...node, status: "removed" as const, leaf: undefined } : node);
  const active = selectActiveNode(plan);
  if (active) active.status = "active";
  return { plan, activeNodeId: active?.id, reopenedNodeIds: [...reopenIds], invalidatedNodeIds: [...new Set([...reopenIds, ...invalid])] };
}
