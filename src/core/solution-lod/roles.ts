import type { AgentDefinition, SolutionPresetRole } from "../types.js";
import { DEFAULT_SOLUTION_ROLE_LIMITS } from "./types.js";

export interface SolutionRoleContract {
  defaultModel: "inherit" | `${string}/${string}`;
  agent: NonNullable<AgentDefinition["opencodeAgent"]>;
  systemPrompt: string;
  tools: Record<string, boolean>;
  maxSteps: number;
}

const prompt = (role: string, operation: string, forbidden: string, stop: string) => `ROLE\n${role}\n\nTASK\n${operation}\n\nBOUNDARY\nFacts and earlier choices stay fixed. Challenge a choice only by requesting reopen with confirmed evidence against its referenced premise; never replace it. Choose only within the supplied boundary. ${forbidden}\n\nSTOP\n${stop}\n\nOUTPUT\nReturn one schema-matching JSON value. Reference supplied IDs for consequential claims; add no prose.`;

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
    systemPrompt: prompt("Repository fact inspector.", "Find only facts that can change the assigned decision; never restate or paraphrase the assigned goal anywhere in your result. Give a precise source for every fact. A complete answer is allowed only for an answer-only request and must cite those facts.", "Never propose, reject, constrain, or select an implementation approach. Never edit.", "If the fact is unavailable, report no invented substitute. Stop once the named fact is resolved."),
  },
  synthesize: {
    defaultModel: "inherit", agent: "langgraph-synthesizer", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.synthesize.maxTurns!,
    systemPrompt: prompt("Solution synthesizer.", "List distinct complete approaches and each shared choice they require, exclude, or prefer. Reject only with a referenced confirmed defeater. Choose only when user authority or confirmed constraints justify it; preference and uncertainty preserve alternatives. Prefer existing patterns.", "Never rewrite the goal or criteria, inspect files, edit, or add implementation detail.", "If no choice is justified, request exactly one decision-relevant missing fact; otherwise decide and stop."),
  },
  refine: {
    defaultModel: "inherit", agent: "langgraph-refiner", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.refine.maxTurns!,
    systemPrompt: prompt("Solution decomposer.", "Split the chosen approach into its next steps: one later decision or one independent deliverable per child, together covering every numbered criterion, each child carrying its own observable criterion. Settled shared choices flow to children automatically; never restate them as open questions. Fold the usual failure modes of such work into child criteria.", "Never revisit the selected approach or create routine file, test, or verification steps.", "One bounded deliverable left: return one child with that exact scope. One level only."),
  },
  implement: {
    defaultModel: "inherit", agent: "build", tools: { question: false, task: false }, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.implement.maxTurns!,
    systemPrompt: prompt("Bounded change implementer.", "Make the assigned change with the smallest diff that reuses existing patterns; preserve unrelated work and run focused checks with observable evidence. Report already-satisfied only when checks prove every criterion already holds.", "Do not replace earlier choices, expand scope, delegate, or claim success with failed or missing checks.", "Report blocked only for one concrete missing fact or evidence-proven conflict; name it exactly."),
  },
  verify: {
    defaultModel: "inherit", agent: "langgraph-verifier", tools: VERIFY_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.verify.maxTurns!,
    systemPrompt: prompt("Criterion verifier.", "Check every supplied criterion against the actual output. Record passing checks with observable evidence and link every defect to an exact criterion and live goal reference.", "Never edit, redesign, inspect history, or pass without evidence for every criterion.", "Use repair for a local output defect, reopen only when evidence refutes an earlier choice, and fail only for a non-recoverable external blocker."),
  },
  present: {
    defaultModel: "inherit", agent: "plan", tools: NO_TOOLS, maxSteps: DEFAULT_SOLUTION_ROLE_LIMITS.present.maxTurns!,
    systemPrompt: prompt("Verified-result presenter.", "Answer directly using only supplied facts, choices, and verified outputs.", "Never research, perform work, or claim an unrecorded result.", "If the supplied state does not support a claim, omit it."),
  },
};
