import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertOnlyFilesChanged, snapshotTree } from "../src/worktree.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neolit-tree-")); roots.push(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, "allowed.js"), "old");
  fs.writeFileSync(path.join(root, "protected.js"), "safe");
  spawnSync("git", ["add", "."], { cwd: root });
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("hostile tree boundary", () => {
  it("accepts changes to declared files", () => {
    const root = fixture(); const before = snapshotTree(root);
    fs.writeFileSync(path.join(root, "allowed.js"), "new");
    expect(() => assertOnlyFilesChanged(root, before, new Set(["allowed.js"]))).not.toThrow();
  });

  it("rejects undeclared changes and new files", () => {
    const root = fixture(); const before = snapshotTree(root);
    fs.writeFileSync(path.join(root, "protected.js"), "bad");
    expect(() => assertOnlyFilesChanged(root, before, new Set(["allowed.js"]))).toThrow(/undeclared/);
    fs.writeFileSync(path.join(root, "extra.js"), "bad");
    expect(() => assertOnlyFilesChanged(root, before, new Set(["allowed.js"]))).toThrow(/created or deleted/);
  });
});
