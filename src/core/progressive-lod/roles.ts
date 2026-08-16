import type { AgentDefinition, ProgressivePresetRole } from "../types.js";
import { DEFAULT_ROLE_LIMITS } from "./types.js";

export interface ProgressiveRoleContract {
  defaultModel: "inherit" | `${string}/${string}`;
  agent: NonNullable<AgentDefinition["opencodeAgent"]>;
  systemPrompt: string;
  tools: Record<string, boolean>;
  maxSteps: number;
}

const NO_TOOLS = {
  read: false,
  grep: false,
  glob: false,
  bash: false,
  edit: false,
  write: false,
  apply_patch: false,
  question: false,
  task: false,
  skill: false,
  lsp: false,
  codesearch: false,
  batch: false,
  todowrite: false,
  todoread: false,
  plan_enter: false,
  plan_exit: false,
  webfetch: false,
  websearch: false,
};
const READ_TOOLS = { ...NO_TOOLS, read: true, grep: true, glob: true };
const VERIFY_TOOLS = { ...READ_TOOLS, bash: true };

export const CONNECTOR_PRESENTER = {
  name: "langgraph-presenter",
  systemPrompt: "You are a transport-only LangGraph presenter. Report only the newest synthetic connector lifecycle message or result. Never solve or continue the underlying task, inspect files, call tools, or claim work not stated by the connector.",
  tools: NO_TOOLS,
  maxSteps: 1,
} as const;

export const CONNECTOR_ROOT_SYSTEM_PROMPT = "The OpenCode LangGraph connector runs a new graph for each user message while graph:on. A synthetic message contains its result or human-input request. Present that result directly and do not redo graph work. Never inspect opencode-langgraph state files; the connector owns execution and resume.";

export const SCOUT_OPENCODE_AGENT = "langgraph-scout";
export const VERIFIER_OPENCODE_AGENT = "langgraph-verifier";
export const CLASSIFIER_OPENCODE_AGENT = "langgraph-classifier";
export const DECIDER_OPENCODE_AGENT = "langgraph-decider";

export const PROGRESSIVE_ROLE_CONTRACTS: Record<ProgressivePresetRole, ProgressiveRoleContract> = {
  classifier: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: CLASSIFIER_OPENCODE_AGENT, tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.classifier.maxTurns!,
    systemPrompt: "Route the request without solving it. Use answer for read-only responses, direct_change when one build agent can discover and complete an already bounded change, and planned_change only when repository research or decomposition is needed before implementation. Include questions only for planned_change; omit them for answer and direct_change.",
  },
  scout: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: SCOUT_OPENCODE_AGENT, tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.scout.maxTurns!,
    systemPrompt: "Answer only the supplied concern questions from repository evidence. Do not design, decompose, edit, or run tests. Return concise sourced facts, constraints, and anything still unknown. Cite repository facts as path:line; unsupported conclusions remain inference.",
  },
  decider: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: DECIDER_OPENCODE_AGENT, tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.decider.maxTurns!,
    systemPrompt: "Given the task, active concern, architectural constraints, evidence, dependencies, and ancestry supplied here, advance exactly one engineering-planning edge. Never implement, solve the task, or recursively expand a subtree. Choose ready only when no further detail is needed and emit a concise handoff contract for a separate implementer; refine with the single next unanswered concern; split into only the immediate independent child concerns and their dependencies; otherwise remove, reopen_parent, or interrupt for indispensable user input. Carry only facts needed by the next role; do not repeat operating protocol, evidence prose, or the whole task. Treat inference as uncertain and do not inspect the repository.",
  },
  answer: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: { ...READ_TOOLS, bash: false }, maxSteps: 24,
    systemPrompt: "Task type: direct read-only answer. Answer the supplied request accurately. Do not mutate files or external state.",
  },
  implementer: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.implementer.maxTurns!,
    systemPrompt: "Complete the supplied implementation contract, preserve unrelated work, and run focused checks. Return changed files and check results. If the contract is not implementable as given, return blocked with the missing prerequisite instead of redesigning it.",
  },
  verifier: {
    defaultModel: "inherit", agent: VERIFIER_OPENCODE_AGENT, tools: VERIFY_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.verifier.maxTurns!,
    systemPrompt: "Independently inspect the supplied disposable worktree and verify every contract, including running appropriate checks. Use only relative paths inside the current workspace; never inspect absolute or external paths. Do not edit intentionally. Return pass, repair for bounded defects, replan for a wrong or incomplete contract, or fail for a non-repairable result. Findings must name exact leaf IDs.",
  },
  repair: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.repair.maxTurns!,
    systemPrompt: "Repair only the supplied findings in this continued implementation session, preserve unrelated work, and rerun focused checks. Return changed files and check results.",
  },
};
