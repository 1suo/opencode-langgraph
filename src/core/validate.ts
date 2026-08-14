import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { ConnectorDefinition } from "./types.js";

export type DiagnosticCode = "CONFIG" | "REFERENCE" | "GRAPH" | "TERMINATION" | "MODEL" | "COMMAND";
export interface Diagnostic { code: DiagnosticCode; severity: "error" | "warning"; path: string; message: string }

function executable(command: string): boolean {
  if (command.includes(path.sep)) {
    try { accessSync(command, constants.X_OK); return true; } catch { return false; }
  }
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try { accessSync(path.join(dir, command), constants.X_OK); return true; } catch { return false; }
  });
}

export async function validateConnector(definition: ConnectorDefinition): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  if (definition.version !== 1) diagnostics.push({ code: "CONFIG", severity: "error", path: "version", message: "Only config version 1 is supported" });
  if (!definition.graphs[definition.defaultGraph]) diagnostics.push({ code: "REFERENCE", severity: "error", path: "defaultGraph", message: `Unknown graph: ${definition.defaultGraph}` });
  for (const [name, agent] of Object.entries(definition.agents)) {
    if (!definition.models[agent.model]) diagnostics.push({ code: "REFERENCE", severity: "error", path: `agents.${name}.model`, message: `Unknown model: ${agent.model}` });
    if (definition.models[agent.model]?.backend === "opencode" && agent.tools?.question !== false) diagnostics.push({ code: "MODEL", severity: "error", path: `agents.${name}.tools.question`, message: "OpenCode child agents must disable the question tool; use LangGraph interrupt() for human input" });
  }
  for (const [name, model] of Object.entries(definition.models)) {
    if (model.backend === "opencode" && model.model !== "inherit" && !model.model.includes("/")) diagnostics.push({ code: "MODEL", severity: "error", path: `models.${name}`, message: "OpenCode model must be inherit or provider/model" });
    if (model.backend === "command" && !executable(model.command)) diagnostics.push({ code: "COMMAND", severity: "error", path: `models.${name}.command`, message: `Executable not found: ${model.command}` });
  }
  for (const [name, configured] of Object.entries(definition.graphs)) {
    if (!configured.graph.checkpointer) diagnostics.push({ code: "GRAPH", severity: "error", path: `graphs.${name}`, message: "Graph must be compiled with a checkpointer for interrupts and resume" });
    try { configured.graph.validate(); } catch (error) {
      diagnostics.push({ code: "GRAPH", severity: "error", path: `graphs.${name}`, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    try {
      const drawable = await configured.graph.getGraphAsync();
      const json = drawable.toJSON() as { nodes: Array<{ id: string }> | Record<string, unknown>; edges: Array<{ source: string; target: string }> };
      const nodes = Array.isArray(json.nodes) ? json.nodes.map((node) => node.id) : Object.keys(json.nodes);
      const reverse = new Map<string, string[]>();
      for (const edge of json.edges) reverse.set(edge.target, [...(reverse.get(edge.target) ?? []), edge.source]);
      const terminating = new Set<string>(["__end__"]);
      const queue = ["__end__"];
      while (queue.length) for (const source of reverse.get(queue.shift()!) ?? []) if (!terminating.has(source)) { terminating.add(source); queue.push(source); }
      for (const node of nodes.filter((id) => id !== "__start__" && id !== "__end__" && !terminating.has(id))) diagnostics.push({ code: "TERMINATION", severity: "error", path: `graphs.${name}.${node}`, message: "Reachable node has no declared path to END" });
    } catch (error) {
      diagnostics.push({ code: "GRAPH", severity: "error", path: `graphs.${name}`, message: `Cannot inspect graph: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}

export function assertValidConnector(diagnostics: Diagnostic[]): void {
  const errors = diagnostics.filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => `${item.code} ${item.path}: ${item.message}`).join("\n"));
}

/** @deprecated Use validateConnector. */
export const validateNeolit = validateConnector;
/** @deprecated Use assertValidConnector. */
export const assertValidNeolit = assertValidConnector;
