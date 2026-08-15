import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { agentNode } from "../agent-node.js";
import { DurableFileSaver } from "../durable-checkpointer.js";
import { structuredAgentNode } from "../structured-agent-node.js";
import type { ConnectorGraph, GraphProgressSnapshot } from "../types.js";
import type { AgentCallResult, AgentUsage } from "../types.js";
import { applyVerification, budgetExceeded, implementationOrder, liveNodeCount, mergeAnalysis, reopenFailedPlan } from "./plan.js";
import { AnalysisSchema, ClassificationSchema, SCOPE_BUDGETS, VerificationSchema, type ProgressiveLodState } from "./types.js";

const ProgressiveState = Annotation.Root({
  runId: Annotation<string>, originalTask: Annotation<string>, directory: Annotation<string>, worktree: Annotation<string>,
  phase: Annotation<string>, profile: Annotation<ProgressiveLodState["profile"]>,
  budget: Annotation<ProgressiveLodState["budget"]>, plan: Annotation<ProgressiveLodState["plan"]>, activeNodeId: Annotation<string | undefined>,
  evidence: Annotation<ProgressiveLodState["evidence"]>, constraints: Annotation<ProgressiveLodState["constraints"]>, analysis: Annotation<ProgressiveLodState["analysis"]>,
  discoveries: Annotation<string[]>, callsUsed: Annotation<number>, nextId: Annotation<number>, startedAt: Annotation<number>, repairAttempts: Annotation<number>,
  decisions: Annotation<Record<string, string>>, usage: Annotation<AgentUsage>,
  humanQuestion: Annotation<string>, humanAnswer: Annotation<string>, implementation: Annotation<string>, verification: Annotation<ProgressiveLodState["verification"]>, result: Annotation<string>,
});

const durableSavers = new Map<string, DurableFileSaver>();
export function defaultDurableCheckpointer(): DurableFileSaver {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const directory = path.join(stateBase, "opencode-langgraph");
  fs.mkdirSync(directory, { recursive: true });
  const checkpointDirectory = path.join(directory, "checkpoints");
  const existing = durableSavers.get(checkpointDirectory);
  if (existing) return existing;
  const saver = new DurableFileSaver(checkpointDirectory);
  durableSavers.set(checkpointDirectory, saver);
  return saver;
}

export interface ProgressiveLodOptions {
  classifierAgent?: string;
  analystAgent: string;
  implementerAgent: string;
  verifierAgent?: string;
  answerAgent?: string;
  checkpointer?: BaseCheckpointSaver;
}

const EMPTY_USAGE: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
function addUsage(current: AgentUsage | undefined, result: AgentCallResult): AgentUsage {
  const left = current ?? EMPTY_USAGE;
  const right = result.usage ?? EMPTY_USAGE;
  return {
    turns: left.turns + right.turns, input: left.input + right.input, output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning, cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite, cost: left.cost + right.cost,
  };
}

function compactState(state: ProgressiveLodState) {
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  const byId = new Map(state.plan.map((node) => [node.id, node]));
  const related = new Set<string>();
  let cursor = active;
  while (cursor) { related.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
  const visitDependency = (id: string) => {
    if (related.has(id)) return;
    related.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visitDependency(dependency);
  };
  for (const dependency of active?.dependencies ?? []) visitDependency(dependency);
  const evidenceIds = new Set([...related].flatMap((id) => byId.get(id)?.evidenceIds ?? []));
  const siblingIds = new Set(state.plan.filter((node) => node.parentId === active?.parentId && node.status === "removed").map((node) => node.id));
  const decisionIds = new Set([...related, ...siblingIds]);
  return {
    task: state.originalTask, profile: state.profile, active,
    plan: state.plan.map(({ id, parentId, title, description, level, depth, status, dependencies, files }) => ({
      id, parentId, title, ...(related.has(id) ? { description } : {}), level, depth, status, dependencies, files,
    })),
    evidence: state.evidence.filter((item) => evidenceIds.has(item.id)), constraints: state.constraints,
    decisions: Object.fromEntries(Object.entries(state.decisions ?? {}).filter(([id]) => decisionIds.has(id))),
    budget: { callsUsed: state.callsUsed, calls: state.budget.calls, liveNodes: liveNodeCount(state.plan), nodeLimit: state.budget.nodes },
  };
}

function analysisPrompt(state: ProgressiveLodState): string {
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  return `Task type: planning refinement. Detail only the active plan branch; do not implement, edit files, run mutating commands, or redo ready/verified siblings. Inspect the repository with read-only tools before claiming facts.

Original task: ${state.originalTask}
Scope: ${state.profile?.scope}
Active planning level "${active?.level}" at tree depth ${active?.depth}: ${active?.title}\n${active?.description}
Existing state: ${JSON.stringify(compactState(state))}

${state.verification && !state.verification.passed ? `Replanning reason: ${state.verification.summary}\nFailed plan IDs: ${state.verification.failedNodeIds.join(", ") || "verifier supplied no valid IDs"}` : ""}
Reuse supplied grounded evidence and decisions; inspect only claims that remain unresolved. Return ${state.budget.candidates} genuinely distinct candidate decompositions when a material decision exists; otherwise return one. Derive the next useful planning level from this task and repository evidence, and name it in each refinement; do not follow a predetermined intent/architecture/components/changes sequence. Prefer implementable leaves as soon as repository evidence makes them bounded. Keep the whole plan compact: combine tightly coupled code, tests, owner documentation, and required bookkeeping instead of creating separate orchestration leaves for each. Mark implementable only when the title and description identify a bounded file/symbol-sized change with verification. At most ${state.budget.nodes - liveNodeCount(state.plan) + 1} live refinements fit. Give each refinement a short unique key; dependencies may reference existing plan IDs or keys in the same candidate. Ask for human input only for a consequential choice that repository evidence cannot resolve.`;
}

function planForImplementation(state: ProgressiveLodState): string {
  return implementationOrder(state.plan).map((node, index) => `${index + 1}. [${node.id}] ${node.title}\n${node.description}\nFiles: ${node.files.join(", ") || "discover as needed"}\nDepends on: ${node.dependencies.join(", ") || "none"}`).join("\n\n");
}

function progress(state: ProgressiveLodState): GraphProgressSnapshot {
  return {
    phase: state.phase, scope: state.profile?.scope, activeNodeId: state.activeNodeId,
    callsUsed: state.callsUsed, callBudget: state.budget.calls,
    summary: state.verification?.summary ?? state.discoveries.at(-1) ?? state.profile?.summary,
    usage: state.usage,
    nodes: state.plan.map((node) => ({ id: node.id, parentId: node.parentId, title: node.title, level: node.level, depth: node.depth, status: node.status, dependencies: node.dependencies, evidence: node.evidenceIds.length, confidence: node.confidence })),
  };
}

export function progressiveLodGraph(options: ProgressiveLodOptions): ConnectorGraph<ProgressiveLodState> {
  const classifier = options.classifierAgent ?? options.analystAgent;
  const analyst = options.analystAgent;
  const verifier = options.verifierAgent ?? analyst;
  const answer = options.answerAgent ?? analyst;
  const builder = new StateGraph(ProgressiveState)
    .addNode("classify", structuredAgentNode<ProgressiveLodState, typeof ClassificationSchema._output>({
      node: "classify", agent: classifier, schema: ClassificationSchema,
      prompt: (state) => `Task type: routing classification only. Do not solve, plan, inspect the repository, or call tools. route=answer only for a read-only response or investigation; route=change whenever files or external state must change. Scope is local, subsystem, architectural, or unknown. Derive a short planningFrame naming the task-specific top-level decision or outcome; it is not selected from a fixed hierarchy.\n\n${state.originalTask}`,
      output: (profile, state, result) => ({ profile, phase: "classified", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result) }),
    }))
    .addNode("answer", agentNode<ProgressiveLodState>({
      node: "answer", agent: answer,
      prompt: (state) => `Task type: read-only answer or investigation. Answer the request directly. Use read-only repository tools when relevant. Do not edit files or propose that work was performed.\n\n${state.originalTask}`,
      output: (text, state, call) => ({ result: text, phase: "completed", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, call) }),
    }))
    .addNode("initialize", (state: ProgressiveLodState) => ({
      phase: "planning", budget: SCOPE_BUDGETS[state.profile?.scope ?? "unknown"], nextId: 2, activeNodeId: "p1",
      plan: [{ id: "p1", title: state.profile?.summary ?? state.originalTask, description: state.originalTask, level: state.profile?.planningFrame ?? state.originalTask, depth: 0, status: "active" as const, dependencies: [], files: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0 }],
    }))
    .addNode("acquire", async (_state: ProgressiveLodState, config?: RunnableConfig) => {
      const acquire = config?.configurable?.langgraphAcquireWorktree as (() => Promise<void>) | undefined;
      if (acquire) await acquire();
      return { phase: "planning" };
    })
    .addNode("analyze", structuredAgentNode<ProgressiveLodState, typeof AnalysisSchema._output>({
      node: "analyze", agent: analyst, schema: AnalysisSchema, prompt: analysisPrompt,
      output: (analysis, state, result) => ({ analysis, phase: "evaluating", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result) }),
    }))
    .addNode("merge", (state: ProgressiveLodState) => {
      if (!state.analysis) throw new Error("Merge requires analysis");
      const merged = mergeAnalysis(state, state.analysis);
      const hasReady = merged.plan.some((node) => node.status === "ready" || node.status === "failed");
      return { ...merged, analysis: undefined, phase: merged.humanQuestion ? "waiting-human" : merged.activeNodeId && !budgetExceeded(state) ? "planning" : hasReady ? "implementing" : "budget-exhausted" };
    })
    .addNode("human", (state: ProgressiveLodState) => {
      const response = interrupt({ question: state.humanQuestion, activeNodeId: state.activeNodeId, plan: progress(state) });
      return { humanAnswer: typeof response === "string" ? response : JSON.stringify(response), humanQuestion: "", discoveries: [...state.discoveries, `User decision: ${typeof response === "string" ? response : JSON.stringify(response)}`], phase: "planning" };
    })
    .addNode("implement", agentNode<ProgressiveLodState>({
      node: "implement", agent: options.implementerAgent,
      prompt: (state) => `Task type: implementation. Implement only the bounded ready leaves below, in topological order, in the current worktree. Inspect before editing, preserve unrelated changes, and run proportionate checks. Do not redesign the plan or merely describe edits; report a blocker instead of silently expanding scope.\n\nOriginal task: ${state.originalTask}\n\nConstraints: ${JSON.stringify(state.constraints)}\n\nPlan:\n${planForImplementation(state)}`,
      output: (text, state, result) => ({ implementation: text, phase: "verifying", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result), plan: state.plan.map((node) => node.status === "ready" || node.status === "failed" ? { ...node, status: "implementing" as const } : node) }),
    }))
    .addNode("verify", structuredAgentNode<ProgressiveLodState, typeof VerificationSchema._output>({
      node: "verify", agent: verifier, schema: VerificationSchema,
      prompt: (state) => `Task type: independent verification. Inspect the actual diff and run relevant read-only checks against the original request and every implementable plan leaf. Do not edit or repair files. failedNodeIds must contain only exact bracketed plan IDs from the plan below (for example p2), never semantic labels; return an empty list only when no specific leaf can be identified.\n\nTask: ${state.originalTask}\nPlan: ${planForImplementation(state)}\nImplementer report: ${state.implementation}`,
      output: (verification, state, result) => ({ verification, phase: verification.passed ? "completed" : "verification-failed", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result), plan: applyVerification(state.plan, verification) }),
    }))
    .addNode("repair", agentNode<ProgressiveLodState>({
      node: "repair", agent: options.implementerAgent,
      prompt: (state) => `Task type: bounded implementation repair. Repair only the failed plan leaves and verification findings below, then run focused checks. Preserve successful work and unrelated changes; do not redesign or expand the task.\n\nTask: ${state.originalTask}\nFailed leaves:\n${planForImplementation(state)}\nVerification: ${JSON.stringify(state.verification)}\nPrior implementation: ${state.implementation}`,
      output: (text, state, result) => ({ implementation: `${state.implementation}\n\nRepair ${state.repairAttempts + 1}:\n${text}`, repairAttempts: state.repairAttempts + 1, phase: "verifying", callsUsed: state.callsUsed + 1, usage: addUsage(state.usage, result), plan: state.plan.map((node) => node.status === "failed" ? { ...node, status: "implementing" as const } : node) }),
    }))
    .addNode("reopen", (state: ProgressiveLodState) => {
      const reopened = reopenFailedPlan(state.plan, state.verification?.failedNodeIds ?? [], state.budget.reopens);
      const reason = state.verification?.summary ?? "Verification found an architectural mismatch.";
      return { plan: reopened.plan, activeNodeId: reopened.activeNodeId, discoveries: [...state.discoveries, `Reopened ${reopened.reopenedNodeIds.join(", ") || "no branch"} after verification: ${reason}`], phase: reopened.activeNodeId ? "planning" : "verification-failed" };
    })
    .addNode("finish", (state: ProgressiveLodState) => ({
      phase: state.verification?.passed ? "completed" : "failed",
      result: state.verification?.passed ? `${state.implementation}\n\nVerification: ${state.verification.summary}` : `Implementation did not pass verification.\n\n${state.verification?.summary ?? "Planning budget exhausted before an implementable plan was produced."}\n\n${state.implementation}`,
    }))
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state: ProgressiveLodState) => state.profile?.route ?? "answer", { answer: "answer", change: "acquire" })
    .addEdge("answer", END).addConditionalEdges("acquire", (state: ProgressiveLodState) => state.plan.length ? "analyze" : "initialize", { analyze: "analyze", initialize: "initialize" }).addEdge("initialize", "analyze").addEdge("analyze", "merge")
    .addConditionalEdges("merge", (state: ProgressiveLodState) => state.humanQuestion ? "human" : state.activeNodeId ? (!budgetExceeded(state) ? "analyze" : "finish") : state.plan.some((node) => node.status === "ready" || node.status === "failed") ? "implement" : "finish", { human: "human", analyze: "analyze", implement: "implement", finish: "finish" })
    .addEdge("human", "acquire").addEdge("implement", "verify")
    .addConditionalEdges("verify", (state: ProgressiveLodState) => state.verification?.passed ? "finish" : state.verification?.architecturalMismatch && state.callsUsed < state.budget.calls - state.budget.reservedCalls ? "reopen" : state.verification?.repairable && state.repairAttempts < state.budget.repairs && state.callsUsed < state.budget.calls ? "repair" : "finish", { finish: "finish", reopen: "reopen", repair: "repair" })
    .addConditionalEdges("reopen", (state: ProgressiveLodState) => state.activeNodeId && !budgetExceeded(state) ? "analyze" : "finish", { analyze: "analyze", finish: "finish" })
    .addEdge("repair", "verify").addEdge("finish", END);
  return {
    graph: builder.compile({ checkpointer: options.checkpointer ?? defaultDurableCheckpointer() }),
    initial: ({ task, directory, worktree, runId }) => ({ runId, originalTask: task, directory, worktree, phase: "classifying", budget: SCOPE_BUDGETS.unknown, plan: [], evidence: [], constraints: [], discoveries: [], decisions: {}, usage: { ...EMPTY_USAGE }, callsUsed: 0, nextId: 1, startedAt: Date.now(), repairAttempts: 0, humanQuestion: "", humanAnswer: "", implementation: "", result: "" }),
    result: (state) => state.result,
    progress,
    display: { classify: { phase: "route", agent: classifier }, analyze: { phase: "expand", agent: analyst }, merge: { phase: "reduce" }, human: { phase: "decision" }, implement: { phase: "commit", agent: options.implementerAgent }, verify: { phase: "verify", agent: verifier }, repair: { phase: "repair", agent: options.implementerAgent } },
  };
}
