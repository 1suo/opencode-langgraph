import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { agentNode } from "../agent-node.js";
import { structuredAgentNode } from "../structured-agent-node.js";
import type { ConnectorGraph, GraphProgressSnapshot } from "../types.js";
import { budgetExceeded, implementationOrder, mergeAnalysis, selectActiveNode } from "./plan.js";
import { AnalysisSchema, ClassificationSchema, DEFAULT_LODS, SCOPE_BUDGETS, VerificationSchema, type ProgressiveLodState } from "./types.js";

const ProgressiveState = Annotation.Root({
  runId: Annotation<string>, originalTask: Annotation<string>, directory: Annotation<string>, worktree: Annotation<string>,
  phase: Annotation<string>, profile: Annotation<ProgressiveLodState["profile"]>, lods: Annotation<ProgressiveLodState["lods"]>,
  budget: Annotation<ProgressiveLodState["budget"]>, plan: Annotation<ProgressiveLodState["plan"]>, activeNodeId: Annotation<string | undefined>,
  evidence: Annotation<ProgressiveLodState["evidence"]>, constraints: Annotation<ProgressiveLodState["constraints"]>, analysis: Annotation<ProgressiveLodState["analysis"]>,
  discoveries: Annotation<string[]>, callsUsed: Annotation<number>, nextId: Annotation<number>, startedAt: Annotation<number>, repairAttempts: Annotation<number>,
  humanQuestion: Annotation<string>, humanAnswer: Annotation<string>, implementation: Annotation<string>, verification: Annotation<ProgressiveLodState["verification"]>, result: Annotation<string>,
});

const durableSavers = new Map<string, SqliteSaver>();
export function defaultSqliteCheckpointer(): SqliteSaver {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const directory = path.join(stateBase, "opencode-langgraph");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "checkpoints.sqlite");
  const existing = durableSavers.get(file);
  if (existing) return existing;
  const saver = SqliteSaver.fromConnString(file);
  durableSavers.set(file, saver);
  return saver;
}

export interface ProgressiveLodOptions {
  analystAgent: string;
  implementerAgent: string;
  verifierAgent?: string;
  answerAgent?: string;
  checkpointer?: BaseCheckpointSaver;
}

function compactState(state: ProgressiveLodState) {
  return {
    task: state.originalTask, profile: state.profile, active: state.plan.find((node) => node.id === state.activeNodeId),
    plan: state.plan.map(({ id, parentId, title, description, lod, status, dependencies, files }) => ({ id, parentId, title, description, lod, status, dependencies, files })),
    evidence: state.evidence.slice(-12), constraints: state.constraints, discoveries: state.discoveries.slice(-8),
    budget: { callsUsed: state.callsUsed, calls: state.budget.calls, nodes: state.plan.length, nodeLimit: state.budget.nodes },
  };
}

function analysisPrompt(state: ProgressiveLodState): string {
  const active = state.plan.find((node) => node.id === state.activeNodeId);
  return `Develop the active branch of this repository-grounded plan. Inspect the repository with read-only tools before claiming facts.

Original task: ${state.originalTask}
Scope: ${state.profile?.scope}
Active LOD ${active?.lod}: ${active?.title}\n${active?.description}
LOD contract: ${state.lods[Math.min(3, active?.lod ?? 0)]?.question}
Existing state: ${JSON.stringify(compactState(state))}

Return ${state.budget.candidates} genuinely distinct candidate decompositions when a material decision exists; otherwise return one. A refinement must descend toward file/symbol-sized work. Mark implementable only when the title and description identify a bounded change with verification. Dependencies must reference existing plan IDs only. Ask for human input only for a consequential choice that repository evidence cannot resolve.`;
}

function planForImplementation(state: ProgressiveLodState): string {
  return implementationOrder(state.plan).map((node, index) => `${index + 1}. [${node.id}] ${node.title}\n${node.description}\nFiles: ${node.files.join(", ") || "discover as needed"}\nDepends on: ${node.dependencies.join(", ") || "none"}`).join("\n\n");
}

function progress(state: ProgressiveLodState): GraphProgressSnapshot {
  return {
    phase: state.phase, scope: state.profile?.scope, activeNodeId: state.activeNodeId,
    callsUsed: state.callsUsed, callBudget: state.budget.calls,
    summary: state.verification?.summary ?? state.discoveries.at(-1) ?? state.profile?.summary,
    nodes: state.plan.map((node) => ({ id: node.id, parentId: node.parentId, title: node.title, lod: node.lod, status: node.status, dependencies: node.dependencies, evidence: node.evidenceIds.length, confidence: node.confidence })),
  };
}

export function progressiveLodGraph(options: ProgressiveLodOptions): ConnectorGraph<ProgressiveLodState> {
  const analyst = options.analystAgent;
  const verifier = options.verifierAgent ?? analyst;
  const answer = options.answerAgent ?? analyst;
  const builder = new StateGraph(ProgressiveState)
    .addNode("classify", structuredAgentNode<ProgressiveLodState, typeof ClassificationSchema._output>({
      node: "classify", agent: analyst, schema: ClassificationSchema,
      prompt: (state) => `Classify the request. route=answer only for a read-only response or investigation; route=change whenever files or external state must change. Scope is local, subsystem, architectural, or unknown.\n\n${state.originalTask}`,
      output: (profile, state) => ({ profile, phase: "classified", callsUsed: state.callsUsed + 1 }),
    }))
    .addNode("answer", agentNode<ProgressiveLodState>({
      node: "answer", agent: answer,
      prompt: (state) => `Answer or investigate the request directly. Use read-only repository tools when relevant. Do not edit files.\n\n${state.originalTask}`,
      output: (text, state) => ({ result: text, phase: "completed", callsUsed: state.callsUsed + 1 }),
    }))
    .addNode("initialize", (state: ProgressiveLodState) => ({
      phase: "planning", budget: SCOPE_BUDGETS[state.profile?.scope ?? "unknown"], nextId: 2, activeNodeId: "p1",
      plan: [{ id: "p1", title: state.profile?.summary ?? state.originalTask, description: state.originalTask, lod: 0, status: "active" as const, dependencies: [], files: [], evidenceIds: [], confidence: 1, contextCycles: 0, reopenCount: 0 }],
    }))
    .addNode("acquire", async (_state: ProgressiveLodState, config?: RunnableConfig) => {
      const acquire = config?.configurable?.langgraphAcquireWorktree as (() => Promise<void>) | undefined;
      if (acquire) await acquire();
      return { phase: "planning" };
    })
    .addNode("analyze", structuredAgentNode<ProgressiveLodState, typeof AnalysisSchema._output>({
      node: "analyze", agent: analyst, schema: AnalysisSchema, prompt: analysisPrompt,
      output: (analysis, state) => ({ analysis, phase: "evaluating", callsUsed: state.callsUsed + 1 }),
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
      prompt: (state) => `Implement the complete plan in topological order in the current worktree. Inspect before editing, preserve unrelated changes, and run proportionate checks. Do not merely describe edits.\n\nOriginal task: ${state.originalTask}\n\nConstraints: ${JSON.stringify(state.constraints)}\n\nPlan:\n${planForImplementation(state)}`,
      output: (text, state) => ({ implementation: text, phase: "verifying", callsUsed: state.callsUsed + 1, plan: state.plan.map((node) => node.status === "ready" || node.status === "failed" ? { ...node, status: "implementing" as const } : node) }),
    }))
    .addNode("verify", structuredAgentNode<ProgressiveLodState, typeof VerificationSchema._output>({
      node: "verify", agent: verifier, schema: VerificationSchema,
      prompt: (state) => `Verify the implementation against the original request and every implementable plan leaf. Inspect the actual diff and run relevant checks. Do not edit files.\n\nTask: ${state.originalTask}\nPlan: ${planForImplementation(state)}\nImplementer report: ${state.implementation}`,
      output: (verification, state) => ({ verification, phase: verification.passed ? "completed" : "verification-failed", callsUsed: state.callsUsed + 1, plan: state.plan.map((node) => node.status === "implementing" ? { ...node, status: verification.passed ? "verified" as const : "failed" as const } : node) }),
    }))
    .addNode("repair", agentNode<ProgressiveLodState>({
      node: "repair", agent: options.implementerAgent,
      prompt: (state) => `Repair the verified failures in the current worktree, then run focused checks.\n\nTask: ${state.originalTask}\nVerification: ${JSON.stringify(state.verification)}\nPrior implementation: ${state.implementation}`,
      output: (text, state) => ({ implementation: `${state.implementation}\n\nRepair ${state.repairAttempts + 1}:\n${text}`, repairAttempts: state.repairAttempts + 1, phase: "verifying", callsUsed: state.callsUsed + 1, plan: state.plan.map((node) => node.status === "failed" ? { ...node, status: "implementing" as const } : node) }),
    }))
    .addNode("reopen", (state: ProgressiveLodState) => {
      const failed = new Set(state.verification?.failedNodeIds ?? []);
      const plan = state.plan.map((node) => failed.has(node.id) || (node.status === "failed" && !failed.size) ? { ...node, status: "pending" as const, lod: Math.max(0, node.lod - 1), reopenCount: node.reopenCount + 1 } : node);
      const active = selectActiveNode(plan);
      if (active) active.status = "active";
      return { plan, activeNodeId: active?.id, verification: undefined, phase: "planning" };
    })
    .addNode("finish", (state: ProgressiveLodState) => ({
      phase: state.verification?.passed ? "completed" : state.phase,
      result: state.verification?.passed ? `${state.implementation}\n\nVerification: ${state.verification.summary}` : `Implementation did not pass verification.\n\n${state.verification?.summary ?? "Planning budget exhausted before an implementable plan was produced."}\n\n${state.implementation}`,
    }))
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state: ProgressiveLodState) => state.profile?.route ?? "answer", { answer: "answer", change: "acquire" })
    .addEdge("answer", END).addConditionalEdges("acquire", (state: ProgressiveLodState) => state.plan.length ? "analyze" : "initialize", { analyze: "analyze", initialize: "initialize" }).addEdge("initialize", "analyze").addEdge("analyze", "merge")
    .addConditionalEdges("merge", (state: ProgressiveLodState) => state.humanQuestion ? "human" : state.activeNodeId ? (!budgetExceeded(state) ? "analyze" : "finish") : state.plan.some((node) => node.status === "ready" || node.status === "failed") ? "implement" : "finish", { human: "human", analyze: "analyze", implement: "implement", finish: "finish" })
    .addEdge("human", "acquire").addEdge("implement", "verify")
    .addConditionalEdges("verify", (state: ProgressiveLodState) => state.verification?.passed ? "finish" : state.verification?.architecturalMismatch && state.callsUsed < state.budget.calls - state.budget.reservedCalls ? "reopen" : state.verification?.repairable && state.repairAttempts < state.budget.repairs && state.callsUsed < state.budget.calls ? "repair" : "finish", { finish: "finish", reopen: "reopen", repair: "repair" })
    .addEdge("reopen", "analyze").addEdge("repair", "verify").addEdge("finish", END);
  return {
    graph: builder.compile({ checkpointer: options.checkpointer ?? defaultSqliteCheckpointer() }),
    initial: ({ task, directory, worktree, runId }) => ({ runId, originalTask: task, directory, worktree, phase: "classifying", lods: DEFAULT_LODS, budget: SCOPE_BUDGETS.unknown, plan: [], evidence: [], constraints: [], discoveries: [], callsUsed: 0, nextId: 1, startedAt: Date.now(), repairAttempts: 0, humanQuestion: "", humanAnswer: "", implementation: "", result: "" }),
    result: (state) => state.result,
    progress,
    display: { classify: { phase: "route", agent: analyst }, analyze: { phase: "expand", agent: analyst }, merge: { phase: "reduce" }, human: { phase: "decision" }, implement: { phase: "commit", agent: options.implementerAgent }, verify: { phase: "verify", agent: verifier }, repair: { phase: "repair", agent: options.implementerAgent } },
  };
}
