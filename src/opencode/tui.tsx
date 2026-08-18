/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import path from "node:path";
import { accessSync, constants } from "node:fs";
import { loadConnectorDefinition } from "../core/config.js";
import type { ModelDefinition, SolutionPresetRole, SolutionRoleModelAssignments, SolutionSemanticSnapshot } from "../core/types.js";
import { adoptHomeGraphState, readHomeGraphState, readLatestProjectEvents, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readSessionGraphState, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphModelAssignments, writeSessionGraphName, type PluginRunEvent } from "./store.js";

function sessionId(api: TuiPluginApi): string | undefined {
  const value = api.route.current.name === "session" && "params" in api.route.current ? api.route.current.params?.sessionID : undefined;
  return typeof value === "string" ? value : undefined;
}

function openGraph(api: TuiPluginApi, fallbackSessionId?: string, userMessageId?: string): void {
  const id = sessionId(api) ?? fallbackSessionId;
  api.route.navigate("langgraph.graph", id ? { sessionID: id, ...(userMessageId ? { messageID: userMessageId } : {}) } : undefined);
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
  graph(): void;
  topology(): void;
  nodes(): void;
  output(): void;
  state(): void;
  prompt(): void;
  previous(): void;
  next(): void;
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
      { name: "langgraph.view.graph", title: "LangGraph: show activity", run: controls.graph },
      { name: "langgraph.view.topology", title: "LangGraph: show topology", run: controls.topology },
      { name: "langgraph.view.nodes", title: "LangGraph: show plan", run: controls.nodes },
      { name: "langgraph.view.output", title: "LangGraph: focus output", run: controls.output },
      { name: "langgraph.view.state", title: "LangGraph: inspect state", run: controls.state },
      { name: "langgraph.view.prompt", title: "LangGraph: inspect effective prompt", run: controls.prompt },
      { name: "langgraph.node.previous", title: "LangGraph: previous execution", run: controls.previous },
      { name: "langgraph.node.next", title: "LangGraph: next execution", run: controls.next },
      { name: "langgraph.node.inspect", title: "LangGraph: inspect execution", run: controls.inspect },
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
      { key: "1", cmd: "langgraph.view.graph" },
      { key: "g", cmd: "langgraph.view.topology" },
      { key: "2", cmd: "langgraph.view.nodes" },
      { key: "n", cmd: "langgraph.view.nodes" },
      { key: "3", cmd: "langgraph.view.output" },
      { key: "o", cmd: "langgraph.view.output" },
      { key: "t", cmd: "langgraph.view.state" },
      { key: "4", cmd: "langgraph.view.prompt" },
      { key: "p", cmd: "langgraph.view.prompt" },
      { key: "return", cmd: "langgraph.node.inspect" },
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

function renderActivationGraph(snapshot: SolutionSemanticSnapshot | undefined): AsciiGraph {
  if (!snapshot?.activations.length) return { width: 0, height: 0, canvas: "" };
  const canvas = snapshot.activations.map((activation) => {
    const sender = activation.senderActivationId ? `${activation.senderActivationId} ──▶ ` : "seed ──▶ ";
    const glyph = activation.status === "completed" ? "✓" : activation.status === "running" ? "▶" : activation.status === "failed" ? "×" : activation.status === "waiting" ? "◇" : "○";
    return `${glyph} ${sender}${activation.id}:${activation.capability} [${activation.regionId}]\n  └─ ${middleEllipsis(activation.expectedDelta, 72)}`;
  }).join("\n      │\n");
  const rows = canvas.split("\n");
  return { canvas, width: Math.max(...rows.map((row) => [...row].length)), height: rows.length };
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

function printable(value: unknown): string {
  if (value === undefined) return "No state captured for this execution.";
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2); }
  catch { return String(value); }
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function planId(value: string): number { const parsed = Number(value.replace(/^[a-z]+/, "")); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER; }

function progressSnapshot(events: PluginRunEvent[]): ProgressSnapshot | undefined {
  const runId = latestRunId(events);
  return events.filter((event) => event.runId === runId && event.progress).at(-1)?.progress;
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
    lines.push(`${branch} ${planGlyph(node.status)} ${node.id}  ${node.title}`, `${continuation}   ${node.level}`, `${continuation}   ${metrics} ${agents}`);
  }
  if (snapshot.summary) lines.push("", snapshot.summary);
  return lines.join("\n");
}

function PlanTreeView(props: { events: PluginRunEvent[]; theme: Theme; selectedRegionId?: string; onSelect?: (id: string) => void }) {
  const snapshot = createMemo(() => progressSnapshot(props.events));
  const rows = createMemo(() => snapshot() ? planRows(snapshot()!) : []);
  const calls = createMemo(() => {
    const value = snapshot();
    return value?.callsUsed !== undefined && value.callBudget ? Math.min(1, value.callsUsed / value.callBudget) : undefined;
  });
  const callBar = createMemo(() => calls() === undefined ? "·".repeat(10) : `${"█".repeat(Math.round(calls()! * 10))}${"░".repeat(10 - Math.round(calls()! * 10))}`);
  return (
    <Show when={snapshot()}>{(value) => (
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={statusTone(value().phase, props.theme)}><b>[{value().phase.toUpperCase()}]</b></text>
          <Show when={value().scope}><text fg={props.theme.secondary}>[{value().scope!.toUpperCase()}]</text></Show>
          <text fg={props.theme.textMuted}>SOLUTION LOD TREE</text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={props.theme.info}>ACTIVATIONS {value().callsUsed ?? 0}</text>
          <Show when={value().usage}>{(usage) => <text fg={props.theme.textMuted}>TURN:{usage().turns} IN:{compactNumber(usage().input)} CACHE:{compactNumber(usage().cacheRead)}</text>}</Show>
          <Show when={value().usage}>{(usage) => (
            <Show when={value().costBudget !== undefined}><text fg={props.theme.warning}>COST ${usage().cost.toFixed(3)}/${value().costBudget!.toFixed(2)}</text></Show>
          )}</Show>
        </box>
        <For each={rows()}>{({ node, branch, continuation }) => (
          <box flexDirection="column" onMouseUp={() => props.onSelect?.(node.id)}>
            <box flexDirection="row" gap={1}>
              <text fg={statusTone(node.status, props.theme)}>{props.selectedRegionId === node.id ? "›" : " "}{branch} {planGlyph(node.status)} <b>{node.id}</b></text>
              <text fg={props.selectedRegionId === node.id ? props.theme.primary : props.theme.text}><b>{node.title}</b></text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={props.theme.borderSubtle}>{continuation}   ├─</text>
              <text fg={props.theme.textMuted}>{node.level}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={props.theme.borderSubtle}>{continuation}   └─</text>
              <text fg={statusTone(node.status, props.theme)}>{node.status} · {node.level}</text>
              <Show when={node.evidence}><text fg={props.theme.info}>· {node.evidence} ev</text></Show>
              <Show when={node.confidence !== undefined}><text fg={props.theme.secondary}>· {Math.round(node.confidence! * 100)}%</text></Show>
              <Show when={node.dependencies?.length}><text fg={props.theme.warning}>· after {node.dependencies!.join(",")}</text></Show>
              <For each={node.agents?.length ? node.agents : ["controller"]}>{(agent) => <text fg={roleColor(agent, props.theme)}>· {shortAgent(agent)}</text>}</For>
            </box>
          </box>
        )}</For>
        <Show when={value().summary}><text fg={props.theme.textMuted}>// {value().summary}</text></Show>
      </box>
    )}</Show>
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
  const activations = createMemo(() => props.semantic?.activations.filter((item) => item.regionId === props.regionId) ?? []);
  const artifacts = createMemo(() => props.semantic?.artifacts.filter((item) => item.regionId === props.regionId) ?? []);
  return <Show when={region()} fallback={<text fg={props.theme.textMuted} padding={1}>Select a solution region.</text>}>{(item) => (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={statusTone(item().status, props.theme)}><b>{planGlyph(item().status)} {item().id} · L{item().lod}</b></text>
        <text fg={props.theme.secondary}>[{item().edge.toUpperCase()}]</text>
        <text fg={props.theme.textMuted}>{item().viable}/{item().total} viable</text>
      </box>
      <text fg={props.theme.text} wrapMode="word"><b>{item().objective}</b></text>
      <text fg={props.theme.textMuted}>DOMAIN</text>
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
      <For each={evidence()}>{(fact) => <text fg={props.theme.info} wrapMode="word">  {fact.id} {fact.text} · {fact.source}</text>}</For>
      <Show when={activations().length}><text fg={props.theme.textMuted}>ACTIVATIONS</text></Show>
      <For each={activations()}>{(activation) => <text fg={roleColor(activation.capability, props.theme)} wrapMode="word">  [{activation.status}] {activation.senderActivationId ? `${activation.senderActivationId} → ` : ""}{activation.id}:{activation.capability} · {activation.expectedDelta}{activation.error ? ` · ${activation.error}` : ""}</text>}</For>
      <Show when={artifacts().length}><text fg={props.theme.textMuted}>ARTIFACTS</text></Show>
      <For each={artifacts()}>{(artifact) => <text fg={artifact.passed === false ? props.theme.error : props.theme.success} wrapMode="word">  {artifact.kind} {artifact.path ?? artifact.summary}</text>}</For>
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

function initialSelection(events: PluginRunEvent[]): number {
  const items = executions(events);
  const agent = items.findLastIndex((event) => event.agent !== "langgraph" && Boolean(event.text));
  return agent >= 0 ? agent : Math.max(0, items.length - 1);
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

export function readVisibleEvents(rootSessionId: string | undefined, worktree: string, stateHome: string, userMessageId?: string): PluginRunEvent[] {
  if (rootSessionId) return eventsForMessage(readPluginEvents(rootSessionId, stateHome), userMessageId);
  return eventsForMessage(readLatestProjectEvents(worktree, stateHome), userMessageId);
}

function useEvents(rootSessionId: () => string | undefined, worktree: () => string, stateHome: () => string, userMessageId: () => string | undefined = () => undefined) {
  const read = () => readVisibleEvents(rootSessionId(), worktree(), stateHome(), userMessageId());
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

export function graphHelpText(): string {
  return `[F7] toggle · [F8] view · [F9] help

USE
/graph-select choose · /graph-models assign roles · /graph-toggle auto
/run-graph <task> once · /graph-resume <answer> · /graph-cancel stop

VIEW · panels
1 plan · G topology · 2 trace · 3 inspect
Tab next panel · ↑↓ move/scroll · ←→ pan topology
Enter inspect · O output · P prompt · T state · Q back

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
            <Show when={value().nodes.find((node) => node.id === value().activeNodeId)}>{(node) => <text fg={statusTone(node().status, theme())} wrapMode="word">{planGlyph(node().status)} {node().id} {node().title}</text>}</Show>
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
            <Show when={event().usage}>{(usage) => <text fg={theme().textMuted} wrapMode="none">  {usage().turns}t · {compactNumber(usage().input)}in · {compactNumber(usage().cacheRead)}cache</text>}</Show>
          </box>
        )}</Show>
      </box>
    </Show>
  );
}

function GraphRoute(props: { api: TuiPluginApi; rootSessionId?: string; userMessageId?: string }) {
  const [rootSessionId] = createSignal(props.rootSessionId);
  const events = useEvents(() => rootSessionId(), () => projectPath(props.api), () => stateHome(props.api), () => props.userMessageId);
  const spinner = useSpinner(events, props.api);
  const nodes = createMemo(() => executions(events()));
  const currentRun = createMemo(() => latest(events()));
  const semantic = createMemo(() => progressSnapshot(events()));
  const solution = createMemo(() => semanticSnapshot(events()));
  const activePlan = createMemo(() => semantic()?.nodes.find((node) => node.id === semantic()?.activeNodeId));
  const [scrollPosition, setScrollPosition] = createSignal({ x: 0, y: 0 });
  const [selected, setSelected] = createSignal(initialSelection(events()));
  const [followLatest, setFollowLatest] = createSignal(true);
  const layout = createMemo(() => renderActivationGraph(solution()));
  const [focus, setFocus] = createSignal<"plan" | "trace" | "inspect">("plan");
  const [leftView, setLeftView] = createSignal<"plan" | "topology">(semantic()?.nodes.length ? "plan" : "topology");
  const [detail, setDetail] = createSignal<"output" | "state" | "prompt">("output");
  const [selectedRegionId, setSelectedRegionId] = createSignal(semantic()?.activeNodeId ?? solution()?.regions[0]?.id);
  const [keymapReady, setKeymapReady] = createSignal(false);
  let canvas: BoxRenderable | undefined;
  let outputBox: ScrollBoxRenderable | undefined;
  let planBox: ScrollBoxRenderable | undefined;
  let traceBox: ScrollBoxRenderable | undefined;
  const theme = () => props.api.theme.current;
  const selectedEvent = createMemo(() => nodes()[Math.min(selected(), Math.max(0, nodes().length - 1))]);
  const selectedPromptEvent = createMemo(() => {
    const item = selectedEvent();
    if (!item) return;
    return events().findLast((event) => event.runId === item.runId && event.node === item.node && Boolean(event.prompt) && (!item.sessionId || event.sessionId === item.sessionId));
  });
  const requestRender = () => props.api.renderer.requestRender();
  const setFocusPanel = (value: "plan" | "trace" | "inspect") => { setFocus(value); requestRender(); };
  const selectPrevious = () => { setFollowLatest(false); setSelected((value) => Math.max(0, value - 1)); outputBox?.scrollTo(0); requestRender(); };
  const selectNext = () => {
    setSelected((value) => {
      const next = Math.min(nodes().length - 1, value + 1);
      setFollowLatest(next === nodes().length - 1);
      return next;
    });
    outputBox?.scrollTo(0);
    requestRender();
  };
  const back = () => {
    if (rootSessionId()) props.api.route.navigate("session", { sessionID: rootSessionId()! });
    else props.api.route.navigate("home");
  };
  const moveGraph = (update: (position: { x: number; y: number }) => { x: number; y: number }) => {
    setScrollPosition(update);
    const position = scrollPosition();
    if (canvas) canvas.setPosition({ left: -position.x, top: -position.y });
    requestRender();
  };
  const controls: GraphControls = {
    back,
    cycle: () => setFocusPanel(focus() === "plan" ? "trace" : focus() === "trace" ? "inspect" : "plan"),
    graph: () => { setLeftView("plan"); setFocusPanel("plan"); },
    topology: () => { setLeftView("topology"); setFocusPanel("plan"); },
    nodes: () => setFocusPanel("trace"),
    output: () => { setDetail("output"); setFocusPanel("inspect"); outputBox?.scrollTo(0); },
    state: () => { setDetail("state"); setFocusPanel("inspect"); outputBox?.scrollTo(0); },
    prompt: () => { setDetail("prompt"); setFocusPanel("inspect"); outputBox?.scrollTo(0); },
    previous: selectPrevious,
    next: selectNext,
    inspect: () => { setFocusPanel("inspect"); outputBox?.scrollTo(0); },
    up: () => {
      if (focus() === "plan" && leftView() === "plan") { const regions = solution()?.regions ?? []; const index = regions.findIndex((item) => item.id === selectedRegionId()); setSelectedRegionId(regions[Math.max(0, index - 1)]?.id); requestRender(); }
      else if (focus() === "trace") traceBox?.scrollBy(-3);
      else if (focus() === "inspect") outputBox?.scrollBy(-3);
      else moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 4) }));
    },
    down: () => {
      if (focus() === "plan" && leftView() === "plan") { const regions = solution()?.regions ?? []; const index = regions.findIndex((item) => item.id === selectedRegionId()); setSelectedRegionId(regions[Math.min(regions.length - 1, index + 1)]?.id); requestRender(); }
      else if (focus() === "trace") traceBox?.scrollBy(3);
      else if (focus() === "inspect") outputBox?.scrollBy(3);
      else moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 4) }));
    },
    left: () => { if (focus() === "plan" && leftView() === "topology") moveGraph(({ x, y }) => ({ x: Math.max(0, x - 8), y })); },
    right: () => { if (focus() === "plan" && leftView() === "topology") moveGraph(({ x, y }) => ({ x: Math.min(Math.max(0, layout().width - 20), x + 8), y })); },
    pageUp: () => {
      if (focus() === "inspect") outputBox?.scrollBy(-12);
      else if (focus() === "trace") traceBox?.scrollBy(-12);
      else if (leftView() === "plan") planBox?.scrollBy(-12);
      else moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 12) }));
    },
    pageDown: () => {
      if (focus() === "inspect") outputBox?.scrollBy(12);
      else if (focus() === "trace") traceBox?.scrollBy(12);
      else if (leftView() === "plan") planBox?.scrollBy(12);
      else moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 12) }));
    },
    home: () => {
      if (focus() === "inspect") outputBox?.scrollTo(0);
      else if (focus() === "trace") traceBox?.scrollTo(0);
      else if (leftView() === "plan") planBox?.scrollTo(0);
      else moveGraph(() => ({ x: 0, y: 0 }));
    },
    end: () => {
      if (focus() === "inspect" && outputBox) outputBox.scrollTo(outputBox.scrollHeight);
      else if (focus() === "trace" && traceBox) traceBox.scrollTo(traceBox.scrollHeight);
      else if (leftView() === "plan" && planBox) planBox.scrollTo(planBox.scrollHeight);
    },
  };
  const navigation = graphNavigationLayer(controls);
  const disposeNavigation = props.api.keymap.registerLayer({
    priority: 1000,
    commands: navigation.commands,
    bindings: navigation.bindings,
  });
  onCleanup(disposeNavigation);
  const keyHint = (commands: string[], fallback: string) => {
    keymapReady();
    const bindings = props.api.keymap.getCommandBindings({ commands, visibility: "registered" });
    return props.api.keys.formatBindings(commands.flatMap((command) => bindings.get(command)?.slice(0, 1) ?? [])) ?? fallback;
  };
  onMount(() => {
    setKeymapReady(true);
  });
  createEffect(() => {
    const count = nodes().length;
    if (followLatest() && count) setSelected(count - 1);
  });
  createEffect(() => {
    const regions = solution()?.regions ?? [];
    if (!regions.some((region) => region.id === selectedRegionId())) setSelectedRegionId(semantic()?.activeNodeId ?? regions[0]?.id);
  });
  const liveStatus = createMemo(() => runIsActive(events()) ? "LIVE" : currentRun().at(-1)?.status?.toUpperCase() ?? "IDLE");
  const liveColor = createMemo(() => runIsActive(events()) ? theme().warning : currentRun().at(-1)?.status === "failed" ? theme().error : theme().success);
  const borderFor = (panel: "plan" | "trace" | "inspect") => focus() === panel ? theme().borderActive : theme().border;
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" flexDirection="column" padding={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme().primary}><b>LANGGRAPH//OPS</b></text>
        <text fg={liveColor()}><b>[{liveStatus()}]</b></text>
        <text fg={theme().secondary}>[{(currentRun().at(-1)?.graph ?? "no-graph").toUpperCase()}]</text>
        <text fg={theme().textMuted}>RUN::{middleEllipsis(currentRun().at(-1)?.runId ?? "idle", 18)}</text>
        <text fg={theme().textMuted}>FOCUS::{focus().toUpperCase()}</text>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={statusTone(semantic()?.phase ?? "idle", theme())}>[{(semantic()?.phase ?? "idle").toUpperCase()}]</text>
        <Show when={activePlan()}>{(node) => <text fg={theme().text}>{planGlyph(node().status)} {node().id} {node().title}</text>}</Show>
        <Show when={semantic()?.usage}>{(usage) => <text fg={theme().textMuted}>{usage().turns}t · {compactNumber(usage().input)}in · {compactNumber(usage().cacheRead)}cache{usage().cost ? ` · $${usage().cost.toFixed(3)}` : ""}</text>}</Show>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <box onMouseUp={() => setFocusPanel("plan")} width="55%" flexShrink={0} border={true} borderColor={borderFor("plan")} title={` SOLUTION LOD [1] / ACTIVATION NETWORK [G] :: SELECT [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} flexDirection="column" overflow="hidden">
          <Show when={leftView() === "plan"} fallback={
            <Show when={layout().canvas} fallback={<text fg={theme().textMuted} padding={1}>No activation network available.</text>}>
              <box ref={(value) => { canvas = value; }} position="absolute" left={0} top={0} width={layout().width} height={layout().height} flexShrink={0}><text fg={theme().text}>{layout().canvas}</text></box>
            </Show>
          }>
            <scrollbox ref={(value) => { planBox = value; }} flexGrow={1} minHeight={0} scrollY={true} scrollX={true} viewportCulling={true}>
              <Show when={semantic()?.nodes.length} fallback={<text fg={theme().textMuted} padding={1}>No semantic solution tree is available for this graph.</text>}><PlanTreeView events={events()} theme={theme()} selectedRegionId={selectedRegionId()} onSelect={setSelectedRegionId} /></Show>
            </scrollbox>
          </Show>
        </box>
        <box flexGrow={1} minWidth={30} flexDirection="column" gap={1}>
          <box onMouseUp={() => setFocusPanel("trace")} height="58%" minHeight={10} border={true} borderColor={borderFor("trace")} title={` REGION DOMAIN [2] :: ${selectedRegionId() ?? "NONE"} :: SCROLL [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} flexDirection="column" overflow="hidden">
            <scrollbox ref={(value) => { traceBox = value; }} flexGrow={1} minHeight={0} scrollY={true} viewportCulling={true}>
              <RegionDetailView semantic={solution()} regionId={selectedRegionId()} theme={theme()} />
            </scrollbox>
          </box>
          <box onMouseUp={() => setFocusPanel("inspect")} flexGrow={1} minHeight={8} border={true} borderColor={borderFor("inspect")} title={` NODE INSPECT [3] :: ${detail().toUpperCase()} :: SCROLL [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} flexDirection="column" overflow="hidden">
            <Show when={selectedEvent()} fallback={<text fg={theme().textMuted} padding={1}>Select an execution first.</text>}>
              {(item) => <>
                <box flexDirection="row" gap={2} flexShrink={0} paddingX={1}>
                  <text onMouseUp={() => { setDetail("output"); requestRender(); }} fg={detail() === "output" ? theme().primary : theme().textMuted}><b>Output [O]</b></text>
                  <text onMouseUp={() => { setDetail("prompt"); requestRender(); }} fg={detail() === "prompt" ? theme().primary : theme().textMuted}>Prompt [P]</text>
                  <text onMouseUp={() => { setDetail("state"); requestRender(); }} fg={detail() === "state" ? theme().primary : theme().textMuted}>State [T]</text>
                </box>
                <box flexDirection="row" gap={1} flexShrink={0} paddingX={1}>
                  <text fg={statusColor(item(), theme())}><b>{status(item(), spinner())} {item().node}</b></text>
                  <text fg={statusTone(item().status, theme())}>[{item().status.toUpperCase()}]</text>
                  <text fg={roleColor(item().agent, theme())}>[{shortAgent(item().agent)}]</text>
                  <text fg={theme().textMuted}>{item().model}</text>
                  <Show when={item().usage}>{(usage) => <text fg={theme().textMuted} wrapMode="none">{usage().turns}t · {compactNumber(usage().input)}in · {compactNumber(usage().cacheRead)}cache{usage().cost ? ` · $${usage().cost.toFixed(3)}` : ""}</text>}</Show>
                </box>
                <scrollbox ref={(value) => { outputBox = value; }} flexGrow={1} minHeight={0} scrollY={true} scrollX={true} viewportCulling={true}><text fg={theme().text}>{detail() === "output" ? item().text || (item().status === "active" ? `${spinner()} Model is running…` : "No output captured.") : detail() === "prompt" ? effectivePrompt(selectedPromptEvent()) : printable(item().state)}</text></scrollbox>
              </>}
            </Show>
          </box>
        </box>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
        <text fg={focus() === "plan" ? theme().primary : theme().textMuted}><b>[1] Solution</b></text>
        <text fg={focus() === "plan" && leftView() === "topology" ? theme().primary : theme().textMuted}>[G] Activations</text>
        <text fg={focus() === "trace" ? theme().primary : theme().textMuted}><b>[2] Region</b></text>
        <text fg={focus() === "inspect" ? theme().primary : theme().textMuted}><b>[3] Diagnostic</b></text>
        <text fg={theme().textMuted}>·</text>
        <text fg={theme().textMuted}>[Tab] next · [Enter] inspect · [O/P/T] output/prompt/state · [↑↓] move · [PgUp/PgDn] page · [Q] back</text>
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
  const renderGraph = ({ params }: { params?: Record<string, unknown> }) => <GraphRoute api={api} rootSessionId={typeof params?.sessionID === "string" ? params.sessionID : activeSessionId} userMessageId={typeof params?.messageID === "string" ? params.messageID : undefined} />;
  api.route.register([{ name: "langgraph.graph", render: renderGraph }]);
  api.keymap.registerLayer({
    commands: [
      { name: "langgraph.graph.open", title: "Open latest LangGraph execution", slashName: "graph", category: "LangGraph", namespace: "palette", run() { openGraph(api, activeSessionId); } },
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
