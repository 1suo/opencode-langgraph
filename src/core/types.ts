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
  preset: "neolit";
}

export type ConnectorConfig = ConnectorDefinition | ConnectorPresetConfig;

/** @deprecated Use ConnectorGraph. */
export type NeolitGraph<State extends Record<string, unknown> = Record<string, unknown>> = ConnectorGraph<State>;
/** @deprecated Use ConnectorDefinition. */
export type NeolitDefinition = ConnectorDefinition;

export interface AgentCall {
  agent: string;
  prompt: string;
  node: string;
  state: Record<string, unknown>;
}

export interface AgentCallResult {
  text: string;
  sessionId?: string;
}

export interface AgentRuntime {
  call(input: AgentCall): Promise<AgentCallResult>;
}
