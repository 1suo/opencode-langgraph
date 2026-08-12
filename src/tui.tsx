import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { asciiGraph } from "./graph-view.js";
import type { PipelineRuntime } from "./pipeline.js";
import type { AuditEvent } from "./types.js";

interface AppProps { runtime: PipelineRuntime; execute?: () => Promise<unknown>; initialStatus?: "running" | "complete" | "failed" }

interface TaskPromptProps {
  repo: string;
  onSubmit: (task: string) => void;
  onCancel: () => void;
}

export function appendTaskInput(value: string, input: string): string {
  return value + input.replace(/[\u0000-\u001f\u007f]/g, "");
}

function TaskPrompt({ repo, onSubmit, onCancel }: TaskPromptProps) {
  const { exit } = useApp();
  const [task, setTask] = useState("");

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) {
      onCancel();
      exit();
      return;
    }
    if (key.return) {
      const value = task.trim();
      if (value) {
        onSubmit(value);
        exit();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setTask((value) => [...value].slice(0, -1).join(""));
      return;
    }
    if (key.ctrl && input === "u") {
      setTask("");
      return;
    }
    if (!key.ctrl && !key.meta && input) setTask((value) => appendTaskInput(value, input));
  });

  return <Box flexDirection="column">
    <Box borderStyle="round" paddingX={1}><Text bold color="cyan">NEOLIT</Text></Box>
    <Box paddingX={1} flexDirection="column">
      <Text dimColor>repository: {repo}</Text>
      <Text>Describe the task, then press Enter:</Text>
    </Box>
    <Box borderStyle="single" paddingX={1}>
      <Text color="cyan">› </Text><Text>{task}</Text><Text color="cyan">█</Text>
    </Box>
    <Text dimColor> Enter run · Ctrl+U clear · Esc/Ctrl+C quit</Text>
  </Box>;
}

function App({ runtime, execute, initialStatus = "running" }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [revision, setRevision] = useState(0);
  const [diagram, setDiagram] = useState("Loading graph…");
  const [view, setView] = useState<"graph" | "logs">("graph");
  const [focus, setFocus] = useState(false);
  const [result, setResult] = useState<"running" | "complete" | "failed">(initialStatus);
  const width = stdout?.columns ?? 120;

  useEffect(() => {
    const listener = (event: AuditEvent) => {
      setRevision((value) => value + 1);
      if (event.type === "run" && event.status === "completed") setResult("complete");
      if (event.type === "run" && event.status === "failed") setResult("failed");
    };
    runtime.events.on("event", listener);
    if (execute) execute().then(() => setResult("complete"), (error) => { runtime.events.record({ type: "run", status: "failed", message: error instanceof Error ? error.message : String(error) }); setResult("failed"); process.exitCode = 1; });
    return () => { runtime.events.off("event", listener); };
  }, []);

  useEffect(() => { asciiGraph(runtime.graph, runtime.events.statuses, focus, width).then(setDiagram, (error) => setDiagram(`Graph render failed: ${error}`)); }, [revision, focus, width]);
  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    if (input === "g") setView("graph");
    if (input === "l") setView("logs");
    if (input === "f") setFocus((value) => !value);
  });
  const active = useMemo(() => [...runtime.events.statuses].find(([, status]) => status === "active" || status === "retrying")?.[0] ?? "—", [revision]);
  const logs = runtime.events.logs.slice(-Math.max(5, (stdout?.rows ?? 30) - 8));

  return <Box flexDirection="column">
    <Box borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">NEOLIT · {runtime.events.runId}</Text><Text color={result === "failed" ? "red" : result === "complete" ? "green" : "yellow"}>{result}</Text>
    </Box>
    <Box paddingX={1}><Text>active: <Text bold>{active}</Text>  view: {view}{view === "graph" ? ` (${focus ? "focus" : "full"})` : ""}</Text></Box>
    <Box borderStyle="single" paddingX={1} flexDirection="column">
      {view === "graph" ? <Text>{diagram}</Text> : logs.map((line, index) => <Text key={`${index}-${line.slice(0, 12)}`} wrap="truncate">{line}</Text>)}
    </Box>
    <Text dimColor> g graph · l logs · f focus/full · q quit</Text>
  </Box>;
}

export async function runTui(runtime: PipelineRuntime, execute?: () => Promise<unknown>, initialStatus: "running" | "complete" | "failed" = "running"): Promise<void> {
  const instance = render(<App runtime={runtime} execute={execute} initialStatus={initialStatus} />);
  await instance.waitUntilExit();
}

export async function promptForTask(repo: string): Promise<string | null> {
  let task: string | null = null;
  const instance = render(<TaskPrompt repo={repo} onSubmit={(value) => { task = value; }} onCancel={() => { task = null; }} />);
  await instance.waitUntilExit();
  return task;
}
