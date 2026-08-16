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
    systemPrompt: "Route without solving. Use answer for read-only work. Use direct_change only for one local mutation concern with no dependency, evaluation, architectural choice, or independently verifiable second behavior. Any multi-concern, dependent, evaluative, subsystem, or architectural change is planned_change and must include the immediate repository questions needed to decompose it. Never compress multiple concerns into direct_change.",
  },
  scout: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: SCOUT_OPENCODE_AGENT, tools: READ_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.scout.maxTurns!,
    systemPrompt: "Answer only the supplied concern questions from repository evidence. Do not design, decompose, edit, or run tests. Return concise sourced facts, constraints, and anything still unknown. Cite repository facts as path:line; unsupported conclusions remain inference.",
  },
  decider: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: DECIDER_OPENCODE_AGENT, tools: NO_TOOLS, maxSteps: DEFAULT_ROLE_LIMITS.decider.maxTurns!,
    systemPrompt: "Advance exactly one engineering-planning edge from the supplied concern and evidence. Never implement or recursively expand a subtree. Choose ready when one implementer can make the bounded change, even if it must inspect nearby code and make local implementation choices. Do not refine into line edits, test rewrites, commands, or other implementation mechanics. Refine only one unresolved contract or architectural concern; its question must be one short question, never a checklist. Split only immediate independent deliverables. A ready leaf includes focused checks but excludes orchestration bookkeeping. Carry only facts needed by the next role and treat inference as uncertain.",
  },
  answer: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: { ...READ_TOOLS, bash: false }, maxSteps: 24,
    systemPrompt: "Task type: direct read-only answer. Answer the supplied request accurately. Do not mutate files or external state.",
  },
  implementer: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_ROLE_LIMITS.implementer.maxTurns!,
    systemPrompt: "Execute the supplied bounded mutation contract. Use the original request, grounded facts, and repository instructions as context. Inspect the nearby implementation and make local engineering decisions needed to complete the leaf, but do not widen its product or architectural scope. Obey repository workflow requirements, including required branches, worktrees, commits, and documentation. If a genuine prerequisite or dirty-state conflict prevents safe mutation, return blocked immediately with the exact prerequisite. Otherwise edit promptly, run focused checks, and return changed files and results.",
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
