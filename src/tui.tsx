import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { asciiGraph } from "./graph-view.js";
import type { PipelineRuntime } from "./pipeline.js";
import type { AuditEvent } from "./types.js";

interface AppProps { runtime: PipelineRuntime; execute?: () => Promise<unknown>; initialStatus?: "running" | "complete" | "failed" }

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
