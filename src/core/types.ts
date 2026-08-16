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
  preset: "progressive-lod";
  options?: ProgressiveLodPresetOptions;
}

export type ProgressivePresetRole = "classifier" | "scout" | "decider" | "answer" | "implementer" | "verifier" | "repair";
export interface ProgressivePresetBudget {
  calls?: number; nodes?: number; contextCyclesPerNode?: number; reopens?: number; repairs?: number; minutes?: number;
  maxTurns?: number; maxInputTokens?: number; maxCacheReadTokens?: number; maxCost?: number;
}
export interface ProgressiveLodPresetOptions {
  models?: Partial<Record<ProgressivePresetRole, "inherit" | `${string}/${string}`>>;
  roleLimits?: Partial<Record<Exclude<ProgressivePresetRole, "answer">, AgentCallLimits>>;
  budgets?: Partial<Record<"local" | "subsystem" | "architectural" | "unknown", ProgressivePresetBudget>>;
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
  status: "pending" | "active" | "expanded" | "ready" | "implementing" | "implemented" | "verified" | "failed" | "removed";
  dependencies?: string[];
  evidence?: number;
  confidence?: number;
  agents?: string[];
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
  nodes: GraphProgressNode[];
}

export interface AgentRuntime {
  call(input: AgentCall): Promise<AgentCallResult>;
}
