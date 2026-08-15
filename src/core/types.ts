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

export interface GraphDisplayNode {
  label?: string;
  phase?: string;
  color?: string;
  agent?: string;
}

export interface ConnectorGraph<State extends Record<string, unknown> = Record<string, unknown>> {
  graph: CompiledStateGraph<any, any, any, any, any, any, any, any, any>;
  initial(input: { task: string; directory: string; worktree: string; runId: string }): State;
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
}

export interface AgentCallResult {
  text: string;
  sessionId?: string;
  structured?: unknown;
  tools?: AgentToolTrace[];
  usage?: AgentUsage;
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
  status: "pending" | "active" | "ready" | "implementing" | "verified" | "failed" | "removed";
  dependencies?: string[];
  evidence?: number;
  confidence?: number;
}

export interface GraphProgressSnapshot {
  phase: string;
  scope?: string;
  activeNodeId?: string;
  callsUsed?: number;
  callBudget?: number;
  summary?: string;
  usage?: AgentUsage;
  nodes: GraphProgressNode[];
}

export interface AgentRuntime {
  call(input: AgentCall): Promise<AgentCallResult>;
}
