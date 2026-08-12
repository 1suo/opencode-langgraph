import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asciiGraph, graphData, statusMermaid } from "../src/graph-view.js";
import { createRuntime } from "../src/pipeline.js";
import type { RunPaths } from "../src/types.js";

const roots: string[] = [];
function runtime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-test-")); roots.push(root);
  const paths: RunPaths = { root, audit: path.join(root, "audit.jsonl"), artifacts: path.join(root, "artifacts"), checkpoint: path.join(root, "checkpoints.sqlite"), patch: path.join(root, "result.patch") };
  fs.mkdirSync(paths.artifacts);
  return createRuntime(process.cwd(), paths);
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("runtime graph", () => {
  it("contains every route and the cooling stages", async () => {
    const data = await graphData(runtime().graph);
    const nodes = Object.keys(data.nodes);
    expect(nodes).toEqual(expect.arrayContaining(["qualify", "trivial", "simple_tests", "accumulate_context", "rephrase", "high_level_plan", "detailed_plan", "skeleton", "gap_fill", "validate", "explore_generate"]));
  });

  it("decorates the active compiled node and renders it as terminal text", async () => {
    const app = runtime().graph;
    const mermaid = await statusMermaid(app, new Map([["gap_fill", "active"]]));
    expect(mermaid).toContain("▶ gap fill");
    expect(await asciiGraph(app, new Map([["gap_fill", "active"]]), true)).toContain("gap fill");
  });
});
