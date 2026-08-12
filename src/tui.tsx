import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { asciiGraph } from "./graph-view.js";
import type { PipelineRuntime } from "./pipeline.js";
import type { AuditEvent, NodeStatus } from "./types.js";

const ALT_ON = "\u001b[?1049h\u001b[H";
const ALT_OFF = "\u001b[?1049l";
const icons: Record<NodeStatus, string> = { pending: "○", active: "▶", completed: "✓", retrying: "↻", failed: "×", interrupted: "!" };

interface AppProps { runtime: PipelineRuntime; execute?: () => Promise<unknown>; initialStatus?: "running" | "complete" | "failed" }
interface TaskPromptProps { repo: string; onSubmit: (task: string) => void; onCancel: () => void }

export function appendTaskInput(value: string, input: string): string {
  return value + input.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function formatLogEntry(entry: string): string[] {
  const rawLines = entry.split("\n").filter((line) => line.trim().length > 0);
  return rawLines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; error?: string } } };
      if (event.type === "step_start") return ["agent · step started"];
      if (event.type === "step_finish") return ["agent · step finished"];
      if (event.type === "text" && event.part?.text) return event.part.text.split("\n").filter(Boolean).map((text) => `agent · ${text}`);
      if (event.type === "tool_use" && event.part) {
        const target = event.part.state?.input?.filePath ?? event.part.state?.input?.pattern ?? "";
        return [`tool  · ${event.part.tool ?? "unknown"} ${String(target)} ${event.part.state?.status ?? ""}`.trimEnd()];
      }
    } catch { /* ordinary process output */ }
    return [line];
  });
}

function Panel({ title, active = false, width, height, children }: { title: string; active?: boolean; width?: number | string; height?: number; children: React.ReactNode }) {
  return <Box width={width} height={height} borderStyle="round" borderColor={active ? "cyan" : "gray"} flexDirection="column" overflow="hidden">
    <Box paddingX={1} flexShrink={0}><Text bold color={active ? "cyan" : undefined}>{title}</Text></Box>
    <Box paddingX={1} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">{children}</Box>
  </Box>;
}

function useClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}

function TaskPrompt({ repo, onSubmit, onCancel }: TaskPromptProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [task, setTask] = useState("");
  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 30;

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) { onCancel(); exit(); return; }
    if (key.return) { const value = task.trim(); if (value) { onSubmit(value); exit(); } return; }
    if (key.backspace || key.delete) { setTask((value) => [...value].slice(0, -1).join("")); return; }
    if (key.ctrl && input === "u") { setTask(""); return; }
    if (!key.ctrl && !key.meta && input) setTask((value) => appendTaskInput(value, input));
  });

  return <Box width={width} height={height} flexDirection="column" padding={1}>
    <Box justifyContent="space-between"><Text bold color="cyan">NEOLIT</Text><Text dimColor>progressive cooling</Text></Box>
    <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <Box width={Math.min(90, Math.max(40, width - 8))} flexDirection="column">
        <Text bold>What should Neolit do?</Text>
        <Text dimColor>{repo}</Text>
        <Box marginTop={1} borderStyle="round" borderColor="cyan" minHeight={5} paddingX={1}>
          <Text color="cyan">› </Text><Text>{task}</Text><Text color="cyan">█</Text>
        </Box>
      </Box>
    </Box>
    <Box justifyContent="center"><Text dimColor>Enter run   Ctrl+U clear   Esc quit</Text></Box>
  </Box>;
}

function Dashboard({ runtime, execute, initialStatus = "running" }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [revision, setRevision] = useState(0);
  const [diagram, setDiagram] = useState("Loading executable graph…");
  const [focusGraph, setFocusGraph] = useState(true);
  const [activePane, setActivePane] = useState<"graph" | "logs">("graph");
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<"running" | "complete" | "failed">(initialStatus);
  const [startedAt] = useState(Date.now());
  const now = useClock();
  const width = stdout?.columns ?? 120;
  const height = stdout?.rows ?? 36;
  const compact = width < 96;
  const mainHeight = Math.max(10, Math.floor((height - 7) * 0.58));
  const logHeight = Math.max(6, height - mainHeight - 6);

  useEffect(() => {
    const listener = (event: AuditEvent) => {
      setRevision((value) => value + 1);
      if (event.type === "run" && event.status === "completed") setResult("complete");
      if (event.type === "run" && event.status === "failed") setResult("failed");
    };
    runtime.events.on("event", listener);
    if (execute) execute().then(() => setResult("complete"), (error) => {
      runtime.events.record({ type: "run", status: "failed", message: error instanceof Error ? error.message : String(error) });
      setResult("failed"); process.exitCode = 1;
    });
    return () => { runtime.events.off("event", listener); };
  }, []);

  const hasActiveNode = [...runtime.events.statuses.values()].some((status) => status === "active" || status === "retrying");
  const effectiveFocus = focusGraph && hasActiveNode;
  useEffect(() => {
    asciiGraph(runtime.graph, runtime.events.statuses, effectiveFocus, compact ? width - 4 : Math.floor(width * 0.62) - 4).then(setDiagram, (error) => setDiagram(`Graph render failed: ${error}`));
  }, [revision, effectiveFocus, width]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit();
    if (key.tab) setActivePane((pane) => pane === "graph" ? "logs" : "graph");
    if (input === "g") setActivePane("graph");
    if (input === "l") setActivePane("logs");
    if (input === "f") setFocusGraph((value) => !value);
    if (input === " ") setPaused((value) => !value);
  });

  const active = useMemo(() => [...runtime.events.statuses].find(([, status]) => status === "active" || status === "retrying")?.[0] ?? "—", [revision]);
  const completed = [...runtime.events.statuses.values()].filter((status) => status === "completed").length;
  const failed = [...runtime.events.statuses.values()].filter((status) => status === "failed").length;
  const route = [...runtime.events.history].reverse().find((event) => event.data && typeof event.data === "object" && "route" in event.data)?.data as { route?: string } | undefined;
  const lastRunner = [...runtime.events.history].reverse().find((event) => event.type === "runner");
  const runner = lastRunner?.status === "active" ? lastRunner : undefined;
  const validation = [...runtime.events.history].reverse().find((event) => event.type === "validation")?.data as { checks?: Array<{ name: string; ok: boolean }> } | undefined;
  const formattedLogs = runtime.events.logs.flatMap(formatLogEntry);
  const visibleLogs = paused ? formattedLogs.slice(0, Math.max(1, logHeight - 3)) : formattedLogs.slice(-Math.max(1, logHeight - 3));
  const elapsed = Math.floor((now - startedAt) / 1000);
  const color = result === "failed" ? "red" : result === "complete" ? "green" : "yellow";

  const inspector = <Panel title="STAGE" height={mainHeight}>
    <Text dimColor>active node</Text><Text bold color="cyan">{active.replaceAll("_", " ")}</Text>
    <Box marginTop={1} flexDirection="column">
      <Text>route       <Text bold>{route?.route ?? "classifying"}</Text></Text>
      <Text>runner      <Text bold>{runner?.message ?? "—"}</Text></Text>
      <Text>completed   <Text color="green">{completed}</Text></Text>
      <Text>failed      <Text color={failed ? "red" : undefined}>{failed}</Text></Text>
      <Text>elapsed     {Math.floor(elapsed / 60)}m {elapsed % 60}s</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>validation</Text>
      {validation?.checks?.length ? validation.checks.map((check) => <Text key={check.name} color={check.ok ? "green" : "red"}>{check.ok ? "✓" : "×"} {check.name}</Text>) : <Text dimColor>waiting</Text>}
    </Box>
  </Panel>;

  return <Box width={width} height={height} flexDirection="column">
    <Box height={3} paddingX={1} justifyContent="space-between" alignItems="center" borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor="gray">
      <Text><Text bold color="cyan">NEOLIT</Text> <Text dimColor>{runtime.events.runId.slice(0, 8)}</Text></Text>
      <Text><Text color={color}>● {result}</Text>  <Text dimColor>{route?.route ?? "routing"}</Text></Text>
    </Box>
    {compact ? <Box height={mainHeight} flexDirection="column">
      <Panel title={`GRAPH · ${effectiveFocus ? "FOCUS" : "FULL"}`} active={activePane === "graph"} height={mainHeight}><Text>{diagram}</Text></Panel>
    </Box> : <Box height={mainHeight} flexDirection="row">
      <Panel title={`GRAPH · ${effectiveFocus ? "FOCUS" : "FULL"}`} active={activePane === "graph"} width="68%" height={mainHeight}><Text>{diagram}</Text></Panel>
      <Box width="32%">{inspector}</Box>
    </Box>}
    <Panel title={`LOGS${paused ? " · PAUSED" : ""}`} active={activePane === "logs"} height={logHeight}>
      {visibleLogs.length ? visibleLogs.map((line, index) => <Text key={`${revision}-${index}`} wrap="truncate">{line || " "}</Text>) : <Text dimColor>Waiting for events…</Text>}
    </Panel>
    <Box height={3} paddingX={1} justifyContent="space-between" alignItems="center">
      <Text dimColor>Tab pane   f focus/full   Space freeze logs   q detach</Text>
      <Text>{icons[runtime.events.statuses.get(active) ?? "pending"]} {active.replaceAll("_", " ")}</Text>
    </Box>
  </Box>;
}

async function inFullscreen(element: React.ReactElement): Promise<void> {
  process.stdout.write(ALT_ON);
  const restore = () => process.stdout.write(ALT_OFF);
  process.once("exit", restore);
  try {
    const instance = render(element, { patchConsole: false });
    await instance.waitUntilExit();
  } finally {
    process.removeListener("exit", restore);
    restore();
  }
}

export async function runTui(runtime: PipelineRuntime, execute?: () => Promise<unknown>, initialStatus: "running" | "complete" | "failed" = "running"): Promise<void> {
  await inFullscreen(<Dashboard runtime={runtime} execute={execute} initialStatus={initialStatus} />);
}

export async function promptForTask(repo: string): Promise<string | null> {
  let task: string | null = null;
  await inFullscreen(<TaskPrompt repo={repo} onSubmit={(value) => { task = value; }} onCancel={() => { task = null; }} />);
  return task;
}
