/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import path from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { loadConnectorDefinition } from "../core/config.js";
import type { AgentUsage, ModelDefinition, SolutionPresetRole, SolutionRoleModelAssignments, SolutionSemanticSnapshot, UsageStreamingEstimate } from "../core/types.js";
import { adoptHomeGraphState, listAllRuns, readHomeGraphState, readLatestProjectEvents, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readSessionGraphState, readStoredRun, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphModelAssignments, writeSessionGraphName, type PluginRunEvent } from "./store.js";

function sessionId(api: TuiPluginApi): string | undefined {
  const value = api.route.current.name === "session" && "params" in api.route.current ? api.route.current.params?.sessionID : undefined;
  return typeof value === "string" ? value : undefined;
}

function openGraph(api: TuiPluginApi, fallbackSessionId?: string, userMessageId?: string, runId?: string): void {
  const id = sessionId(api) ?? fallbackSessionId;
  api.route.navigate("langgraph.graph", id || runId ? { sessionID: id, ...(userMessageId ? { messageID: userMessageId } : {}), ...(runId ? { runID: runId } : {}) } : undefined);
}

export function openMessageGraph(api: TuiPluginApi, rootSessionId: string, userMessageId: string): void {
  openGraph(api, rootSessionId, userMessageId);
}

function latest(events: PluginRunEvent[]): PluginRunEvent[] {
  const runId = latestRunId(events);
  if (!runId) return [];
  const byNode = new Map<string, PluginRunEvent>();
  for (const event of events) if (event.runId === runId) byNode.set(event.node, event);
  return [...byNode.values()];
}

function latestRunId(events: PluginRunEvent[]): string | undefined {
  return events.findLast((event) => event.node === "__start__")?.runId ?? events.at(-1)?.runId;
}

interface AsciiGraph {
  width: number;
  height: number;
  canvas: string;
}

export interface GraphControls {
  back(): void;
  cycle(): void;
  tree(): void;
  detail(): void;
  runs(): void;
  output(): void;
  prompt(): void;
  inspect(): void;
  up(): void;
  down(): void;
  left(): void;
  right(): void;
  pageUp(): void;
  pageDown(): void;
  home(): void;
  end(): void;
}

export function graphNavigationLayer(controls: GraphControls) {
  return {
    commands: [
      { name: "langgraph.graph.back", title: "Return from LangGraph", run: controls.back },
      { name: "langgraph.pane.next", title: "LangGraph: focus next pane", run: controls.cycle },
      { name: "langgraph.view.tree", title: "LangGraph: show solution tree", run: controls.tree },
      { name: "langgraph.view.detail", title: "LangGraph: show details", run: controls.detail },
      { name: "langgraph.view.runs", title: "LangGraph: choose run", run: controls.runs },
      { name: "langgraph.view.output", title: "LangGraph: show activation output", run: controls.output },
      { name: "langgraph.view.prompt", title: "LangGraph: show activation prompt", run: controls.prompt },
      { name: "langgraph.row.inspect", title: "LangGraph: open selected row", run: controls.inspect },
      { name: "langgraph.navigate.up", title: "LangGraph: navigate up", run: controls.up },
      { name: "langgraph.navigate.down", title: "LangGraph: navigate down", run: controls.down },
      { name: "langgraph.navigate.left", title: "LangGraph: navigate left", run: controls.left },
      { name: "langgraph.navigate.right", title: "LangGraph: navigate right", run: controls.right },
      { name: "langgraph.navigate.page_up", title: "LangGraph: page up", run: controls.pageUp },
      { name: "langgraph.navigate.page_down", title: "LangGraph: page down", run: controls.pageDown },
      { name: "langgraph.navigate.home", title: "LangGraph: go to start", run: controls.home },
      { name: "langgraph.navigate.end", title: "LangGraph: go to end", run: controls.end },
    ],
    bindings: [
      { key: "escape", cmd: "langgraph.graph.back" },
      { key: "q", cmd: "langgraph.graph.back" },
      { key: "tab", cmd: "langgraph.pane.next" },
      { key: "1", cmd: "langgraph.view.tree" },
      { key: "2", cmd: "langgraph.view.detail" },
      { key: "r", cmd: "langgraph.view.runs" },
      { key: "o", cmd: "langgraph.view.output" },
      { key: "p", cmd: "langgraph.view.prompt" },
      { key: "return", cmd: "langgraph.row.inspect" },
      { key: "up", cmd: "langgraph.navigate.up" },
      { key: "k", cmd: "langgraph.navigate.up" },
      { key: "w", cmd: "langgraph.navigate.up" },
      { key: "down", cmd: "langgraph.navigate.down" },
      { key: "j", cmd: "langgraph.navigate.down" },
      { key: "s", cmd: "langgraph.navigate.down" },
      { key: "left", cmd: "langgraph.navigate.left" },
      { key: "h", cmd: "langgraph.navigate.left" },
      { key: "a", cmd: "langgraph.navigate.left" },
      { key: "right", cmd: "langgraph.navigate.right" },
      { key: "l", cmd: "langgraph.navigate.right" },
      { key: "d", cmd: "langgraph.navigate.right" },
      { key: "pageup", cmd: "langgraph.navigate.page_up" },
      { key: "pagedown", cmd: "langgraph.navigate.page_down" },
      { key: "home", cmd: "langgraph.navigate.home" },
      { key: "end", cmd: "langgraph.navigate.end" },
    ],
  };
}

interface ExecutionWindowItem { event?: PluginRunEvent; omitted?: number }

function executionWindow(items: PluginRunEvent[], focus: number, limit = 7): ExecutionWindowItem[] {
  if (items.length <= limit) return items.map((event) => ({ event }));
  const visible = Math.max(1, limit - 2);
  const start = Math.max(0, Math.min(items.length - visible, focus - Math.floor(visible / 2)));
  const end = start + visible;
  return [
    ...(start ? [{ omitted: start }] : []),
    ...items.slice(start, end).map((event) => ({ event })),
    ...(end < items.length ? [{ omitted: items.length - end }] : []),
  ];
}

function middleEllipsis(value: string, limit: number): string {
  if ([...value].length <= limit) return value;
  const left = Math.ceil((limit - 1) / 2);
  const right = Math.floor((limit - 1) / 2);
  return `${[...value].slice(0, left).join("")}…${[...value].slice(-right).join("")}`;
}

function crop(value: string, width: number): string {
  const chars = [...value];
  return chars.length <= width ? value : `${chars.slice(0, Math.max(1, width - 1)).join("")}…`;
}

function shortTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type SemanticRegion = SolutionSemanticSnapshot["regions"][number];
type SemanticActivation = SolutionSemanticSnapshot["activations"][number];

const REGION_ICON: Record<string, string> = {
  verified: "\uf00c", implemented: "\uf0c3", collapsed: "\uf0e8", expanded: "\uf0e8", implementing: "\uf04b",
  actionable: "\uf10c", ready: "\uf10c", superposed: "\uf24e", contradiction: "\uf071", blocked: "\uf071", failed: "\uf00d",
};
const ROLE_ICON: Record<string, string> = { inspect: "\uf002", synthesize: "\uf0eb", implement: "\uf121", verify: "\uf0c3", present: "\uf075" };
const ACTIVATION_STATUS_ICON: Record<string, string> = { completed: "\uf00c", running: "\uf04b", failed: "\uf00d", waiting: "\uf10c", queued: "\uf10c" };
const RUN_ICON: Record<string, string> = { completed: "\uf00c", failed: "\uf00d", running: "\uf04b", queued: "\uf10c", interrupted: "\uf04d", cancelled: "\uf04d", pruned: "\uf0c4" };

const regionIcon = (status: string) => REGION_ICON[status] ?? "\uf10c";
const roleIcon = (capability: string) => ROLE_ICON[capability] ?? "\uf111";
const activationIcon = (status: string) => ACTIVATION_STATUS_ICON[status] ?? "\uf10c";
const runIcon = (status: string) => RUN_ICON[status] ?? "\uf10c";

export type SolutionTreeRow =
  | { kind: "region"; id: string; region: SemanticRegion; indent: string }
  | { kind: "activation"; id: string; activation: SemanticActivation; indent: string };

export function solutionTreeRows(snapshot: SolutionSemanticSnapshot): SolutionTreeRow[] {
  const byParent = new Map<string | undefined, SemanticRegion[]>();
  for (const region of snapshot.regions) byParent.set(region.parentId, [...(byParent.get(region.parentId) ?? []), region]);
  const activationsByRegion = new Map<string, SemanticActivation[]>();
  for (const activation of [...snapshot.activations].sort((a, b) => planId(a.id) - planId(b.id)))
    activationsByRegion.set(activation.regionId, [...(activationsByRegion.get(activation.regionId) ?? []), activation]);
  const rows: SolutionTreeRow[] = [];
  const visit = (parentId: string | undefined, indent: string) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => planId(a.id) - planId(b.id) || a.id.localeCompare(b.id));
    for (const region of children) {
      rows.push({ kind: "region", id: region.id, region, indent });
      for (const activation of activationsByRegion.get(region.id) ?? []) rows.push({ kind: "activation", id: activation.id, activation, indent: `${indent}  ` });
      visit(region.id, `${indent}  `);
    }
  };
  visit(undefined, "");
  return rows;
}

function executionState(event: PluginRunEvent): string {
  const progress = event.progress;
  const active = progress?.nodes.find((node) => node.id === progress.activeNodeId);
  return [progress?.phase, active ? `${active.id} ${active.title}` : progress?.scope, event.agent !== "langgraph" ? event.agent : event.runId].filter(Boolean).join(" · ");
}

export function effectivePrompt(event: PluginRunEvent | undefined): string {
  if (!event?.prompt) return "No effective prompt captured for this execution.";
  return [`SYSTEM\n${event.prompt.system}`, `INPUT\n${event.prompt.input}`, event.prompt.schemaInstruction ? `OUTPUT CONTRACT\n${event.prompt.schemaInstruction}` : ""].filter(Boolean).join("\n\n");
}

export function renderEventGraph(events: PluginRunEvent[], activeGlyph = "▶", focus?: number): AsciiGraph {

  const nodes = executions(events);
  if (!nodes.length) return { width: 0, height: 0, canvas: "" };
  const selected = Math.max(0, Math.min(focus ?? nodes.length - 1, nodes.length - 1));
  const lines: string[] = [];
  for (const item of executionWindow(nodes, selected)) {
    if (lines.length) lines.push("      │");
    if (item.omitted) {
      lines.push(`      ⋮  ${item.omitted} execution${item.omitted === 1 ? "" : "s"} collapsed`);
      continue;
    }
    const event = item.event!;
    const name = event.node === "__start__" ? "START" : event.node === "__end__" ? "END" : event.node.replaceAll("_", " ").toUpperCase();
    lines.push(`${status(event, activeGlyph)}  ${name}  [${event.status.toUpperCase()}]`);
    const state = executionState(event);
    if (state) lines.push(`   └─ ${middleEllipsis(state, 72)}`);
  }
  const canvas = lines.join("\n");
  const rows = canvas.split("\n");
  return { canvas, width: Math.max(0, ...rows.map((row) => [...row].length)), height: rows.length };
}

function status(event: PluginRunEvent, activeGlyph = "▶"): string {
  if (event.status === "active") return activeGlyph;
  if (event.status === "completed") return "✓";
  if (event.status === "interrupted") return "!";
  if (event.status === "failed") return "×";
  return "○";
}

const spinnerFrames = ["|", "/", "-", "\\"];

function runIsActive(events: PluginRunEvent[]): boolean {
  const runId = latestRunId(events);
  const current = events.filter((event) => event.runId === runId);
  if (current.some((event) => event.node === "__end__" && (event.status === "completed" || event.status === "failed"))) return false;
  if (current.some((event) => event.status === "interrupted")) return false;
  return current.some((event) => event.status === "active");
}

function useSpinner(events: () => PluginRunEvent[], api: TuiPluginApi): () => string {
  const [frame, setFrame] = createSignal(0);
  onMount(() => {
    const timer = setInterval(() => {
      if (!runIsActive(events())) return;
      setFrame((value) => (value + 1) % spinnerFrames.length);
      api.renderer.requestRender();
    }, 140);
    onCleanup(() => clearInterval(timer));
  });
  return () => runIsActive(events()) ? spinnerFrames[frame()] : "✓";
}

function statusColor(event: PluginRunEvent, theme: TuiPluginApi["theme"]["current"]) {
  if (event.status === "failed") return theme.error;
  if (event.status === "active" || event.status === "interrupted" || event.status === "pruned") return theme.warning;
  if (event.status === "completed") return theme.success;
  return theme.textMuted;
}

type Theme = TuiPluginApi["theme"]["current"];
type ProgressSnapshot = NonNullable<PluginRunEvent["progress"]>;
type ProgressNode = ProgressSnapshot["nodes"][number];

function statusTone(value: string, theme: Theme) {
  if (value === "failed" || value === "blocked" || value === "contradiction") return theme.error;
  if (value === "active" || value === "implementing" || value === "interrupted" || value === "pruned" || value === "superposed") return theme.warning;
  if (value === "verified" || value === "completed") return theme.success;
  if (value === "ready" || value === "implemented") return theme.info;
  if (value === "expanded") return theme.secondary;
  return theme.textMuted;
}

function shortAgent(value: string): string {
  return value.replace(/^langgraph-/, "").replace(/[^a-z0-9]+/gi, "-").toUpperCase();
}

function roleColor(value: string, theme: Theme) {
  const role = value.toLowerCase();
  if (role.includes("inspect")) return theme.info;
  if (role.includes("synth")) return theme.accent;
  if (role.includes("classif")) return theme.secondary;
  if (role.includes("scout") || role.includes("research")) return theme.info;
  if (role.includes("decid") || role.includes("plan")) return theme.accent;
  if (role.includes("implement") || role.includes("build") || role.includes("repair")) return theme.primary;
  if (role.includes("verif") || role.includes("review") || role.includes("test")) return theme.success;
  if (role === "human") return theme.warning;
  const palette = [theme.primary, theme.secondary, theme.accent, theme.info, theme.success];
  let hash = 0;
  for (const character of role) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function renderStructuredEvent(event: PluginRunEvent): string {
  const lines = [
    `${event.node.replaceAll("_", " ").toUpperCase()}  [${event.status.toUpperCase()}]  ${shortAgent(event.agent)}  ${event.model}`,
  ];
  if (event.text) {
    const text = event.text.replace(/\s+/g, " ").trim();
    lines.push("", "OUTPUT", text.slice(0, 4_000));
  }
  if (event.progress) {
    const snapshot = event.progress;
    const semantic = snapshot.semantic;
    lines.push("", `PROGRESS  ${snapshot.phase}${snapshot.scope ? ` · ${snapshot.scope}` : ""}`);
    if (semantic && semantic.regions.length) {
      for (const region of semantic.regions) {
        const viable = region.viable !== undefined ? `${region.viable}/${region.total} viable` : "";
        lines.push(`  ${planGlyph(region.status)} ${region.id}  [${region.status}]  ${region.objective ?? ""}${viable ? `  · ${viable}` : ""}`);
      }
    }
    if (semantic && semantic.activations.length) {
      lines.push("", "ACTIVATIONS");
      for (const activation of semantic.activations) {
        lines.push(`  ${planGlyph(activation.status)} ${activation.id}:${activation.capability}  [${activation.status}]  ${activation.regionId}  ${activation.expectedDelta ?? ""}${activation.error ? `  ! ${activation.error}` : ""}`);
      }
    }
  }
  if (event.usage) {
    lines.push("", `USAGE  ${usageLine(event.usage, event.streaming)}`);
  }
  return lines.join("\n");
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function compactEstimate(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function usageLine(usage: AgentUsage, streaming?: UsageStreamingEstimate): string {
  return `${usage.turns}t · ${compactNumber(usage.input)}in · ${compactNumber(usage.cacheRead)}cache${usage.cost ? ` · $${usage.cost.toFixed(3)}` : ""}${streaming ? ` · ~${compactEstimate(streaming.inputEstimated + streaming.outputEstimated)} live` : ""}`;
}

function planId(value: string): number { const parsed = Number(value.replace(/^[a-z]+/, "")); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER; }

function progressSnapshot(events: PluginRunEvent[]): ProgressSnapshot | undefined {
  const runId = latestRunId(events);
  return events.filter((event) => event.runId === runId && event.progress).at(-1)?.progress;
}

function liveStreamingEstimate(events: PluginRunEvent[]): UsageStreamingEstimate | undefined {
  const runId = latestRunId(events);
  return events.filter((event) => event.runId === runId).at(-1)?.streaming;
}

interface PlanRow { node: ProgressNode; branch: string; continuation: string }

function planRows(snapshot: ProgressSnapshot): PlanRow[] {
  const byParent = new Map<string | undefined, ProgressNode[]>();
  for (const node of snapshot.nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  const rows: PlanRow[] = [];
  const visit = (parentId: string | undefined, prefix: string) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => planId(a.id) - planId(b.id) || a.id.localeCompare(b.id));
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      rows.push({ node, branch: `${prefix}${last ? "└─" : "├─"}`, continuation: `${prefix}${last ? "   " : "│  "}` });
      visit(node.id, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  visit(undefined, "");
  return rows;
}

function planGlyph(value: string): string {
  return value === "verified" ? "●" : value === "implemented" ? "■" : value === "collapsed" || value === "expanded" ? "◆" : value === "active" || value === "implementing" ? "▶" : value === "failed" || value === "blocked" || value === "contradiction" ? "!" : value === "removed" ? "·" : value === "ready" || value === "actionable" ? "○" : value === "superposed" ? "◇" : "·";
}

export function renderPlanTree(events: PluginRunEvent[]): string {
  const snapshot = progressSnapshot(events);
  if (!snapshot?.nodes.length) return "";
  const usage = snapshot.usage;
  const lines = [
    `SOLUTION LOD  ${snapshot.phase}${snapshot.scope ? ` · ${snapshot.scope}` : ""}`,
    snapshot.callsUsed !== undefined ? `${snapshot.callsUsed} activations${usage ? ` · ${usage.turns} turns` : ""}` : "",
    usage ? `TOKENS  ${compactNumber(usage.input)} input · ${compactNumber(usage.cacheRead)} cached` : "",
    "",
  ].filter((line, index, all) => line || index === all.length - 1);
  for (const { node, branch, continuation } of planRows(snapshot)) {
    const semanticRegion = snapshot.semantic?.regions.find((region) => region.id === node.id);
    const metrics = [node.status, node.level, semanticRegion ? `${semanticRegion.viable}/${semanticRegion.total} viable · ${semanticRegion.edge}` : "", node.evidence ? `${node.evidence} evidence` : "", node.dependencies?.length ? `after ${node.dependencies.join(", ")}` : ""].filter(Boolean).join(" · ");
    const agents = node.agents?.length ? node.agents.map(shortAgent).join(", ") : "controller";
    lines.push(`${branch} ${planGlyph(node.status)} ${node.id}  ${middleEllipsis(node.title, 72)}`, `${continuation}   ${node.level}`, `${continuation}   ${metrics} ${agents}`);
  }
  if (snapshot.summary && snapshot.summary !== snapshot.nodes[0]?.title) lines.push("", snapshot.summary);
  return lines.join("\n");
}

function SolutionTreeView(props: { rows: SolutionTreeRow[]; selectedId?: string; onSelect: (id: string) => void; activationTime: (activation: SemanticActivation) => string; width: () => number; theme: Theme }) {
  const budget = () => Math.max(24, props.width());
  return (
    <box flexDirection="column" paddingX={1}>
      <For each={props.rows}>{(row) => {
        const selected = () => props.selectedId === row.id;
        return (
          <box flexDirection="column" width="100%" backgroundColor={selected() ? props.theme.backgroundElement : undefined} onMouseUp={() => props.onSelect(row.id)}>
            {row.kind === "region" ? (
              <>
                <text wrapMode="none" fg={statusTone(row.region.status, props.theme)}>
                  {row.indent}{regionIcon(row.region.status)} <b>{row.region.id}</b> {crop(row.region.objective, budget() - row.indent.length - row.region.id.length - 4)}
                </text>
                <text wrapMode="none" fg={props.theme.textMuted}>
                  {crop(`${row.indent}  ${row.region.status} · L${row.region.lod} · ${row.region.edge} · ${row.region.viable}/${row.region.total} viable · ${row.region.evidenceIds.length} ev`, budget())}
                </text>
              </>
            ) : (
              <>
                <text wrapMode="none" fg={roleColor(row.activation.capability, props.theme)}>
                  {row.indent}{roleIcon(row.activation.capability)} <b>{row.activation.id}</b> {crop(row.activation.request, budget() - row.indent.length - row.activation.id.length - 4)}
                </text>
                <text wrapMode="none" fg={props.theme.textMuted}>
                  {crop(`${row.indent}  ${activationIcon(row.activation.status)} ${row.activation.status} · ${row.activation.expectedDelta}${props.activationTime(row.activation) ? ` · ${props.activationTime(row.activation)}` : ""}${row.activation.error ? ` · ${row.activation.error}` : ""}`, budget())}
                </text>
              </>
            )}
          </box>
        );
      }}</For>
    </box>
  );
}

export interface RunListItem { run: ReturnType<typeof listAllRuns>[number]; modified: number }

function RunListView(props: { items: RunListItem[]; selectedId?: string; onSelect: (id: string) => void; width: () => number; theme: Theme }) {
  const budget = () => Math.max(24, props.width());
  return (
    <box flexDirection="column" paddingX={1}>
      <For each={props.items}>{(item) => {
        const selected = () => props.selectedId === item.run.runId;
        return (
          <box flexDirection="column" width="100%" backgroundColor={selected() ? props.theme.backgroundElement : undefined} onMouseUp={() => props.onSelect(item.run.runId)}>
            <text wrapMode="none" fg={statusTone(item.run.status, props.theme)}>
              {runIcon(item.run.status)} <b>{path.basename(item.run.worktree)}</b> {crop(item.run.task ?? "", budget() - path.basename(item.run.worktree).length - 4)}
            </text>
            <text wrapMode="none" fg={props.theme.textMuted}>
              {crop(`  ${item.run.status} · ${item.run.graph} · ses …${item.run.rootSessionId.slice(-6)} · ${shortDate(item.modified)} · ${item.run.runId.slice(0, 8)}`, budget())}
            </text>
          </box>
        );
      }}</For>
    </box>
  );
}

function RunDetailView(props: { item: RunListItem; theme: Theme }) {
  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={statusTone(props.item.run.status, props.theme)}><b>{runIcon(props.item.run.status)} {props.item.run.status.toUpperCase()}</b></text>
        <text fg={props.theme.secondary}>[{props.item.run.graph.toUpperCase()}]</text>
        <text fg={props.theme.textMuted}>{shortDate(props.item.modified)}</text>
      </box>
      <text fg={props.theme.text} wrapMode="word"><b>{props.item.run.task}</b></text>
      <text fg={props.theme.textMuted} wrapMode="word">  repo {props.item.run.worktree}</text>
      <text fg={props.theme.textMuted}>  session {props.item.run.rootSessionId}</text>
      <text fg={props.theme.textMuted}>  run {props.item.run.runId}</text>
      <text fg={props.theme.info}>  Enter to open this run</text>
    </box>
  );
}

function ActivationDetailView(props: { activation: SemanticActivation; event?: PluginRunEvent; promptEvent?: PluginRunEvent; tab: "output" | "prompt"; onTab: (tab: "output" | "prompt") => void; theme: Theme }) {
  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={roleColor(props.activation.capability, props.theme)}><b>{roleIcon(props.activation.capability)} {props.activation.id}:{props.activation.capability}</b></text>
        <text fg={statusTone(props.activation.status, props.theme)}>[{props.activation.status.toUpperCase()}]</text>
        <Show when={props.event?.at}><text fg={props.theme.textMuted}>{shortTime(props.event?.at)}</text></Show>
        <Show when={props.event?.usage}>{(usage) => <text fg={props.theme.textMuted} wrapMode="none">{usageLine(usage(), props.event?.streaming)}</text>}</Show>
      </box>
      <text fg={props.theme.textMuted}>  region {props.activation.regionId} · {props.activation.expectedDelta}{props.activation.senderActivationId ? ` · after ${props.activation.senderActivationId}` : ""}</text>
      <text fg={props.theme.textMuted}>REQUEST</text>
      <text fg={props.theme.text} wrapMode="word">  {props.activation.request}</text>
      <Show when={props.activation.error}><text fg={props.theme.error} wrapMode="word">  ERROR {props.activation.error}</text></Show>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text onMouseUp={() => props.onTab("output")} fg={props.tab === "output" ? props.theme.primary : props.theme.textMuted}><b>Output [O]</b></text>
        <text onMouseUp={() => props.onTab("prompt")} fg={props.tab === "prompt" ? props.theme.primary : props.theme.textMuted}>Prompt [P]</text>
      </box>
      <text fg={props.theme.text} wrapMode="word">{props.tab === "output" ? (props.event?.text ?? "No output recorded yet.") : effectivePrompt(props.promptEvent)}</text>
    </box>
  );
}


function semanticSnapshot(events: PluginRunEvent[]): SolutionSemanticSnapshot | undefined {
  return progressSnapshot(events)?.semantic;
}

function RegionDetailView(props: { semantic?: SolutionSemanticSnapshot; regionId?: string; theme: Theme }) {
  const region = createMemo(() => props.semantic?.regions.find((item) => item.id === props.regionId));
  const candidates = createMemo(() => props.semantic?.candidates.filter((item) => item.regionId === props.regionId) ?? []);
  const constraints = createMemo(() => props.semantic?.constraints.filter((item) => region()?.constraintIds.includes(item.id)) ?? []);
  const evidence = createMemo(() => props.semantic?.evidence.filter((item) => region()?.evidenceIds.includes(item.id)) ?? []);
  const artifacts = createMemo(() => props.semantic?.artifacts.filter((item) => item.regionId === props.regionId) ?? []);
  return <Show when={region()} fallback={<text fg={props.theme.textMuted} padding={1}>Select a solution region.</text>}>{(item) => (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={statusTone(item().status, props.theme)}><b>{regionIcon(item().status)} {item().id} · L{item().lod}</b></text>
        <text fg={props.theme.secondary}>[{item().edge.toUpperCase()}]</text>
        <text fg={props.theme.textMuted}>{item().viable}/{item().total} viable</text>
      </box>
      <text fg={props.theme.text} wrapMode="word"><b>{item().objective}</b></text>
      <Show when={artifacts().length}><text fg={props.theme.textMuted}>ARTIFACTS</text></Show>
      <For each={artifacts()}>{(artifact) => <text fg={artifact.passed === false ? props.theme.error : props.theme.success} wrapMode="word">  {artifact.kind} {artifact.path ?? artifact.summary}</text>}</For>
      <text fg={props.theme.textMuted}>CANDIDATES</text>
      <Show when={candidates().length} fallback={<text fg={props.theme.textMuted}>  · not formed at this LOD</text>}>
        <For each={candidates()}>{(candidate) => <box flexDirection="column">
          <text fg={statusTone(candidate.status, props.theme)}>  {candidate.status === "selected" ? "◆" : candidate.status === "eliminated" ? "×" : "◇"} {candidate.proposition}</text>
          <Show when={candidate.eliminationReasons.length}><text fg={props.theme.error}>    └─ {candidate.eliminationReasons.join("; ")}</text></Show>
          <Show when={candidate.conditionalChildren.length}><text fg={props.theme.secondary}>    ↳ next LOD: {candidate.conditionalChildren.join(" · ")}</text></Show>
        </box>}</For>
      </Show>
      <Show when={constraints().length}><text fg={props.theme.textMuted}>CONSTRAINTS</text></Show>
      <For each={constraints()}>{(constraint) => <text fg={props.theme.warning}>  {constraint.kind} {constraint.subject} → {constraint.target}{constraint.reason ? ` · ${constraint.reason}` : ""}</text>}</For>
      <Show when={evidence().length}><text fg={props.theme.textMuted}>EVIDENCE</text></Show>
      <Show when={evidence().length > 6}><text fg={props.theme.textMuted}>  ⋮ {evidence().length - 6} earlier facts omitted</text></Show>
      <For each={evidence().slice(-6)}>{(fact) => <text fg={props.theme.info} wrapMode="word">  {fact.id} {fact.text} · {fact.source}</text>}</For>
    </box>
  )}</Show>;
}

function executions(events: PluginRunEvent[]): PluginRunEvent[] {
  const runId = latestRunId(events);
  const current = events.filter((event) => event.runId === runId);
  const lastByNode = new Map<string, PluginRunEvent>();
  for (const event of current) lastByNode.set(event.node, event);
  return current.filter((event) =>
    event.status === "completed" || event.status === "failed" || event.status === "interrupted" || lastByNode.get(event.node) === event
  );
}

function projectPath(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory || process.cwd();
}

function stateHome(api: TuiPluginApi): string {
  const marker = `${path.sep}.config${path.sep}`;
  const configIndex = api.state.path.config.indexOf(marker);
  if (configIndex >= 0) return path.join(api.state.path.config.slice(0, configIndex), ".local", "state");
  return process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(process.cwd(), ".opencode-langgraph-state");
}

function eventsForMessage(events: PluginRunEvent[], userMessageId?: string): PluginRunEvent[] {
  if (!userMessageId) return events;
  const linked = events.filter((event) => event.userMessageId === userMessageId);
  const runId = latestRunId(linked);
  return runId ? events.filter((event) => event.runId === runId) : [];
}

export function readVisibleEvents(rootSessionId: string | undefined, worktree: string, stateHome: string, userMessageId?: string, runId?: string): PluginRunEvent[] {
  if (runId) {
    // A run's events live in the launching session's event file, which is not
    // necessarily the active session (e.g. graphs launched by agents).
    try {
      const run = readStoredRun(runId, stateHome);
      return readPluginEvents(run.rootSessionId, stateHome).filter((event) => event.runId === runId);
    } catch {
      return [];
    }
  }
  const all = rootSessionId ? readPluginEvents(rootSessionId, stateHome) : readLatestProjectEvents(worktree, stateHome);
  return eventsForMessage(all, userMessageId);
}

function useEvents(rootSessionId: () => string | undefined, worktree: () => string, stateHome: () => string, userMessageId: () => string | undefined = () => undefined, runId: () => string | undefined = () => undefined) {
  const read = () => readVisibleEvents(rootSessionId(), worktree(), stateHome(), userMessageId(), runId());
  const initial = read();
  let signature = JSON.stringify(initial);
  const [events, setEvents] = createSignal<PluginRunEvent[]>(initial);
  const refresh = () => {
    const next = read();
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    setEvents(next);
  };
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 250);
    onCleanup(() => clearInterval(timer));
  });
  return events;
}

interface GraphToggleController {
  enabled(sessionId?: string): boolean;
  selected(sessionId?: string): string | undefined;
  defaultGraph(): string | undefined;
  toggle(sessionId?: string): boolean;
  select(sessionId: string | undefined, graph: string): void;
  modelAssignments(sessionId?: string): SolutionRoleModelAssignments;
  assignModel(sessionId: string | undefined, role: SolutionPresetRole, model: ModelDefinition | undefined): void;
  adopt(sessionId: string): void;
}

function createGraphToggleController(api: TuiPluginApi): GraphToggleController {
  const [revision, setRevision] = createSignal(0);
  const [defaultGraph, setDefaultGraph] = createSignal<string>();
  const home = () => readHomeGraphState(projectPath(api), stateHome(api));
  void loadConnectorDefinition(projectPath(api)).then((definition) => setDefaultGraph(definition.defaultGraph)).catch(() => undefined);
  return {
    enabled(id) {
      revision();
      return id ? readSessionGraphEnabled(id, stateHome(api)) : home()?.enabled === true;
    },
    selected(id) {
      revision();
      return id ? readSessionGraphName(id, stateHome(api)) : home()?.graph;
    },
    defaultGraph,
    toggle(id) {
      const enabled = id ? !readSessionGraphEnabled(id, stateHome(api)) : home()?.enabled !== true;
      if (id) writeSessionGraphEnabled(id, enabled, stateHome(api));
      else writeHomeGraphState(projectPath(api), { ...home(), enabled }, stateHome(api));
      setRevision((value) => value + 1);
      api.renderer.requestRender();
      return enabled;
    },
    select(id, graph) {
      if (id) writeSessionGraphName(id, graph, stateHome(api));
      else writeHomeGraphState(projectPath(api), { enabled: home()?.enabled === true, graph }, stateHome(api));
      setRevision((value) => value + 1);
      api.renderer.requestRender();
    },
    modelAssignments(id) {
      revision();
      return id ? readSessionGraphState(id, stateHome(api))?.modelAssignments ?? {} : home()?.modelAssignments ?? {};
    },
    assignModel(id, role, model) {
      const modelAssignments = { ...(id ? readSessionGraphState(id, stateHome(api))?.modelAssignments ?? {} : home()?.modelAssignments ?? {}), ...(model ? { [role]: model } : {}) };
      if (!model) delete modelAssignments[role];
      if (id) writeSessionGraphModelAssignments(id, modelAssignments, stateHome(api));
      else writeHomeGraphState(projectPath(api), { enabled: home()?.enabled === true, graph: home()?.graph, modelAssignments }, stateHome(api));
      setRevision((value) => value + 1);
      api.renderer.requestRender();
    },
    adopt(id) {
      if (!adoptHomeGraphState(id, projectPath(api), stateHome(api))) return;
      setRevision((value) => value + 1);
      api.renderer.requestRender();
    },
  };
}

const solutionRoles: SolutionPresetRole[] = ["inspect", "synthesize", "implement", "verify", "present"];

function commandAvailable(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    try { accessSync(path.join(directory, command), constants.X_OK); return true; } catch { return false; }
  });
}

function modelAssignmentLabel(model: ModelDefinition | undefined): string {
  if (!model || (model.backend === "opencode" && model.model === "inherit")) return "Current OpenCode model";
  if (model.backend === "opencode") return model.model;
  return `${model.command} CLI`;
}

async function showRoleModelSelector(api: TuiPluginApi, sessionID: string | undefined, controller: GraphToggleController, role: SolutionPresetRole): Promise<void> {
  try {
    const listed = await api.client.v2.model.list({ location: { directory: projectPath(api) } });
    const models = (listed.data?.data ?? []).filter((model) => model.enabled);
    const options: Array<{ title: string; value: ModelDefinition | undefined; description?: string }> = [
      { title: "Current OpenCode model", value: undefined, description: "Follow the model selected for this chat" },
      ...models.map((model) => ({ title: `${model.providerID}/${model.id}`, value: { backend: "opencode" as const, model: `${model.providerID}/${model.id}` as `${string}/${string}` }, description: model.name })),
      ...(commandAvailable("codex") ? [{ title: "Codex CLI", value: { backend: "command" as const, command: "codex", args: ["exec", "--skip-git-repo-check"] }, description: "Run Codex locally with the graph prompt on stdin" }] : []),
    ];
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: `Model for ${role}`,
      placeholder: "Search available models",
      current: controller.modelAssignments(sessionID)[role],
      options,
      onSelect(option) {
        controller.assignModel(sessionID, role, option.value);
        api.ui.dialog.clear();
        api.ui.toast({ variant: "success", message: `${role}: ${modelAssignmentLabel(option.value)}` });
      },
    }));
  } catch (error) {
    api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function showModelAssignments(api: TuiPluginApi, sessionID: string | undefined, controller: GraphToggleController): void {
  api.ui.dialog.replace(() => api.ui.DialogSelect({
    title: "Assign LangGraph role models",
    placeholder: "Choose a role",
    options: solutionRoles.map((role) => ({ title: role, value: role, description: modelAssignmentLabel(controller.modelAssignments(sessionID)[role]) })),
    onSelect(role) { void showRoleModelSelector(api, sessionID, controller, role.value); },
  }));
}

export function graphToggleLabel(enabled: boolean, graph?: string): string {
  return `[F7] graph:${enabled ? graph ?? "…" : "off"} · [F8] view · [F9] help`;
}

function GraphToggle(props: { api: TuiPluginApi; session_id?: string; graph: GraphToggleController }) {
  const enabled = () => props.graph.enabled(props.session_id);
  const name = () => props.graph.selected(props.session_id) ?? props.graph.defaultGraph();
  return (
    <box onMouseUp={() => props.graph.toggle(props.session_id)}>
      <text fg={enabled() ? props.api.theme.current.success : props.api.theme.current.textMuted}>{graphToggleLabel(enabled(), name())}</text>
    </box>
  );
}

async function showGraphSelector(api: TuiPluginApi, sessionID: string | undefined, controller: GraphToggleController): Promise<void> {
  try {
    const definition = await loadConnectorDefinition(projectPath(api));
    const names = Object.keys(definition.graphs);
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Select LangGraph for this session",
      placeholder: "Search graphs",
      current: controller.selected(sessionID) ?? definition.defaultGraph,
      options: names.map((name) => ({
        title: name,
        value: name,
        description: name === definition.defaultGraph ? "Configured default" : undefined,
      })),
      onSelect(option) {
        controller.select(sessionID, option.value);
        api.ui.dialog.clear();
        api.ui.toast({ variant: "success", message: `Selected graph: ${option.value}` });
      },
    }));
  } catch (error) {
    api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function showRunSelector(api: TuiPluginApi): void {
  api.route.navigate("langgraph.graph", { runs: true });
}

export function graphHelpText(): string {
  return `[F7] toggle · [F8] view · [F9] help

USE
/graph-open inspect past run · /graph-select choose · /graph-models assign roles · /graph-toggle auto
/run-graph <task> once · /graph-resume <answer> · /graph-cancel stop

VIEW · panels
1 tree · 2 details · R runs
Tab next pane · ↑↓ select · Enter open/inspect
O output · P prompt · Q back

DESIGN · .opencode/langgraph.ts
1. Annotation.Root → StateGraph → compile(checkpointer)
2. agentNode(text) or structuredAgentNode(Zod) at model boundaries
3. defineGraph({ graph, initial, result, progress? }) maps I/O
4. defineOpenCodeLangGraph registers graphs + default

CLI · opencode-langgraph init · validate · graph`;
}

function showGraphHelp(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title: "OpenCode LangGraph",
    message: graphHelpText(),
    onConfirm: () => api.ui.dialog.clear(),
  }));
}

function Sidebar(props: { api: TuiPluginApi; session_id: string }) {
  const events = useEvents(() => props.session_id, () => projectPath(props.api), () => stateHome(props.api));
  const node = createMemo(() => executions(events()).at(-1));
  const spinner = useSpinner(events, props.api);
  const theme = () => props.api.theme.current;
  const semantic = createMemo(() => events().filter((event) => event.progress).at(-1)?.progress);
  return (
    <Show when={node()}>
      <box paddingTop={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().primary}><b>LANGGRAPH::LIVE</b></text>
          <text fg={theme().textMuted}>{events().at(-1)?.graph ?? "graph"}</text>
        </box>
        <Show when={semantic()}>{(value) => (
          <box flexDirection="column">
            <text fg={statusTone(value().phase, theme())}>[{value().phase.toUpperCase()}] [{(value().scope ?? "classifying").toUpperCase()}] {value().callsUsed ?? 0} calls{value().usage ? ` · ${value().usage!.turns}t · ${compactNumber(value().usage!.input)}in` : ""}</text>
            <Show when={value().nodes.find((node) => node.id === value().activeNodeId)}>{(node) => <text fg={statusTone(node().status, theme())} wrapMode="none">{planGlyph(node().status)} {node().id} {middleEllipsis(node().title, 48)}</text>}</Show>
          </box>
        )}</Show>
        <Show when={node()}>{(event) => (
          <box flexDirection="column" paddingTop={1}>
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(event(), theme())}>{status(event(), spinner())}</text>
              <text fg={theme().text} wrapMode="none"><b>{event().node.replaceAll("_", " ")}</b></text>
              <text fg={statusColor(event(), theme())}>[{event().status.toUpperCase()}]</text>
            </box>
            <text fg={roleColor(event().agent, theme())} wrapMode="none">  [{shortAgent(event().agent)}] {event().model}</text>
            <Show when={event().usage}>{(usage) => <text fg={theme().textMuted} wrapMode="none">  {usageLine(usage(), event().streaming)}</text>}</Show>
          </box>
        )}</Show>
      </box>
    </Show>
  );
}

function GraphRoute(props: { api: TuiPluginApi; rootSessionId?: string; userMessageId?: string; runID?: string; chooser?: boolean }) {
  const [rootSessionId, setRootSessionId] = createSignal(props.rootSessionId);
  const [runID, setRunID] = createSignal(props.runID);
  const events = useEvents(() => rootSessionId(), () => projectPath(props.api), () => stateHome(props.api), () => props.userMessageId, () => runID());
  const currentRun = createMemo(() => latest(events()));
  const semantic = createMemo(() => progressSnapshot(events()));
  const liveEstimate = createMemo(() => liveStreamingEstimate(events()));
  const solution = createMemo(() => semanticSnapshot(events()));
  const activePlan = createMemo(() => semantic()?.nodes.find((node) => node.id === semantic()?.activeNodeId));
  const [view, setView] = createSignal<"tree" | "runs">(props.chooser ? "runs" : "tree");
  const [focus, setFocus] = createSignal<"tree" | "detail">("tree");
  const [selectedId, setSelectedId] = createSignal<string>();
  const [selectedRunId, setSelectedRunId] = createSignal<string>();
  const [detailTab, setDetailTab] = createSignal<"output" | "prompt">("output");
  const [runsVersion, setRunsVersion] = createSignal(0);
  let treeBox: ScrollBoxRenderable | undefined;
  let detailBox: ScrollBoxRenderable | undefined;
  const theme = () => props.api.theme.current;
  const termWidth = () => (props.api.renderer as unknown as { width?: number }).width ?? 120;
  const treeWidth = () => Math.max(30, Math.floor(termWidth() * 0.42) - 4);
  const rows = createMemo(() => solution() ? solutionTreeRows(solution()!) : []);
  const runItems = createMemo<RunListItem[]>(() => {
    runsVersion();
    return listAllRuns(stateHome(props.api)).map((run) => {
      let modified = 0;
      try { modified = statSync(path.join(stateHome(props.api), "opencode-langgraph", "runs", `${run.runId}.json`)).mtimeMs; } catch { /* run file gone */ }
      return { run, modified };
    });
  });
  const eventByNode = createMemo(() => {
    const runId = latestRunId(events());
    const map = new Map<string, PluginRunEvent>();
    for (const event of events()) if (event.runId === runId) map.set(event.node, event);
    return map;
  });
  const promptByNode = createMemo(() => {
    const runId = latestRunId(events());
    const map = new Map<string, PluginRunEvent>();
    for (const event of events()) if (event.runId === runId && event.prompt) map.set(event.node, event);
    return map;
  });
  const activationTime = (activation: SemanticActivation) => shortTime(eventByNode().get(`${activation.capability}:${activation.regionId}`)?.at);
  const selectedRow = createMemo(() => rows().find((row) => row.id === selectedId()));
  const selectedActivation = createMemo(() => { const row = selectedRow(); return row?.kind === "activation" ? row.activation : undefined; });
  const selectedRegionId = createMemo(() => { const row = selectedRow(); return row ? (row.kind === "region" ? row.region.id : row.activation.regionId) : undefined; });
  const selectedActivationEvent = createMemo(() => { const activation = selectedActivation(); return activation ? eventByNode().get(`${activation.capability}:${activation.regionId}`) : undefined; });
  const selectedActivationPrompt = createMemo(() => { const activation = selectedActivation(); return activation ? promptByNode().get(`${activation.capability}:${activation.regionId}`) : undefined; });
  const selectedRunItem = createMemo(() => runItems().find((item) => item.run.runId === selectedRunId()));
  const requestRender = () => props.api.renderer.requestRender();
  const setFocusPanel = (value: "tree" | "detail") => { setFocus(value); requestRender(); };
  const back = () => {
    if (rootSessionId()) props.api.route.navigate("session", { sessionID: rootSessionId()! });
    else props.api.route.navigate("home");
  };
  const moveSelection = (delta: number) => {
    if (view() === "runs") {
      const list = runItems(); if (!list.length) return;
      const index = list.findIndex((item) => item.run.runId === selectedRunId());
      setSelectedRunId(list[Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta))].run.runId);
    } else {
      const list = rows(); if (!list.length) return;
      const index = list.findIndex((row) => row.id === selectedId());
      setSelectedId(list[Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta))].id);
    }
    requestRender();
  };
  const openRun = (id: string) => {
    const item = runItems().find((entry) => entry.run.runId === id);
    if (!item) return;
    setRootSessionId(item.run.rootSessionId);
    setRunID(item.run.runId);
    setSelectedId(undefined);
    setView("tree");
    setFocusPanel("tree");
  };
  const controls: GraphControls = {
    back,
    cycle: () => setFocusPanel(focus() === "tree" ? "detail" : "tree"),
    tree: () => { setView("tree"); setFocusPanel("tree"); },
    detail: () => setFocusPanel("detail"),
    runs: () => { setRunsVersion((value) => value + 1); setView("runs"); setFocusPanel("tree"); },
    output: () => { setDetailTab("output"); setFocusPanel("detail"); },
    prompt: () => { setDetailTab("prompt"); setFocusPanel("detail"); },
    inspect: () => { if (view() === "runs") { const id = selectedRunId(); if (id) openRun(id); } else setFocusPanel("detail"); },
    up: () => { if (focus() === "detail") detailBox?.scrollBy(-3); else moveSelection(-1); },
    down: () => { if (focus() === "detail") detailBox?.scrollBy(3); else moveSelection(1); },
    left: () => setFocusPanel("tree"),
    right: () => setFocusPanel("detail"),
    pageUp: () => { if (focus() === "detail") detailBox?.scrollBy(-12); else moveSelection(-5); },
    pageDown: () => { if (focus() === "detail") detailBox?.scrollBy(12); else moveSelection(5); },
    home: () => { if (focus() === "detail") detailBox?.scrollTo(0); else moveSelection(-1_000); },
    end: () => { if (focus() === "detail" && detailBox) detailBox.scrollTo(detailBox.scrollHeight); else moveSelection(1_000); },
  };
  const navigation = graphNavigationLayer(controls);
  const disposeNavigation = props.api.keymap.registerLayer({
    priority: 1000,
    commands: navigation.commands,
    bindings: navigation.bindings,
  });
  onCleanup(disposeNavigation);
  createEffect(() => {
    const list = rows();
    if (list.length && !list.some((row) => row.id === selectedId())) setSelectedId(semantic()?.activeNodeId ?? list[0].id);
  });
  createEffect(() => {
    const list = runItems();
    if (list.length && !list.some((item) => item.run.runId === selectedRunId())) setSelectedRunId(list[0].run.runId);
  });
  const liveStatus = createMemo(() => runIsActive(events()) ? "LIVE" : currentRun().at(-1)?.status?.toUpperCase() ?? "IDLE");
  const liveColor = createMemo(() => runIsActive(events()) ? theme().warning : currentRun().at(-1)?.status === "failed" ? theme().error : theme().success);
  const borderFor = (panel: "tree" | "detail") => focus() === panel ? theme().borderActive : theme().border;
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" flexDirection="column" padding={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme().primary}><b>LANGGRAPH</b></text>
        <text fg={liveColor()}><b>[{liveStatus()}]</b></text>
        <text fg={theme().secondary}>[{(currentRun().at(-1)?.graph ?? "no-graph").toUpperCase()}]</text>
        <text fg={statusTone(semantic()?.phase ?? "idle", theme())}>[{(semantic()?.phase ?? "idle").toUpperCase()}]</text>
        <Show when={activePlan()}>{(node) => <text fg={theme().text}>{planGlyph(node().status)} {node().id}</text>}</Show>
        <box flexGrow={1} />
        <Show when={semantic()?.usage}>{(usage) => <text fg={theme().textMuted}>{usageLine(usage(), liveEstimate())}</text>}</Show>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme().textMuted}>RUN::{currentRun().at(-1)?.runId ? middleEllipsis(currentRun().at(-1)!.runId!, 12) : "idle"}</text>
        <text fg={theme().textMuted}>[R] runs</text>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <box onMouseUp={() => setFocusPanel("tree")} width="42%" flexShrink={0} border={true} borderColor={borderFor("tree")} title={view() === "runs" ? " RUNS [R] " : " SOLUTION [1] "} flexDirection="column" overflow="hidden">
          <scrollbox ref={(value) => { treeBox = value; }} flexGrow={1} minHeight={0} scrollY={true} viewportCulling={true}>
            <Show when={view() === "runs"} fallback={
              <Show when={rows().length} fallback={<text fg={theme().textMuted} padding={1}>No solution tree yet for this run. Press [R] to choose a run.</text>}>
                <SolutionTreeView rows={rows()} selectedId={selectedId()} onSelect={(id) => { setSelectedId(id); requestRender(); }} activationTime={activationTime} width={treeWidth} theme={theme()} />
              </Show>
            }>
              <Show when={runItems().length} fallback={<text fg={theme().textMuted} padding={1}>No LangGraph runs found yet.</text>}>
                <RunListView items={runItems()} selectedId={selectedRunId()} onSelect={(id) => { setSelectedRunId(id); requestRender(); }} width={treeWidth} theme={theme()} />
              </Show>
            </Show>
          </scrollbox>
        </box>
        <box onMouseUp={() => setFocusPanel("detail")} flexGrow={1} minWidth={30} border={true} borderColor={borderFor("detail")} title={` DETAILS [2] :: ${view() === "runs" ? (selectedRunId()?.slice(0, 8) ?? "NONE") : (selectedId() ?? "NONE")} `} flexDirection="column" overflow="hidden">
          <scrollbox ref={(value) => { detailBox = value; }} flexGrow={1} minHeight={0} scrollY={true} viewportCulling={true}>
            <Show when={view() === "runs"} fallback={
              <Show when={selectedActivation()} fallback={<RegionDetailView semantic={solution()} regionId={selectedRegionId()} theme={theme()} />}>
                {(activation) => <ActivationDetailView activation={activation()} event={selectedActivationEvent()} promptEvent={selectedActivationPrompt()} tab={detailTab()} onTab={(tab) => { setDetailTab(tab); requestRender(); }} theme={theme()} />}
              </Show>
            }>
              <Show when={selectedRunItem()} fallback={<text fg={theme().textMuted} padding={1}>Select a run.</text>}>
                {(item) => <RunDetailView item={item()} theme={theme()} />}
              </Show>
            </Show>
          </scrollbox>
        </box>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
        <text fg={focus() === "tree" && view() === "tree" ? theme().primary : theme().textMuted}><b>[1] Tree</b></text>
        <text fg={focus() === "detail" ? theme().primary : theme().textMuted}><b>[2] Details</b></text>
        <text fg={view() === "runs" ? theme().primary : theme().textMuted}><b>[R] Runs</b></text>
        <text fg={theme().textMuted}>·</text>
        <text fg={theme().textMuted}>[Tab] next pane · [Enter] open · [O/P] output/prompt · [↑↓] select · [Q] back</text>
      </box>
    </box>
  );
}

export const tui: TuiPlugin = async (api) => {
  let activeSessionId: string | undefined;
  const graphToggle = createGraphToggleController(api);
  api.event.on("session.created", (event) => {
    if (!event.properties.info.parentID && path.resolve(event.properties.info.directory) === path.resolve(projectPath(api))) {
      graphToggle.adopt(event.properties.sessionID);
    }
  });
  api.event.on("tui.session.select", (event) => {
    graphToggle.adopt(event.properties.sessionID);
    activeSessionId = event.properties.sessionID;
  });
  api.slots.register({
    order: 120,
    slots: {
      home_prompt_right() { activeSessionId = undefined; return <GraphToggle api={api} graph={graphToggle} />; },
      sidebar_content(_context, props) { activeSessionId = props.session_id; return <Sidebar api={api} session_id={props.session_id} />; },
      session_prompt_right(_context, props) { activeSessionId = props.session_id; return <GraphToggle api={api} session_id={props.session_id} graph={graphToggle} />; },
    },
  });
  const renderGraph = ({ params }: { params?: Record<string, unknown> }) => <GraphRoute api={api} rootSessionId={typeof params?.sessionID === "string" ? params.sessionID : activeSessionId} userMessageId={typeof params?.messageID === "string" ? params.messageID : undefined} runID={typeof params?.runID === "string" ? params.runID : undefined} chooser={params?.runs === true} />;
  api.route.register([{ name: "langgraph.graph", render: renderGraph }]);
  api.keymap.registerLayer({
    commands: [
      { name: "langgraph.graph.open", title: "Open latest LangGraph execution", slashName: "graph", category: "LangGraph", namespace: "palette", run() {
        const id = sessionId(api) ?? activeSessionId;
        if (readVisibleEvents(id, projectPath(api), stateHome(api)).length) openGraph(api, activeSessionId);
        else showRunSelector(api);
      } },
      { name: "langgraph.graph.runs", title: "Inspect a past LangGraph run", slashName: "graph-open", category: "LangGraph", namespace: "palette", run() { showRunSelector(api); } },
      { name: "langgraph.graph.toggle", title: "Toggle LangGraph for this session", slashName: "graph-toggle", category: "LangGraph", namespace: "palette", run() { graphToggle.toggle(api.route.current.name === "home" ? undefined : sessionId(api) ?? activeSessionId); } },
      { name: "langgraph.graph.select", title: "Select LangGraph for this session", slashName: "graph-select", category: "LangGraph", namespace: "palette", async run() { await showGraphSelector(api, api.route.current.name === "home" ? undefined : sessionId(api) ?? activeSessionId, graphToggle); } },
      { name: "langgraph.graph.models", title: "Assign LangGraph role models", slashName: "graph-models", category: "LangGraph", namespace: "palette", run() { showModelAssignments(api, api.route.current.name === "home" ? undefined : sessionId(api) ?? activeSessionId, graphToggle); } },
      { name: "langgraph.graph.help", title: "Open LangGraph help", slashName: "graph-help", category: "LangGraph", namespace: "palette", run() { showGraphHelp(api); } },
    ],
    bindings: [
      { key: "f7", cmd: "langgraph.graph.toggle", desc: "Toggle LangGraph" },
      { key: "f8", cmd: "langgraph.graph.open", desc: "Open LangGraph" },
      { key: "f9", cmd: "langgraph.graph.help", desc: "LangGraph help" },
    ],
  });
};

const plugin: TuiPluginModule = { id: "opencode-langgraph", tui };
export default plugin;
