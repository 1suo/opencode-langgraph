/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { renderMermaidASCII } from "beautiful-mermaid";
import path from "node:path";
import { readLatestLocalEvents, readLatestProjectEvents, readPluginEvents, readSessionGraphEnabled, writeSessionGraphEnabled, type PluginRunEvent } from "./store.js";

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

function ordered(events: PluginRunEvent[]): PluginRunEvent[] {
  const runId = latestRunId(events);
  const current = events.filter((event) => event.runId === runId);
  const topology = current.find((event) => event.topology)?.topology;
  if (!topology) return latest(events);
  const byNode = new Map(latest(events).map((event) => [event.node, event]));
  return topology.nodes.map((node) => byNode.get(node) ?? { ...current[0], node, status: "pending", agent: "—", model: "—" });
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
      { key: "g", cmd: "langgraph.view.graph" },
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

function mermaidId(value: string): string {
  return `n_${value.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function renderSource(events: PluginRunEvent[], nodes: PluginRunEvent[], activeGlyph: string): string {
  const canonical = events.findLast((event) => event.mermaid)?.mermaid;
  if (canonical) {
    const lines = canonical.trim().replace(/;\s*$/gm, "").replaceAll("&nbsp;", " ").split("\n");
    const declarations = nodes.map((event) => {
      const name = event.node === "__start__" ? "START" : event.node === "__end__" ? "END" : event.node.replaceAll("_", " ");
      return `  ${event.node}["${`${status(event, activeGlyph)} ${name}`.replaceAll('"', "'")}"]`;
    });
    lines.splice(1, 0, ...declarations);
    return lines.join("\n");
  }
  const topology = events.findLast((event) => event.topology)?.topology;
  if (!topology) return "";
  const lines = ["graph TD"];
  for (const event of nodes) {
    const name = event.node === "__start__" ? "START" : event.node === "__end__" ? "END" : event.node.replaceAll("_", " ");
    const label = `${status(event, activeGlyph)} ${name}`.replaceAll('"', "'");
    lines.push(`  ${mermaidId(event.node)}["${label}"]`);
  }
  for (const edge of topology.edges) lines.push(`  ${mermaidId(edge.source)} --> ${mermaidId(edge.target)}`);
  return lines.join("\n");
}

export function renderEventGraph(events: PluginRunEvent[], activeGlyph = "▶"): AsciiGraph {
  const nodes = ordered(events);
  const source = renderSource(events, nodes, activeGlyph);
  if (!nodes.length || !source) return { width: 0, height: 0, canvas: "" };
  const canvas = renderMermaidASCII(source, { colorMode: "none", paddingX: 3, paddingY: 2, boxBorderPadding: 1 });
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
  const agent = items.findLastIndex((event) => event.agent !== "langgraph" && event.agent !== "neolit" && Boolean(event.text));
  return agent >= 0 ? agent : Math.max(0, items.length - 1);
}

function projectPath(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory || process.cwd();
}

function stateHome(api: TuiPluginApi): string {
  const marker = `${path.sep}.config${path.sep}`;
  const configIndex = api.state.path.config.indexOf(marker);
  if (configIndex >= 0) return path.join(api.state.path.config.slice(0, configIndex), ".local", "state");
  return process.env.OPENCODE_LANGGRAPH_STATE_HOME || process.env.NEOLIT_STATE_HOME || path.join(process.cwd(), ".opencode-langgraph-state");
}

function eventsForMessage(events: PluginRunEvent[], userMessageId?: string): PluginRunEvent[] {
  if (!userMessageId) return events;
  const linked = events.filter((event) => event.userMessageId === userMessageId);
  const runId = latestRunId(linked);
  return runId ? events.filter((event) => event.runId === runId) : [];
}

export function readVisibleEvents(rootSessionId: string | undefined, worktree: string, stateHome: string, userMessageId?: string): PluginRunEvent[] {
  if (rootSessionId) return eventsForMessage(readPluginEvents(rootSessionId, stateHome), userMessageId);
  const local = readLatestLocalEvents(worktree);
  return eventsForMessage(local.length ? local : readLatestProjectEvents(worktree, stateHome), userMessageId);
}

function useEvents(rootSessionId: () => string | undefined, worktree: () => string, stateHome: () => string, userMessageId: () => string | undefined = () => undefined) {
  const read = () => readVisibleEvents(rootSessionId(), worktree(), stateHome(), userMessageId());
  const [events, setEvents] = createSignal<PluginRunEvent[]>(read());
  const refresh = () => setEvents(read());
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 250);
    onCleanup(() => clearInterval(timer));
  });
  return events;
}

interface GraphToggleController {
  enabled(sessionId: string): boolean;
  toggle(sessionId: string): boolean;
}

function createGraphToggleController(api: TuiPluginApi): GraphToggleController {
  const [revision, setRevision] = createSignal(0);
  return {
    enabled(id) {
      revision();
      return readSessionGraphEnabled(id, stateHome(api));
    },
    toggle(id) {
      const enabled = !readSessionGraphEnabled(id, stateHome(api));
      writeSessionGraphEnabled(id, enabled, stateHome(api));
      setRevision((value) => value + 1);
      api.renderer.requestRender();
      return enabled;
    },
  };
}

function GraphToggle(props: { api: TuiPluginApi; session_id: string; graph: GraphToggleController }) {
  const enabled = () => props.graph.enabled(props.session_id);
  return (
    <box onMouseUp={() => props.graph.toggle(props.session_id)}>
      <text fg={enabled() ? props.api.theme.current.success : props.api.theme.current.textMuted}>graph:{enabled() ? "on" : "off"}</text>
    </box>
  );
}

function useApiEvents(api: TuiPluginApi, rootSessionId: () => string | undefined, fallback: () => PluginRunEvent[], onRoot?: (id: string) => void) {
  const [events, setEvents] = createSignal<PluginRunEvent[]>(fallback());
  const refresh = async () => {
    let root = rootSessionId();
    let children;
    if (root) {
      children = await api.client.session.children({ sessionID: root, directory: projectPath(api) }).catch(() => ({ data: [] }));
    } else {
      const sessions = await api.client.session.list({ directory: projectPath(api), roots: true, limit: 200 }).catch(() => ({ data: [] }));
      const roots = (sessions.data ?? []).sort((left, right) => right.time.updated - left.time.updated);
      for (const candidate of roots) {
        const candidateChildren = await api.client.session.children({ sessionID: candidate.id, directory: projectPath(api) }).catch(() => ({ data: [] }));
        if ((candidateChildren.data ?? []).some((child) => child.title.startsWith("LangGraph · ") || child.title.startsWith("Neolit · "))) {
          root = candidate.id;
          children = candidateChildren;
          onRoot?.(root);
          break;
        }
      }
    }
    if (!root || !children) { setEvents(fallback()); return; }
    const graphChildren = (children.data ?? []).filter((child) => child.title.startsWith("LangGraph · ") || child.title.startsWith("Neolit · "));
    if (!graphChildren.length) { setEvents(fallback()); return; }
    const statuses = await api.client.session.status({ directory: projectPath(api) }).catch(() => ({ data: {} }));
    const diskEvents = fallback();
    const runMetadata = diskEvents.findLast((event) => event.topology || event.mermaid);
    if (!runMetadata) { setEvents(diskEvents); return; }
    const currentRun = diskEvents.filter((event) => event.runId === runMetadata.runId);
    const sessionIds = new Set(currentRun.flatMap((event) => event.sessionId ? [event.sessionId] : []));
    const currentChildren = graphChildren.filter((child) => sessionIds.has(child.id));
    const mapped = await Promise.all(currentChildren.map(async (child) => {
      const parts = child.title.split(" · ");
      const messages = await api.client.session.messages({ sessionID: child.id, directory: projectPath(api), limit: 20 }).catch(() => ({ data: [] }));
      const assistant = [...(messages.data ?? [])].reverse().find((message) => message.info.role === "assistant");
      const output = assistant?.parts.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      const statusMap = statuses.data as Record<string, { type: string }> | undefined;
      const current = statusMap?.[child.id];
      return { at: new Date(child.time.updated).toISOString(), runId: runMetadata.runId, rootSessionId: root, graph: runMetadata.graph, node: parts[1] ?? child.title, status: current && current.type !== "idle" ? "active" : output ? "completed" : "pending", agent: parts[2] ?? child.agent ?? "agent", model: child.model ? `${child.model.providerID}/${child.model.id}` : "inherit", text: output, sessionId: child.id, mermaid: runMetadata.mermaid, topology: runMetadata.topology } satisfies PluginRunEvent;
    }));
    const mappedNodes = new Set(mapped.map((event) => event.node));
    const merged = currentRun.filter((event) => !mappedNodes.has(event.node));
    for (const event of mapped) {
      const stored = currentRun.findLast((candidate) => candidate.node === event.node);
      merged.push({ ...event, ...stored, status: event.status === "active" ? "active" : stored?.status ?? event.status, text: event.text || stored?.text, mermaid: runMetadata.mermaid, topology: runMetadata.topology });
    }
    setEvents(merged);
  };
  onMount(() => { void refresh(); const timer = setInterval(() => void refresh(), 500); onCleanup(() => clearInterval(timer)); });
  return events;
}

function Sidebar(props: { api: TuiPluginApi; session_id: string }) {
  const disk = useEvents(() => props.session_id, () => projectPath(props.api), () => stateHome(props.api));
  const events = useApiEvents(props.api, () => props.session_id, disk);
  const nodes = createMemo(() => executions(events()).slice(-6));
  const spinner = useSpinner(events, props.api);
  const theme = () => props.api.theme.current;
  return (
    <Show when={nodes().length > 0}>
      <box paddingTop={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text}><b>LANGGRAPH</b></text>
          <text fg={theme().textMuted}>{events().at(-1)?.graph ?? "graph"}</text>
        </box>
        <For each={nodes()}>{(event) => (
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(event, theme())}>{status(event, spinner())}</text>
              <text fg={theme().text} wrapMode="none"><b>{event.node.replaceAll("_", " ")}</b></text>
              <text fg={statusColor(event, theme())}>{event.status}</text>
            </box>
            <text fg={theme().textMuted} wrapMode="none">  {event.agent}  {event.model}</text>
          </box>
        )}</For>
      </box>
    </Show>
  );
}

function GraphRoute(props: { api: TuiPluginApi; rootSessionId?: string; userMessageId?: string }) {
  const [rootSessionId, setRootSessionId] = createSignal(props.rootSessionId);
  const disk = useEvents(() => rootSessionId(), () => projectPath(props.api), () => stateHome(props.api), () => props.userMessageId);
  const events = useApiEvents(props.api, rootSessionId, disk, setRootSessionId);
  const spinner = useSpinner(events, props.api);
  const layout = createMemo(() => renderEventGraph(events(), spinner()));
  const nodes = createMemo(() => executions(events()));
  const currentRun = createMemo(() => latest(events()));
  const [scrollPosition, setScrollPosition] = createSignal({ x: 0, y: 0 });
  const [selected, setSelected] = createSignal(initialSelection(events()));
  const [pane, setPane] = createSignal<"graph" | "nodes" | "output">("graph");
  const [detail, setDetail] = createSignal<"output" | "state">("output");
  const [keymapReady, setKeymapReady] = createSignal(false);
  let canvas: BoxRenderable | undefined;
  let outputBox: ScrollBoxRenderable | undefined;
  const theme = () => props.api.theme.current;
  const selectedEvent = createMemo(() => nodes()[Math.min(selected(), Math.max(0, nodes().length - 1))]);
  const activatePane = (value: "graph" | "nodes" | "output") => {
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
    cycle: () => activatePane(pane() === "graph" ? "nodes" : pane() === "nodes" ? "output" : "graph"),
    graph: () => activatePane("graph"),
    nodes: () => activatePane("nodes"),
    output: () => { setDetail("output"); activatePane("output"); outputBox?.scrollTo(0); },
    state: () => { setDetail("state"); activatePane("output"); outputBox?.scrollTo(0); },
    previous: selectPrevious,
    next: selectNext,
    inspect: () => { if (pane() === "nodes") { activatePane("output"); outputBox?.scrollTo(0); } },
    up: () => {
      if (pane() === "nodes") selectPrevious();
      else if (pane() === "output") outputBox?.scrollBy(-3);
      else moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 4) }));
    },
    down: () => {
      if (pane() === "nodes") selectNext();
      else if (pane() === "output") outputBox?.scrollBy(3);
      else moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 4) }));
    },
    left: () => { if (pane() === "graph") moveGraph(({ x, y }) => ({ x: Math.max(0, x - 8), y })); },
    right: () => { if (pane() === "graph") moveGraph(({ x, y }) => ({ x: Math.min(Math.max(0, layout().width - 20), x + 8), y })); },
    pageUp: () => {
      if (pane() === "output") outputBox?.scrollBy(-12);
      else if (pane() === "graph") moveGraph(({ x, y }) => ({ x, y: Math.max(0, y - 12) }));
    },
    pageDown: () => {
      if (pane() === "output") outputBox?.scrollBy(12);
      else if (pane() === "graph") moveGraph(({ x, y }) => ({ x, y: Math.min(Math.max(0, layout().height - 8), y + 12) }));
    },
    home: () => {
      if (pane() === "output") outputBox?.scrollTo(0);
      else if (pane() === "graph") moveGraph(() => ({ x: 0, y: 0 }));
    },
    end: () => { if (pane() === "output" && outputBox) outputBox.scrollTo(outputBox.scrollHeight); },
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
        <box onMouseUp={() => activatePane("graph")} width="62%" flexShrink={0} border={true} borderColor={pane() === "graph" ? theme().primary : theme().border} title={` GRAPH [${keyHint(["langgraph.view.graph"], "1")}] · PAN [${keyHint(["langgraph.navigate.up", "langgraph.navigate.down", "langgraph.navigate.left", "langgraph.navigate.right"], "UP/DOWN/LEFT/RIGHT")}] `} overflow="hidden">
          <Show when={layout().canvas} fallback={<text fg={theme().textMuted}>No LangGraph execution has run in this project.</text>}>
            <box ref={(value) => { canvas = value; }} position="absolute" left={0} top={0} width={layout().width} height={layout().height} flexShrink={0}>
              <text position="absolute" left={0} top={0} fg={theme().text}>{layout().canvas}</text>
            </box>
          </Show>
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
  api.event.on("tui.session.select", (event) => { activeSessionId = event.properties.sessionID; });
  api.slots.register({
    order: 120,
    slots: {
      sidebar_content(_context, props) { activeSessionId = props.session_id; return <Sidebar api={api} session_id={props.session_id} />; },
      session_prompt_right(_context, props) { activeSessionId = props.session_id; return <GraphToggle api={api} session_id={props.session_id} graph={graphToggle} />; },
    },
  });
  const renderGraph = ({ params }: { params?: Record<string, unknown> }) => <GraphRoute api={api} rootSessionId={typeof params?.sessionID === "string" ? params.sessionID : activeSessionId} userMessageId={typeof params?.messageID === "string" ? params.messageID : undefined} />;
  api.route.register([
    { name: "langgraph.graph", render: renderGraph },
    { name: "neolit.graph", render: renderGraph },
  ]);
  api.keymap.registerLayer({
    commands: [
      { name: "langgraph.graph.open", title: "Open latest LangGraph execution", slashName: "graph", category: "LangGraph", namespace: "palette", run() { openGraph(api, activeSessionId); } },
      { name: "langgraph.graph.toggle", title: "Toggle LangGraph for this session", slashName: "graph-toggle", category: "LangGraph", namespace: "palette", run() { const id = sessionId(api) ?? activeSessionId; if (id) graphToggle.toggle(id); } },
      { name: "neolit.graph.open", title: "Open graph (legacy /neolit-graph)", slashName: "neolit-graph", category: "Compatibility", namespace: "palette", run() { openGraph(api, activeSessionId); } },
      { name: "neolit.graph.toggle", title: "Toggle graph (legacy /neolit-graph-toggle)", slashName: "neolit-graph-toggle", category: "Compatibility", namespace: "palette", run() { const id = sessionId(api) ?? activeSessionId; if (id) graphToggle.toggle(id); } },
    ],
    bindings: [{ key: "f8", cmd: "langgraph.graph.open", desc: "Open LangGraph" }],
  });
};

const plugin: TuiPluginModule = { id: "opencode-langgraph", tui };
export default plugin;
