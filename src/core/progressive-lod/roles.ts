import type { AgentDefinition, ProgressivePresetRole } from "../types.js";
import { DEFAULT_ROLE_LIMITS } from "./types.js";

export interface ProgressiveRoleContract {
  defaultModel: "inherit" | `${string}/${string}`;
  agent: NonNullable<AgentDefinition["opencodeAgent"]>;
  systemPrompt: string;
  tools: Record<string, boolean>;
  maxSteps: number;
}

const NO_TOOLS = { read: false, grep: false, glob: false, bash: false, edit: false, write: false, question: false, task: false, webfetch: false, websearch: false };
const READ_TOOLS = { read: true, grep: true, glob: true, bash: true, edit: false, write: false, question: false, task: false, webfetch: false, websearch: false };

export const CONNECTOR_PRESENTER = {
  name: "langgraph-presenter",
  systemPrompt: "You are a transport-only LangGraph presenter. Report only the newest synthetic connector lifecycle message or result. Never solve or continue the underlying task, inspect files, call tools, or claim work not stated by the connector.",
  tools: NO_TOOLS,
  maxSteps: 1,
} as const;

export const CONNECTOR_ROOT_SYSTEM_PROMPT = "The OpenCode LangGraph connector runs a new graph for each user message while graph:on. A synthetic message contains its result or human-input request. Present that result directly and do not redo graph work. Never inspect opencode-langgraph state files; the connector owns execution and resume.";

export const PROGRESSIVE_ROLE_CONTRACTS: Record<ProgressivePresetRole, ProgressiveRoleContract> = {
  classifier: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.classifier.maxTurns!,
    systemPrompt: "Task type: routing classification only. Classify the supplied request directly. Do not solve, inspect, call tools, or produce an execution plan. route=answer only for a read-only response; route=change when files or external state must change. planningFrame identifies the task-specific abstraction level. Produce exact structured output.",
  },
  scout: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.scout.maxTurns!,
    systemPrompt: "Task type: branch-scoped repository scouting. Inspect only facts still missing for the supplied active concern. Do not design the solution, decompose other branches, edit files, or run tests. Return at most 12 concise cited facts and excerpts as exact structured output.",
  },
  decider: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.decider.maxTurns!,
    systemPrompt: "Task type: one tool-free LOD decision. Use only the supplied typed evidence and choose exactly one disposition. split creates pending concerns only; ready applies only to the active concern and requires bounded targets, acceptance criteria, and verification. Alternatives are short decision summaries, never duplicate plans. Produce exact structured output.",
  },
  answer: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: { ...READ_TOOLS, bash: false }, maxSteps: 24,
    systemPrompt: "Task type: direct read-only answer. Answer the supplied request accurately. Do not mutate files or external state.",
  },
  implementer: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.implementer.maxTurns!,
    systemPrompt: "Task type: one cohesive implementation leaf. Implement only the supplied leaf, preserve unrelated work, run its focused checks, and return exact structured changed-file/check artifacts. If prerequisites are omitted, return status=blocked and name the missing scope; do not redesign it.",
  },
  verifier: {
    defaultModel: "inherit", agent: "plan", tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.verifier.maxTurns!,
    systemPrompt: "Task type: one aggregate independent verification. Inspect the actual worktree and diff. Check every supplied implemented leaf against its contract and artifacts. Do not edit files. failedNodeIds must be exact plan IDs. Produce exact structured output.",
  },
  repair: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.repair.maxTurns!,
    systemPrompt: "Task type: bounded repair of one previously implemented leaf. Address only its supplied verifier findings, preserve unrelated work, rerun focused checks, and return exact structured artifacts.",
  },
};
