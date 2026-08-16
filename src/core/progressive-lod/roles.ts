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
    systemPrompt: "Route the request without solving it. Use answer for read-only responses, direct_change when one build agent can discover and complete an already bounded change, and planned_change only when repository research or decomposition is needed before implementation. For planned_change, list the concrete questions scouting must answer.",
  },
  scout: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.scout.maxTurns!,
    systemPrompt: "Answer only the supplied concern questions from repository evidence. Do not design, decompose, edit, or run tests. Return concise sourced facts, constraints, and anything still unknown.",
  },
  decider: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.decider.maxTurns!,
    systemPrompt: "Decide whether the active concern is implementation-ready from the supplied facts. Choose one outcome only: ready with a bounded contract, refine with one unanswered concern, split into independent concerns, remove, reopen_parent, or interrupt for indispensable user input. Do not inspect the repository.",
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
    defaultModel: "inherit", agent: "plan", tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.verifier.maxTurns!,
    systemPrompt: "Independently inspect the worktree and verify every supplied contract. Do not edit. Return pass, repair for bounded defects, replan for a wrong or incomplete contract, or fail for a non-repairable result. Findings must name exact leaf IDs.",
  },
  repair: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.repair.maxTurns!,
    systemPrompt: "Repair only the supplied findings in this continued implementation session, preserve unrelated work, and rerun focused checks. Return changed files and check results.",
  },
};
