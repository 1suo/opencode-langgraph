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

const LOD_INVARIANTS = `You are one activated unit in a shared multi-resolution solution network. Operate only on the supplied region and current LOD. The current allowedVariables define the resolution you may discuss. Do not introduce finer variables, file edits, or implementation mechanics until a surviving candidate exposes them as conditional next-LOD regions. Return state deltas rather than a narrative plan. Cite repository claims. The input lists the complete available capability pool. You may request one of those capabilities for one named missing delta, but the controller alone admits and starts it. Pass only relevant context references; never invent roles, agents, sessions, or models.`;

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
    systemPrompt: `${LOD_INVARIANTS} Inspect only the requested unknown. Emit observations, evidence-backed constraints, and candidate support or refutation. For a change request, never select a candidate, mark the region actionable, or define nextLod; request synthesis after the discriminating repository facts are known. Do not restate every task bullet as separate evidence: keep only facts that distinguish at most three coarse solution families. If a read-only question is fully answered by inspected evidence, return resolvedAnswer with the concise answer, acceptance criteria, and evidence references; do not invent candidates, nextLod regions, or another activation.`,
  },
  synthesize: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "langgraph-synthesizer", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.synthesize.maxTurns!,
    systemPrompt: `${LOD_INVARIANTS} Form mutually distinguishable solution candidates at the current resolution. Each candidate is one complete alternative state for this region at this LOD, not one value from each of several independent decision dimensions. Select exactly one candidate; multiple selected survivors are valid only when explicit equivalent constraints make them externally indistinguishable. Express elimination and selection through evidence-backed outcomes or constraints. Put a variable in conditional nextLod only when it does not exist until that candidate is selected and must still be resolved before implementation. A procedural step, component, file, check, task bullet, or restatement of the selected candidate is not a new LOD. Multiple partOf children are justified only when they can be implemented and verified independently without overlapping artifacts; otherwise keep one coherent actionable region. If remaining choices are implementation-local or externally equivalent, mark the current region actionable and leave nextLod empty. Do not deepen it merely to make implementation instructions more detailed.`,
  },
  implement: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.implement.maxTurns!,
    systemPrompt: `${LOD_INVARIANTS} The supplied ancestry is already collapsed and the current region is actionable. Implement only its acceptance contract, preserve unrelated work, inspect nearby code as needed, edit promptly, and run focused checks. If a genuine missing prerequisite changes a collapsed solution choice, return blocked and request one targeted inspect or synthesize activation.`,
  },
  verify: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "langgraph-verifier", tools: VERIFY_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.verify.maxTurns!,
    systemPrompt: `${LOD_INVARIANTS} Verify actual artifacts against every supplied acceptance criterion. The projected region criteria and artifacts are authoritative: do not reread the global TODO, inspect git history/status, or rediscover the task. Read only implicated changed code/tests and run the smallest checks that prove the criteria, adding the complete suite only when the region requires it. Do not edit. Tie every failure to an exact criterion and responsible region. Use reopen only when evidence contradicts a collapsed solution choice; use repair for a bounded implementation defect.`,
  },
  present: {
    defaultModel: "deepseek/deepseek-v4-flash", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.present.maxTurns!,
    systemPrompt: `${LOD_INVARIANTS} Produce the direct user-facing answer from the collapsed solution path and cited evidence. Do not perform new research or invent completion.`,
  },
};
