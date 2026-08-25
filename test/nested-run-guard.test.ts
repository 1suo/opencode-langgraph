import { describe, expect, it } from "vitest";
import { server } from "../src/opencode/server.js";

const toolContext = (agent: string) => ({ sessionID: "guard", directory: "/repo", worktree: "/repo", agent, abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never);

describe("nested-run guards", () => {
  it("hides lifecycle tools from every graph role agent while leaving build untouched", async () => {
    const config: { agent?: Record<string, { tools?: Record<string, boolean> }> } = {};
    const hooks = await server({ client: {}, directory: "/repo", worktree: "/repo" } as never);
    await hooks.config?.(config as never);
    for (const toolName of ["langgraph_start", "langgraph_inspect", "langgraph_prune", "langgraph_resume", "langgraph_cancel", "langgraph_pause"]) {
      expect(config.agent?.["langgraph-inspector"]?.tools?.[toolName]).toBe(false);
      expect(config.agent?.["langgraph-synthesizer"]?.tools?.[toolName]).toBe(false);
      expect(config.agent?.["langgraph-refiner"]?.tools?.[toolName]).toBe(false);
      expect(config.agent?.["langgraph-verifier"]?.tools?.[toolName]).toBe(false);
    }
    expect(config.agent?.["build"]).toBeUndefined();
  });

  it("rejects langgraph_start from graph role agents before any run is created", async () => {
    const hooks = await server({ client: {}, directory: "/repo", worktree: "/repo" } as never);
    await expect((hooks.tool?.langgraph_start.execute as (args: unknown, ctx: never) => Promise<string>)({ task: "READ-ONLY git investigation" }, toolContext("langgraph-inspector")))
      .rejects.toThrow(/may not start nested runs/);
    await expect((hooks.tool?.langgraph_start.execute as (args: unknown, ctx: never) => Promise<string>)({ task: "x" }, toolContext("langgraph-verifier")))
      .rejects.toThrow(/may not start nested runs/);
  });
});
