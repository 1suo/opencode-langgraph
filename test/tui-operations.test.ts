import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { activationInvocationRows, activationNodeId, eventForActivation, movedSelectionId, runListRefreshToken, visibleRunItems, type RunListItem } from "../src/opencode/tui.js";
import type { PluginRunEvent } from "../src/opencode/store.js";
import type { SolutionSemanticSnapshot } from "../src/core/types.js";

const run = (status: RunListItem["run"]["status"], modified: number): RunListItem => ({
  modified,
  run: { runId: status, rootSessionId: "session", userMessageId: "message", graph: "solution-lod", task: status, directory: "/repo", worktree: "/repo", status },
});

describe("TUI operations", () => {
  it("keeps live runs separate from the archive", () => {
    const items = [run("queued", 9), run("running", 8), run("pausing", 7), run("paused", 6), run("interrupted", 5), run("completed", 4), run("failed", 3), run("cancelled", 2), run("pruned", 1)];
    expect(visibleRunItems(items, false).map((item) => item.run.status)).toEqual(["queued", "running", "pausing", "paused", "interrupted"]);
    expect(visibleRunItems(items, true).map((item) => item.run.status)).toEqual(["completed", "failed", "cancelled", "pruned"]);
  });

  it("renders sender activation hierarchy while retaining exact region/LOD mapping", () => {
    const semantic = {
      kind: "solution-lod-v2", revision: 8, candidates: [], constraints: [], evidence: [], artifacts: [],
      regions: [
        { id: "r1", key: "root", edge: "root", lod: 0, objective: "Root", status: "collapsed", viable: 1, total: 2, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] },
        { id: "r2", key: "child", parentId: "r1", edge: "partOf", lod: 1, objective: "Child", status: "superposed", viable: 2, total: 2, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] },
      ],
      activations: [
        { id: "a3", capability: "synthesize", operation: "challenge-domain", regionId: "r2", request: "challenge", expectedDelta: "domain", senderActivationId: "a2", status: "queued" },
        { id: "a1", capability: "inspect", regionId: "r1", request: "inspect", expectedDelta: "facts", status: "completed" },
        { id: "a2", capability: "refine", regionId: "r1", request: "split", expectedDelta: "children", senderActivationId: "a1", status: "completed" },
      ],
    } satisfies SolutionSemanticSnapshot;

    const rows = activationInvocationRows(semantic);
    expect(rows.map((row) => [row.activation.id, row.indent.length, row.region?.id, row.region?.lod])).toEqual([
      ["a1", 0, "r1", 0], ["a2", 2, "r1", 0], ["a3", 4, "r2", 1],
    ]);
    expect(movedSelectionId(rows.map((row) => row.activation.id), "a1", 1)).toBe("a2");
    expect(movedSelectionId(rows.map((row) => row.activation.id), "a2", 1)).toBe("a3");
    expect(movedSelectionId(rows.map((row) => row.activation.id), "a3", -1)).toBe("a2");
  });

  it("maps synthesis events by operation and exact activation identity", () => {
    const activations = [
      { id: "a1", capability: "synthesize", operation: "generate-domain", regionId: "r1", request: "generate", expectedDelta: "domain", status: "completed" },
      { id: "a2", capability: "synthesize", operation: "challenge-domain", regionId: "r1", request: "challenge", expectedDelta: "review", status: "completed", sessionId: "challenge-session" },
      { id: "a3", capability: "synthesize", operation: "select-candidate", regionId: "r1", request: "select", expectedDelta: "selection", status: "running" },
    ];
    const event = (node: string, status: string, sessionId?: string, prompt = false): PluginRunEvent => ({ at: `${node}-${status}`, runId: "run", rootSessionId: "root", graph: "solution-lod", node, status, agent: "synthesize", model: "inherit", sessionId, ...(prompt ? { prompt: { system: "role", input: node } } : {}) });
    const events = [
      event("generate-domain:r1", "active", "generate-session", true), event("generate-domain:r1", "completed", "generate-session"),
      event("challenge-domain:r1", "active", "wrong-session", true), event("challenge-domain:r1", "failed", "wrong-session"),
      event("challenge-domain:r1", "active", "challenge-session", true), event("challenge-domain:r1", "completed", "challenge-session"),
      { ...event("select-candidate:r1", "active", "select-session", true), activationId: "a3" },
      event("select-candidate:r1", "active", "unrelated-session", true),
    ];

    expect(activationNodeId(activations[1])).toBe("challenge-domain:r1");
    expect(eventForActivation(events, activations, activations[1])?.sessionId).toBe("challenge-session");
    expect(eventForActivation(events, activations, activations[1], true)?.sessionId).toBe("challenge-session");
    expect(eventForActivation(events, activations, activations[2])?.sessionId).toBe("select-session");

    const repeated = [
      { ...activations[1], id: "a4", sessionId: undefined },
      { ...activations[1], id: "a5", sessionId: undefined },
    ];
    const sessionless = [event("challenge-domain:r1", "active", undefined, true), event("challenge-domain:r1", "failed"), { ...event("challenge-domain:r1", "active", undefined, true), at: "second-active" }, event("challenge-domain:r1", "completed")];
    expect(eventForActivation(sessionless, repeated, repeated[1], true)?.at).toBe("second-active");
    expect(eventForActivation(sessionless, repeated, repeated[1])?.status).toBe("completed");
  });

  it("invalidates run-list loading when a run receives a terminal event", () => {
    const active = [{ at: "1", runId: "run", rootSessionId: "root", graph: "solution-lod", node: "generate-domain:r1", status: "active", agent: "synthesize", model: "inherit" }] satisfies PluginRunEvent[];
    const completed = [...active, { ...active[0], at: "2", node: "__end__", status: "completed" }];
    expect(runListRefreshToken(completed)).not.toBe(runListRefreshToken(active));
    expect(visibleRunItems([run("running", 2)], false)).toHaveLength(1);
    expect(visibleRunItems([run("completed", 3)], false)).toHaveLength(0);
    expect(visibleRunItems([run("completed", 3)], true)).toHaveLength(1);
  });

  it("typechecks README TypeScript examples through the package exports", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const examples = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThan(0);
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".readme-typecheck-"));
    try {
      const files = examples.map((source, index) => {
        const file = path.join(directory, `example-${index}.ts`);
        fs.writeFileSync(file, source);
        return file;
      });
      const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true,
        // Resolve the package's self-exports from source so the gate does not depend on a stale ./dist.
        baseUrl: process.cwd(),
        paths: {
          "opencode-langgraph": ["./src/core/index.ts"],
          "opencode-langgraph/server": ["./src/opencode/server.ts"],
          "opencode-langgraph/tui": ["./src/opencode/tui.tsx"],
        } };
      const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(files, options));
      expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
