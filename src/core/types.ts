import type { CompiledStateGraph } from "@langchain/langgraph";

export interface OpenCodeModel {
  backend: "opencode";
  model: "inherit" | `${string}/${string}`;
  variant?: string;
}

export interface CommandModel {
  backend: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type ModelDefinition = OpenCodeModel | CommandModel;

export interface AgentDefinition {
  model: string;
  opencodeAgent?: string;
  systemPrompt: string;
  tools?: Record<string, boolean>;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
  maxSteps?: number;
}

export interface AgentUsage {
  turns: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface UsageStreamingEstimate {
  inputEstimated: number;
  outputEstimated: number;
}

export interface AgentPromptTrace {
  system: string;
  input: string;
  schemaInstruction?: string;
}

export interface AgentCallLimits {
  maxTurns?: number;
  maxInputTokens?: number;
  maxCacheReadTokens?: number;
  maxContextTokens?: number;
  maxCost?: number;
}

export interface AgentSessionDirective {
  strategy: "fresh" | "continue" | "fork";
  sessionId?: string;
}

export interface AgentBudgetStop {
  kind: "budget";
  metric: "turns" | "input" | "cacheRead" | "context" | "contextCycles" | "cost" | "calls" | "minutes";
  used: number;
  limit: number;
}

export interface GraphDisplayNode {
  label?: string;
  phase?: string;
  color?: string;
  agent?: string;
}

export interface ConnectorGraph<State extends Record<string, unknown> = Record<string, unknown>> {
  graph: CompiledStateGraph<any, any, any, any, any, any, any, any, any>;
  initial(input: { task: string; conversationContext?: string; directory: string; worktree: string; runId: string }): State;
  result?(state: State): string;
  progress?(state: State): GraphProgressSnapshot | undefined;
  display?: Record<string, GraphDisplayNode>;
}

export interface ConnectorDefinition {
  version: 1;
  models: Record<string, ModelDefinition>;
  agents: Record<string, AgentDefinition>;
  graphs: Record<string, ConnectorGraph>;
  defaultGraph: string;
}

export interface ConnectorPresetConfig {
  version: 1;
  preset: "solution-lod";
  options?: SolutionLodPresetOptions;
}

export type SolutionPresetRole = "inspect" | "synthesize" | "refine" | "implement" | "verify" | "present";
export type SolutionPresetModel = OpenCodeModel["model"] | ModelDefinition;
export type SolutionRoleModelAssignments = Partial<Record<SolutionPresetRole, ModelDefinition>>;
export interface AgentRuntimeTimeouts {
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
}
export interface SolutionLodPresetOptions {
  models?: Partial<Record<SolutionPresetRole, SolutionPresetModel>>;
  roleLimits?: Partial<Record<SolutionPresetRole, AgentCallLimits>>;
  roleTimeouts?: Partial<Record<SolutionPresetRole, AgentRuntimeTimeouts>>;
  maxParallelActivations?: number;
  maxActivations?: number;
}

export type ConnectorConfig = ConnectorDefinition | ConnectorPresetConfig;

export interface AgentCall {
  agent: string;
  prompt: string;
  node: string;
  state: Record<string, unknown>;
  schema?: Record<string, unknown>;
  schemaName?: string;
  retryCount?: number;
  validateStructured?: (value: unknown) => unknown;
  session?: AgentSessionDirective;
  limits?: AgentCallLimits;
  directory?: string;
  worktree?: string;
}

export interface AgentCallResult {
  text: string;
  sessionId?: string;
  structured?: unknown;
  tools?: AgentToolTrace[];
  usage?: AgentUsage;
  budgetStop?: AgentBudgetStop;
  retryTrace?: AgentRetryTrace[];
}

export interface AgentRetryTrace {
  kind: "startup" | "transport" | "inactivity" | "schema" | "semantic";
  message: string;
  action: "fresh" | "continue" | "fork" | "none";
  sessionId?: string;
  usage?: AgentUsage;
  tools?: AgentToolTrace[];
  progressText?: string;
}

export interface AgentToolTrace {
  tool: string;
  status: "completed" | "error";
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphProgressNode {
  id: string;
  parentId?: string;
  title: string;
  level: string;
  depth: number;
  status: string;
  dependencies?: string[];
  evidence?: number;
  confidence?: number;
  agents?: string[];
  operation?: string;
  domainPhase?: string;
  domainFingerprint?: string | null;
  acceptedFingerprint?: string | null;
  cegarRound?: number;
  challengeVerdict?: string | null;
  viable?: number;
  selectedCandidateId?: string;
  blockedReason?: string;
}

export interface SolutionSemanticSnapshot {
  kind: "solution-lod-v2";
  revision: number;
  regions: Array<{ id: string; key: string; parentId?: string; edge: "root" | "refines" | "partOf"; lod: number; objective: string; status: string; viable: number; total: number; selectedCandidateIds: string[]; candidateIds: string[]; constraintIds: string[]; evidenceIds: string[]; activationIds: string[]; artifactIds: string[]; scopeId?: string; domainPhase?: string; domainFingerprint?: string | null; acceptedFingerprint?: string | null; cegarRound?: number; challengeVerdict?: string | null; blockedReason?: string }>;
  candidates: Array<{ id: string; regionId: string; proposition: string; status: string; eliminationReasons: string[]; evidenceIds: string[]; stances?: Array<{ variableId: string; relation: string; valueLabel: string }> }>;
  constraints: Array<{ id: string; kind: string; subject: string; target: string; reason: string; sourceKind?: string; evidenceRefs?: string[] }>;
  evidence: Array<{ id: string; text: string; source: string; kind: string; status?: string; validationEvidenceRefs?: string[]; validationReason?: string }>;
  activations: Array<{ id: string; capability: string; regionId: string; request: string; expectedDelta: string; senderActivationId?: string; status: string; error?: string; operation?: string; domainFingerprint?: string | null }>;
  artifacts: Array<{ id: string; regionId: string; kind: string; path?: string; summary: string; passed?: boolean; activationId: string }>;
}

export interface GraphProgressSnapshot {
  phase: string;
  scope?: string;
  activeNodeId?: string;
  callsUsed?: number;
  callBudget?: number;
  costBudget?: number;
  summary?: string;
  usage?: AgentUsage;
  telemetry?: import("./solution-lod/types.js").SolutionTelemetry;
  semantic?: SolutionSemanticSnapshot;
  nodes: GraphProgressNode[];
}

export interface AgentRuntime {
  call(input: AgentCall): Promise<AgentCallResult>;
}
