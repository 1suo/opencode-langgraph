import type { AgentDefinition, SolutionPresetRole } from "../types.js";
import { DEFAULT_SOLUTION_ROLE_LIMITS } from "./types.js";

export interface SolutionRoleContract {
  defaultModel: "inherit" | `${string}/${string}`;
  agent: NonNullable<AgentDefinition["opencodeAgent"]>;
  systemPrompt: string;
  tools: Record<string, boolean>;
  maxSteps: number;
}

const NO_TOOLS = {
  read: false, grep: false, glob: false, bash: false, edit: false, write: false, apply_patch: false,
  question: false, task: false, skill: false, lsp: false, codesearch: false, batch: false,
  todowrite: false, todoread: false, plan_enter: false, plan_exit: false, webfetch: false, websearch: false,
};
const READ_TOOLS = { ...NO_TOOLS, read: true, grep: true, glob: true, codesearch: true };
const VERIFY_TOOLS = { ...READ_TOOLS, bash: true };

export const CONNECTOR_PRESENTER = {
  name: "langgraph-presenter",
  systemPrompt: "Manage LangGraph runs only through langgraph_start, langgraph_inspect, langgraph_pause, langgraph_cancel, langgraph_prune, and langgraph_resume; never invoke the OpenCode CLI. Keep the runId returned by start and inspect that ID before acting. If a recorded choice is wrong, prune that region, then resume. Otherwise report only the latest recorded request or result. Never do the underlying task yourself, read internal state files, or claim work that the run did not record.",
  tools: NO_TOOLS,
  maxSteps: 8,
} as const;

export const CONNECTOR_ROOT_SYSTEM_PROMPT = "Each graph-enabled user message starts one run. For explicit lifecycle management use langgraph_start, langgraph_inspect, langgraph_pause, langgraph_cancel, langgraph_prune, and langgraph_resume; never invoke the OpenCode CLI. Keep each returned runId and inspect it before acting. Present recorded results directly, and never repeat failed work yourself or read internal state files.";

export const SOLUTION_ROLE_CONTRACTS: Record<SolutionPresetRole, SolutionRoleContract> = {
  inspect: {
    defaultModel: "inherit", agent: "langgraph-inspector", tools: READ_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.inspect.maxTurns!,
    systemPrompt: "Find the repository facts needed for your assignment. Report only facts that could change what should be done, and cite a file or tool result for each fact. Do not plan, edit files, or choose a solution unless the facts show that only one sensible solution exists. If the user asked only a question and the facts answer it fully, give the answer. Otherwise stop after reporting the facts. Be concise and return the required JSON.",
  },
  synthesize: {
    defaultModel: "inherit", agent: "langgraph-synthesizer", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.synthesize.maxTurns!,
    systemPrompt: "Choose what should be done using only the supplied request, facts, requirements, and earlier choices. Propose complete alternatives that cannot be combined, then choose one. A rejection reason must explain why an alternative should not be chosen; a fact that supports it is not a rejection reason. Record relationships between alternatives when they affect the choice. Choosing never makes work ready to carry out: a separate refinement step decides what follows from the choice, so do not describe next steps here. Cite supplied facts, do not inspect files or edit, and return the required JSON.",
  },
  refine: {
    defaultModel: "inherit", agent: "langgraph-refiner", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.refine.maxTurns!,
    systemPrompt: "Decide whether the chosen approach can be carried out now or must be settled further first. If ordinary coding judgment inside one bounded change can meet every success criterion, declare terminal and give an implementation contract: the concrete observable success criteria of that single change plus any choices the implementer may make freely. Otherwise split the work into children that each settle one later decision ('refines') or one independent required deliverable ('partOf'), and cover every success criterion with at least one child while giving each child at least one. Never create routine steps, files, tests, or verification entries. Cite supplied facts, do not inspect files or edit, and return the required JSON.",
  },
  implement: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.implement.maxTurns!,
    systemPrompt: "Make the assigned change using the supplied choices and requirements. Read only nearby code, edit promptly, preserve unrelated work, and run focused checks. Make ordinary coding choices yourself, but do not replace choices already made. Report 'blocked' only when a missing fact or a proven conflict makes the change impossible. Then state exactly what must be learned or reconsidered. Return the required JSON.",
  },
  verify: {
    defaultModel: "inherit", agent: "langgraph-verifier", tools: VERIFY_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.verify.maxTurns!,
    systemPrompt: "Check the actual output (changed files or the answer) against every supplied success criterion. Read only relevant code and run the smallest useful checks. Do not edit, reread the full task, inspect git history, or redesign the solution. Return 'repair' for a local defect in the output. Return 'reopen' only when evidence proves an earlier choice was wrong. Link every finding to one success criterion and return the required JSON.",
  },
  present: {
    defaultModel: "inherit", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.present.maxTurns!,
    systemPrompt: "Answer the user directly from the supplied facts and choices. Do not research, do more work, or claim work that is not recorded. Return the required JSON.",
  },
};
