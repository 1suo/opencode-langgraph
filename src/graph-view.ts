import { renderMermaidASCII } from "beautiful-mermaid";
import type { NodeStatus } from "./types.js";

const icon: Record<NodeStatus, string> = { pending: "○", active: "▶", completed: "✓", retrying: "↻", failed: "×", interrupted: "!" };

function id(value: string): string { return `n_${value.replace(/[^A-Za-z0-9_]/g, "_")}`; }

export async function graphData(compiled: { getGraphAsync(): Promise<unknown> }) {
  const drawable = await compiled.getGraphAsync() as { nodes: Record<string, unknown>; edges: Array<{ source: string; target: string; data?: string; conditional?: boolean }>; drawMermaid(): string; toJSON(): unknown };
  return drawable;
}

export async function statusMermaid(compiled: { getGraphAsync(): Promise<unknown> }, statuses: Map<string, NodeStatus>, focus = false): Promise<string> {
  const graph = await graphData(compiled);
  const allNodes = Object.keys(graph.nodes);
  let visible = new Set(allNodes);
  if (focus) {
    const active = [...statuses].filter(([, status]) => status === "active" || status === "retrying").map(([name]) => name);
    if (active.length) {
      visible = new Set(active);
      for (const edge of graph.edges) if (active.includes(edge.source) || active.includes(edge.target)) { visible.add(edge.source); visible.add(edge.target); }
    }
  }
  const lines = ["graph TD"];
  for (const name of allNodes) {
    if (!visible.has(name)) continue;
    const status = name === "__start__" || name === "__end__" ? "pending" : statuses.get(name) ?? "pending";
    const label = name === "__start__" ? "START" : name === "__end__" ? "END" : `${icon[status]} ${name.replaceAll("_", " ")}`;
    lines.push(`  ${id(name)}["${label}"]`);
  }
  for (const edge of graph.edges) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    lines.push(`  ${id(edge.source)} --> ${id(edge.target)}`);
  }
  return lines.join("\n");
}

export async function asciiGraph(compiled: { getGraphAsync(): Promise<unknown> }, statuses = new Map<string, NodeStatus>(), focus = false, width = 120): Promise<string> {
  const mermaid = await statusMermaid(compiled, statuses, focus);
  return renderMermaidASCII(mermaid, { colorMode: "none", paddingX: width < 100 ? 2 : 4, paddingY: width < 80 ? 1 : 2, boxBorderPadding: 0 });
}
