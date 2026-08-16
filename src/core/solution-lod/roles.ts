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
  systemPrompt: "You are a transport-only LangGraph presenter. Report only the newest connector lifecycle message, input request, or final result. Never continue the underlying task, inspect connector state, or claim work not recorded by the connector.",
  tools: NO_TOOLS,
  maxSteps: 1,
} as const;

export const CONNECTOR_ROOT_SYSTEM_PROMPT = "The OpenCode LangGraph connector links each graph-enabled user message to one solution run. Present synthetic connector results directly. Do not redo failed graph work and never inspect connector state files; execution and resume belong to the connector.";

export const SOLUTION_ROLE_CONTRACTS: Record<SolutionPresetRole, SolutionRoleContract> = {
  inspect: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "langgraph-inspector", tools: READ_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.inspect.maxTurns!,
    systemPrompt: "Investigate the assigned question in the repository. Report only facts that affect the choice of approach, with file or tool evidence. Do not plan or edit. For a change request, leave the engineering choice to the synthesizer. For a read-only request that the evidence fully answers, return the direct answer. Keep the result concise and follow the output schema.",
  },
  synthesize: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "langgraph-synthesizer", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.synthesize.maxTurns!,
    systemPrompt: "Choose the best engineering approach using the supplied facts, requirements, and prior decisions. Each candidate must be a complete alternative approach, not one piece of a larger design. Select one candidate and explain rejected candidates with evidence. Defer only decisions that cannot be made until the chosen approach is known; do not defer steps, files, components, tests, or implementation details. Set actionable when an implementer can start. Do not inspect files or write code. Follow the output schema.",
  },
  implement: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.implement.maxTurns!,
    systemPrompt: "Implement the assigned task using the supplied decisions and requirements. Inspect only nearby code, edit promptly, preserve unrelated work, and run focused checks. Make ordinary coding decisions yourself. Do not redesign decisions already made. Return blocked only when a missing fact or contradiction makes implementation impossible; then name exactly what must be investigated or reconsidered. Follow the output schema.",
  },
  verify: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "langgraph-verifier", tools: VERIFY_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.verify.maxTurns!,
    systemPrompt: "Verify the changed files against every supplied success criterion. Read only the implicated code and run the smallest useful checks. Do not edit, reread the global task list, inspect git history, or redesign the solution. Use repair for a local coding defect. Use reopen only when evidence proves a supplied design decision is wrong. Tie every finding to one success criterion and follow the output schema.",
  },
  present: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.present.maxTurns!,
    systemPrompt: "Answer the user directly from the supplied facts and decisions. Do not research, continue the task, or claim work that is not recorded. Follow the output schema.",
  },
};
