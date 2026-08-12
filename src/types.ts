export type Route = "trivial" | "simple" | "complex" | "exploratory";
export type NodeStatus = "pending" | "active" | "completed" | "retrying" | "failed" | "interrupted";

export interface Candidate<T = unknown> {
  id: string;
  value: T;
  score?: number;
  errors: string[];
}

export interface FileContext {
  path: string;
  content: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface AuditEvent {
  at: string;
  runId: string;
  type: "run" | "node" | "runner" | "validation" | "log";
  node?: string;
  status?: NodeStatus;
  message?: string;
  data?: unknown;
}

export interface RunnerConfig {
  command: string;
  args: string[];
  model: string;
}

export interface NeolitConfig {
  candidates: number;
  retries: number;
  contextFiles: number;
  contextBytes: number;
  trusted: RunnerConfig;
  hostile: RunnerConfig;
  validation: Array<{ name: string; command: string; args: string[] }>;
}

export interface RunPaths {
  root: string;
  audit: string;
  artifacts: string;
  checkpoint: string;
  patch: string;
}

export interface PipelineState {
  runId: string;
  task: string;
  repo: string;
  worktree: string;
  route: Route;
  context: FileContext[];
  requirementIds: string[];
  rephrasing: string;
  plan: string;
  detail: string;
  skeletonFiles: Record<string, string>;
  report: string;
  patch: string;
  attempts: number;
  validation: ValidationResult;
  error: string;
}
