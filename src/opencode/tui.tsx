/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import path from "node:path";
import { loadConnectorDefinition } from "../core/config.js";
import { adoptHomeGraphState, readHomeGraphState, readLatestProjectEvents, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, type PluginRunEvent } from "./store.js";

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
      { name: "langgraph.view.graph", title: "LangGraph: focus graph", run: controls.graph },
      { name: "langgraph.view.topology", title: "LangGraph: show topology", run: controls.topology },
      { name: "langgraph.view.nodes", title: "LangGraph: focus executions", run: controls.nodes },
      { name: "langgraph.view.output", title: "LangGraph: focus output", run: controls.output },
      { name: "langgraph.view.state", title: "LangGraph: inspect state", run: controls.state },
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
  if (event.status === "active" || event.status === "interrupted") return theme.warning;
  if (event.status === "completed") return theme.success;
  return theme.textMuted;
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

function planId(value: string): number { const parsed = Number(value.replace(/^p/, "")); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER; }

export function renderPlanTree(events: PluginRunEvent[]): string {
  const runId = latestRunId(events);
  const snapshot = events.filter((event) => event.runId === runId && event.progress).at(-1)?.progress;
  if (!snapshot?.nodes.length) return "";
  const byParent = new Map<string | undefined, typeof snapshot.nodes>();
  for (const node of snapshot.nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  const glyph = (value: string) => value === "verified" ? "✓" : value === "implemented" ? "■" : value === "expanded" ? "◇" : value === "active" || value === "implementing" ? "▶" : value === "failed" ? "×" : value === "removed" ? "·" : value === "ready" ? "◆" : "○";
  const usage = snapshot.usage;
  const calls = snapshot.callsUsed !== undefined && snapshot.callBudget !== undefined ? Math.min(1, snapshot.callsUsed / snapshot.callBudget) : undefined;
  const callBar = calls === undefined ? "" : `${"█".repeat(Math.round(calls * 10))}${"░".repeat(10 - Math.round(calls * 10))}`;
  const lines = [
    `LOD  ${snapshot.phase.toUpperCase()}${snapshot.scope ? ` / ${snapshot.scope.toUpperCase()}` : ""}`,
    snapshot.callsUsed !== undefined ? `CALLS  ${callBar} ${snapshot.callsUsed}/${snapshot.callBudget ?? "?"}${usage ? `   TURNS ${usage.turns}` : ""}` : "",
    usage ? `TOKENS  ${compactNumber(usage.input)} input · ${compactNumber(usage.cacheRead)} cached` : "",
    "",
  ].filter((line, index, all) => line || index === all.length - 1);
  const visit = (parentId: string | undefined, prefix: string) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => planId(a.id) - planId(b.id) || a.id.localeCompare(b.id));
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      const branch = `${prefix}${last ? "└─" : "├─"}`;
      const continuation = `${prefix}${last ? "   " : "│  "}`;
      const metrics = [`LOD ${node.depth}`, node.status.toUpperCase(), node.evidence ? `${node.evidence} EVIDENCE` : "", node.confidence !== undefined ? `${Math.round(node.confidence * 100)}%` : ""].filter(Boolean).map((value) => `[${value}]`).join(" ");
      lines.push(`${branch} ${glyph(node.status)} ${node.id}  ${node.title}`, `${continuation}   ${node.level}`, `${continuation}   ${metrics}`);
      visit(node.id, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  visit(undefined, "");
  if (snapshot.summary) lines.push("", snapshot.summary);
  return lines.join("\n");
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
    adopt(id) {
      if (!adoptHomeGraphState(id, projectPath(api), stateHome(api))) return;
      setRevision((value) => value + 1);
      api.renderer.requestRender();
    },
  };
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
/graph-select choose · /graph-toggle auto
/run-graph <task> once · /graph-cancel stop

VIEW
1 plan · G run graph · 2 executions · 3 output · T state

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
  const nodes = createMemo(() => executions(events()).slice(-6));
  const spinner = useSpinner(events, props.api);
  const theme = () => props.api.theme.current;
  const semantic = createMemo(() => events().filter((event) => event.progress).at(-1)?.progress);
  return (
    <Show when={nodes().length > 0}>
      <box paddingTop={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text}><b>LANGGRAPH</b></text>
          <text fg={theme().textMuted}>{events().at(-1)?.graph ?? "graph"}</text>
        </box>
        <Show when={semantic()}>{(value) => (
          <box flexDirection="column">
            <text fg={theme().textMuted}>{value().phase} · {value().scope ?? "classifying"} · {value().callsUsed ?? 0}/{value().callBudget ?? "?"}{value().usage ? ` · ${value().usage!.turns}t · ${compactNumber(value().usage!.input)}in` : ""}</text>
            <Show when={value().nodes.find((node) => node.id === value().activeNodeId)}>{(node) => <text fg={theme().warning} wrapMode="word">▶ {node().title}</text>}</Show>
          </box>
        )}</Show>
        <For each={nodes()}>{(event) => (
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(event, theme())}>{status(event, spinner())}</text>
              <text fg={theme().text} wrapMode="none"><b>{event.node.replaceAll("_", " ")}</b></text>
              <text fg={statusColor(event, theme())}>{event.status}</text>
            </box>
            <text fg={theme().textMuted} wrapMode="none">  {event.agent}  {event.model}</text>
            <Show when={event.usage}>{(usage) => <text fg={theme().textMuted} wrapMode="none">  {usage().turns}t · {compactNumber(usage().input)}in · {compactNumber(usage().cacheRead)}cache</text>}</Show>
          </box>
        )}</For>
      </box>
    </Show>
  );
}

function GraphRoute(props: { api: TuiPluginApi; rootSessionId?: string; userMessageId?: string }) {
  const [rootSessionId] = createSignal(props.rootSessionId);
  const events = useEvents(() => rootSessionId(), () => projectPath(props.api), () => stateHome(props.api), () => props.userMessageId);
  const spinner = useSpinner(events, props.api);
  const planTree = createMemo(() => renderPlanTree(events()));
  const nodes = createMemo(() => executions(events()));
  const currentRun = createMemo(() => latest(events()));
  const [scrollPosition, setScrollPosition] = createSignal({ x: 0, y: 0 });
  const [selected, setSelected] = createSignal(initialSelection(events()));
  const layout = createMemo(() => renderEventGraph(events(), spinner(), selected()));
  const [pane, setPane] = createSignal<"plan" | "topology" | "nodes" | "output">(planTree() ? "plan" : "topology");
  const [detail, setDetail] = createSignal<"output" | "state">("output");
  const [keymapReady, setKeymapReady] = createSignal(false);
  let canvas: BoxRenderable | undefined;
  let outputBox: ScrollBoxRenderable | undefined;
  let planBox: ScrollBoxRenderable | undefined;
  const theme = () => props.api.theme.current;
  const selectedEvent = createMemo(() => nodes()[Math.min(selected(), Math.max(0, nodes().length - 1))]);
  const activatePane = (value: "plan" | "topology" | "nodes" | "output") => {
    setPane(value);
    props.api.renderer.requestRender();
  };
  const selectPrevious = () => {
    setSelected((value) => Math.max(0, value - 1));
    outputBox?.scrollTo(0);
    props.api.renderer.requestRender();
  };
  const selectNext = () => {
    setSelected((value) => Math.min(nodes().length - 1, value + 1));
    outputBox?.scrollTo(0);
    props.api.renderer.requestRender();
  };
  const back = () => {
    if (rootSessionId()) props.api.route.navigate("session", { sessionID: rootSessionId()! });
    else props.api.route.navigate("home");
  };
  const moveGraph = (update: (position: { x: number; y: number }) => { x: number; y: number }) => {
    setScrollPosition(update);
    const position = scrollPosition();
    if (canvas) canvas.setPosition({ left: -position.x, top: -position.y });
    props.api.renderer.requestRender();
  };
  const controls: GraphControls = {
    back,
    cycle: () => activatePane(pane() === "plan" ? "topology" : pane() === "topology" ? "nodes" : pane() === "nodes" ? "output" : "plan"),
    graph: () => activatePane("plan"),
    topology: () => activatePane("topology"),
    nodes: () => activatePane("nodes"),
    output: () => { setDetail("output"); activatePane("output"); outputBox?.scrollTo(0); },
    state: () => { setDetail("state"); activatePane("output"); outputBox?.scrollTo(0); },
    previous: selectPrevious,
    next: selectNext,
    inspect: () => { if (pane() === "nodes") { activatePane("output"); outputBox?.scrollTo(0); } },
    up: () => {
      if (pane() === "nodes") selectPrevious();
      else if (pane() === "output") outputBox?.scrollBy(-3);
      else if (pane() === "plan") planBox?.scrollBy(-3);
      else if (pane() === "topology") moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 4) }));
    },
    down: () => {
      if (pane() === "nodes") selectNext();
      else if (pane() === "output") outputBox?.scrollBy(3);
      else if (pane() === "plan") planBox?.scrollBy(3);
      else if (pane() === "topology") moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 4) }));
    },
    left: () => { if (pane() === "topology") moveGraph(({ x, y }) => ({ x: Math.max(0, x - 8), y })); },
    right: () => { if (pane() === "topology") moveGraph(({ x, y }) => ({ x: Math.min(Math.max(0, layout().width - 20), x + 8), y })); },
    pageUp: () => {
      if (pane() === "output") outputBox?.scrollBy(-12);
      else if (pane() === "plan") planBox?.scrollBy(-12);
      else if (pane() === "topology") moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 12) }));
    },
    pageDown: () => {
      if (pane() === "output") outputBox?.scrollBy(12);
      else if (pane() === "plan") planBox?.scrollBy(12);
      else if (pane() === "topology") moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 12) }));
    },
    home: () => {
      if (pane() === "output") outputBox?.scrollTo(0);
      else if (pane() === "plan") planBox?.scrollTo(0);
      else if (pane() === "topology") moveGraph(() => ({ x: 0, y: 0 }));
    },
    end: () => {
      if (pane() === "output" && outputBox) outputBox.scrollTo(outputBox.scrollHeight);
      if (pane() === "plan" && planBox) planBox.scrollTo(planBox.scrollHeight);
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
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" flexDirection="column" padding={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme().primary}><b>LANGGRAPH</b></text>
        <text fg={theme().textMuted}>{currentRun().at(-1)?.graph ?? "no run"} · {currentRun().at(-1)?.runId ?? "idle"}</text>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <box onMouseUp={() => activatePane(planTree() ? "plan" : "topology")} width="62%" flexShrink={0} border={true} borderColor={pane() === "plan" || pane() === "topology" ? theme().primary : theme().border} title={pane() === "topology" ? ` RUN GRAPH [G] · PLAN [1] · PAN [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down", "langgraph.navigate.left", "langgraph.navigate.right"], "ARROWS")}] ` : ` PLAN [1] · RUN GRAPH [G] · SCROLL [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} overflow="hidden">
          <Show when={pane() === "plan" && planTree()} fallback={
            <Show when={layout().canvas} fallback={<text fg={theme().textMuted}>No LangGraph execution has run in this project.</text>}>
              <box ref={(value) => { canvas = value; }} position="absolute" left={0} top={0} width={layout().width} height={layout().height} flexShrink={0}>
                <text position="absolute" left={0} top={0} fg={theme().text}>{layout().canvas}</text>
              </box>
            </Show>
          }><scrollbox ref={(value) => { planBox = value; }} flexGrow={1} minHeight={0} scrollY={true} scrollX={true} viewportCulling={true}><text fg={theme().text}>{planTree()}</text></scrollbox></Show>
        </box>
        <box flexGrow={1} minWidth={24} flexDirection="column" gap={1}>
          <box onMouseUp={() => activatePane("nodes")} height="38%" minHeight={6} border={true} borderColor={pane() === "nodes" ? theme().primary : theme().border} title={` EXECUTIONS ${Math.min(selected() + 1, nodes().length)}/${nodes().length} [${keyHint(["langgraph.view.nodes"], "2")}] · SELECT [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} flexDirection="column" overflow="hidden">
            <Show when={nodes().length} fallback={<text fg={theme().textMuted}>No nodes executed.</text>}>
              <For each={nodes()}>{(item, index) => (
                <box onMouseUp={() => { setSelected(index()); setPane("nodes"); }} flexDirection="row" gap={1}>
                  <text fg={selected() === index() ? theme().primary : theme().textMuted}>{selected() === index() ? "›" : " "}</text>
                  <text fg={statusColor(item, theme())}>{status(item, spinner())}</text>
                  <text fg={selected() === index() ? theme().text : theme().textMuted} wrapMode="none">{item.node.replaceAll("_", " ")}</text>
                  <text fg={theme().textMuted} wrapMode="none">{item.agent}</text>
                </box>
              )}</For>
            </Show>
          </box>
          <box onMouseUp={() => activatePane("output")} flexGrow={1} minHeight={8} border={true} borderColor={pane() === "output" ? theme().primary : theme().border} title={` ${detail().toUpperCase()} [${keyHint(["langgraph.view.output"], "3")}] · STATE [${keyHint(["langgraph.view.state"], "T")}] · SCROLL [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down"], "UP/DOWN")}] `} flexDirection="column">
            <Show when={selectedEvent()} fallback={<text fg={theme().textMuted}>Select an execution.</text>}>
              {(item) => <>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={statusColor(item(), theme())}><b>{status(item(), spinner())} {item().node}</b></text>
                  <text fg={theme().textMuted}>{item().agent} · {item().model}</text>
                </box>
                <scrollbox ref={(value) => { outputBox = value; }} flexGrow={1} minHeight={0} scrollY={true} scrollX={true} viewportCulling={true}>
                  <text fg={theme().text}>{detail() === "output" ? item().text || (item().status === "active" ? `${spinner()} Model is running…` : "No model output captured for this execution.") : printable(item().state)}</text>
                </scrollbox>
              </>}
            </Show>
          </box>
        </box>
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
