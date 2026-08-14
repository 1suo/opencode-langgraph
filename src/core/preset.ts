import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { agentNode } from "./agent-node.js";
import type { ConnectorGraph } from "./types.js";

const checkpointer = new MemorySaver();

export interface CoolingState extends Record<string, unknown> {
  runId: string;
  task: string;
  directory: string;
  worktree: string;
  route: "answer" | "task";
  context: string;
  plan: string;
  result: string;
}

const CoolingState = Annotation.Root({
  runId: Annotation<string>,
  task: Annotation<string>,
  directory: Annotation<string>,
  worktree: Annotation<string>,
  route: Annotation<"answer" | "task">,
  context: Annotation<string>,
  plan: Annotation<string>,
  result: Annotation<string>,
});

export interface ProgressiveCoolingOptions {
  contextAgent: string;
  plannerAgent: string;
  implementerAgent: string;
  answerAgent?: string;
}

export function progressiveCoolingGraph(options: ProgressiveCoolingOptions): ConnectorGraph<CoolingState> {
  const builder = new StateGraph(CoolingState)
    .addNode("classify", (state: CoolingState) => ({ route: /\?|^(what|why|how|where|when|who|explain)\b/i.test(state.task.trim()) ? "answer" as const : "task" as const }))
    .addNode("answer", agentNode<CoolingState>({
      node: "answer", agent: options.answerAgent ?? options.plannerAgent,
      prompt: (state) => `Answer the user directly. Inspect the repository only when relevant. Do not edit files.\n\nTask: ${state.task}`,
      output: "result",
    }))
    .addNode("accumulate_context", agentNode<CoolingState>({
      node: "accumulate_context", agent: options.contextAgent,
      prompt: (state) => `Inspect the repository and produce a concise shared context brief. Include relevant files, constraints, and uncertainties. Do not edit files and do not solve the task.\n\nTask: ${state.task}`,
      output: "context",
    }))
    .addNode("collapse_plan", agentNode<CoolingState>({
      node: "collapse_plan", agent: options.plannerAgent,
      prompt: (state) => `Produce the smallest grounded implementation plan. Collapse alternatives into one decision-complete approach. Do not edit files.\n\nTask: ${state.task}\n\nShared context:\n${state.context}`,
      output: "plan",
    }))
    .addNode("implement", agentNode<CoolingState>({
      node: "implement", agent: options.implementerAgent,
      prompt: (state) => `Implement and verify this task in the current worktree. Use the supplied plan and context, inspect files as needed, and return a concise final result listing changed files and checks.\n\nTask: ${state.task}\n\nShared context:\n${state.context}\n\nPlan:\n${state.plan}`,
      output: "result",
    }))
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (state: CoolingState) => state.route, { answer: "answer", task: "accumulate_context" })
    .addEdge("answer", END)
    .addEdge("accumulate_context", "collapse_plan")
    .addEdge("collapse_plan", "implement")
    .addEdge("implement", END);
  return {
    graph: builder.compile({ checkpointer }),
    initial: ({ task, directory, worktree, runId }) => ({ runId, task, directory, worktree, route: "task", context: "", plan: "", result: "" }),
    result: (state) => state.result,
    display: {
      classify: { label: "route", phase: "expand" },
      answer: { label: "answer", phase: "direct", agent: options.answerAgent ?? options.plannerAgent },
      accumulate_context: { label: "shared context", phase: "expand", agent: options.contextAgent },
      collapse_plan: { label: "collapse plan", phase: "cool", agent: options.plannerAgent },
      implement: { label: "implement + verify", phase: "commit", agent: options.implementerAgent },
    },
  };
}
