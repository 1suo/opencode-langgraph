import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConnectorDefinition } from "../src/core/types.js";
import { loadConnectorDefinition } from "../src/core/config.js";
import { OPENCODE_RUNTIME_RETRY_POLICY, OpenCodeAgentRuntime, OpenCodeRuntimeError } from "../src/opencode/runtime.js";

const definition = (inactivityTimeoutMs = 25, maxRuntimeMs = 500): ConnectorDefinition => ({
  version: 1,
  models: { current: { backend: "opencode", model: "inherit" } },
  agents: { worker: { model: "current", systemPrompt: "work", tools: {}, inactivityTimeoutMs, maxRuntimeMs } },
  graphs: {},
  defaultGraph: "default",
});

function runtime(client: unknown, configured = definition()): OpenCodeAgentRuntime {
  return new OpenCodeAgentRuntime({
    plugin: { client } as never,
    definition: configured,
    parentSessionId: "root",
    parentModel: { providerID: "provider", modelID: "model" },
    directory: "/repo",
    worktree: "/repo",
    signal: new AbortController().signal,
  });
}

describe("OpenCode runtime reliability", () => {
  it("exposes preset role timeouts with a longer implementation default", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-timeouts-"));
    const defaults = await loadConnectorDefinition(project);
    expect(defaults.agents.inspect).toMatchObject({ inactivityTimeoutMs: 15 * 60_000, maxRuntimeMs: 30 * 60_000 });
    expect(defaults.agents.implement).toMatchObject({ inactivityTimeoutMs: 30 * 60_000, maxRuntimeMs: 60 * 60_000 });

    fs.mkdirSync(path.join(project, ".opencode"));
    fs.writeFileSync(path.join(project, ".opencode", "langgraph.ts"), `import { defineOpenCodeLangGraph } from "opencode-langgraph";\nexport default defineOpenCodeLangGraph({ version: 1, preset: "solution-lod", options: { roleTimeouts: { implement: { inactivityTimeoutMs: 1234, maxRuntimeMs: 5678 } } } });\n`);
    expect((await loadConnectorDefinition(project)).agents.implement).toMatchObject({ inactivityTimeoutMs: 1234, maxRuntimeMs: 5678 });
    expect(OPENCODE_RUNTIME_RETRY_POLICY).toMatchObject({ startup: { retries: 1 }, transport: { pollRetries: 2, retries: 1 }, inactivity: { retries: 1 }, schema: { retries: 2 }, semantic: { retries: 0 } });
  });

  it("keeps a progressing silent active tool alive", async () => {
    let polls = 0;
    let aborted = false;
    const running = (progress: number) => ({ info: { id: "assistant", role: "assistant" }, parts: [{ id: "tool", type: "tool", tool: "bash", state: { status: "running", input: { command: "build" }, metadata: { progress } } }] });
    const completed = { info: { id: "assistant", role: "assistant", finish: "stop" }, parts: [{ id: "tool", type: "tool", tool: "bash", state: { status: "completed", input: { command: "build" }, output: "ok" } }, { id: "text", type: "text", text: "built" }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: polls < 5 ? [running(polls++)] : [completed] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };

    await expect(runtime(client).call({ agent: "worker", node: "build", prompt: "build", state: {} })).resolves.toMatchObject({
      text: "built",
      sessionId: "child",
      tools: [{ tool: "bash", status: "completed", output: "ok" }],
    });
    expect(aborted).toBe(false);
  });

  it("times out an unchanged active tool before maximum runtime", async () => {
    let aborted = false;
    const running = { info: { id: "assistant", role: "assistant" }, parts: [{ id: "tool", type: "tool", tool: "bash", state: { status: "running", input: { command: "stuck" } } }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: { child: { type: "busy" } } }),
      messages: async () => ({ data: [running] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };

    const failure = await runtime(client, definition(25, 500)).call({ agent: "worker", node: "build", prompt: "build", state: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "inactivity", sessionId: "child" });
    expect((failure as Error).message).toContain("was inactive for 25ms");
    expect((failure as Error).message).not.toContain("maximum runtime");
    expect(aborted).toBe(true);
  });

  it("does not accept assistant output until its active tool completes", async () => {
    let polls = 0;
    const running = { info: { id: "assistant", role: "assistant" }, parts: [{ id: "early", type: "text", text: "premature answer" }, { id: "tool", type: "tool", tool: "bash", state: { status: "running", input: { command: "test" } } }] };
    const completed = { info: { id: "assistant", role: "assistant", finish: "stop" }, parts: [{ id: "tool", type: "tool", tool: "bash", state: { status: "completed", input: { command: "test" }, output: "passed" } }, { id: "final", type: "text", text: "final answer" }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [polls++ ? completed : running] }),
      abort: async () => ({ data: true }),
    } };

    await expect(runtime(client).call({ agent: "worker", node: "test", prompt: "test", state: {} })).resolves.toMatchObject({
      text: "final answer",
      tools: [{ tool: "bash", status: "completed", output: "passed" }],
    });
    expect(polls).toBe(2);
  });

  it("classifies a child that never appears as startup failure", async () => {
    let aborted = false;
    let creates = 0;
    const client = { session: {
      create: async () => { creates++; return { data: { id: "never-started" } }; },
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };

    const failure = await runtime(client, definition(20)).call({ agent: "worker", node: "work", prompt: "work", state: {} }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenCodeRuntimeError);
    expect(failure).toMatchObject({ kind: "startup", sessionId: "never-started", retryable: false, usage: { turns: 0 }, retryTrace: [{ kind: "startup", action: "fresh" }, { kind: "startup", action: "none" }] });
    expect((failure as Error).message).toContain("did not start within 20ms");
    expect(creates).toBe(2);
    expect(aborted).toBe(true);
  });

  it("retries a transient API disconnection in the same child", async () => {
    let statusCalls = 0;
    let creates = 0;
    let prompts = 0;
    const client = { session: {
      create: async () => ({ data: { id: `child-${++creates}` } }),
      promptAsync: async () => { prompts++; return { data: undefined }; },
      status: async () => {
        if (statusCalls++ === 0) throw new Error("socket disconnected");
        return { data: {} };
      },
      messages: async () => ({ data: [{ info: { id: "answer", role: "assistant", finish: "stop" }, parts: [{ id: "text", type: "text", text: "recovered" }] }] }),
      abort: async () => ({ data: true }),
    } };

    await expect(runtime(client).call({ agent: "worker", node: "work", prompt: "work", state: {} })).resolves.toMatchObject({ text: "recovered", sessionId: "child-1" });
    expect({ creates, prompts, statusCalls }).toEqual({ creates: 1, prompts: 1, statusCalls: 2 });
  });

  it("preserves diagnostics from earlier and current attempts on transport failure", async () => {
    const invalid = { info: { id: "invalid", role: "assistant", finish: "stop", tokens: { input: 10, output: 2 } }, parts: [{ id: "read", type: "tool", tool: "read", state: { status: "completed", output: "context" } }, { id: "invalid-text", type: "text", text: "not json" }] };
    const interrupted = { info: { id: "interrupted", role: "assistant", finish: "tool-calls", tokens: { input: 20, output: 4 } }, parts: [{ id: "grep", type: "tool", tool: "grep", state: { status: "completed", output: "match" } }, { id: "bash", type: "tool", tool: "bash", state: { status: "running" } }, { id: "progress", type: "reasoning", text: "still working" }] };
    let prompts = 0;
    let secondAttemptStatuses = 0;
    const client = { session: {
      create: async () => ({ data: { id: "diagnostic-child" } }),
      promptAsync: async () => { prompts++; return { data: undefined }; },
      status: async () => {
        if (prompts === 2 && secondAttemptStatuses++ > 0) throw new Error("connection lost");
        return { data: {} };
      },
      messages: async () => ({ data: prompts === 1 ? [invalid] : [invalid, interrupted] }),
      abort: async () => ({ data: true }),
    } };

    const failure = await runtime(client).call({ agent: "worker", node: "decide", prompt: "decide", state: {}, schema: { type: "object" } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: "transport",
      sessionId: "diagnostic-child",
      progressText: "still working",
      usage: { turns: 2, input: 30, output: 6 },
      tools: [{ tool: "read", output: "context" }, { tool: "grep", output: "match" }],
    });
  });

  it("forks useful context after bounded transport polling fails", async () => {
    const partial = { info: { id: "partial", role: "assistant", finish: "tool-calls", tokens: { input: 8, output: 2 } }, parts: [{ id: "read", type: "tool", tool: "read", state: { status: "completed", output: "context" } }, { id: "progress", type: "reasoning", text: "context retained" }, { id: "running", type: "tool", tool: "bash", state: { status: "running" } }] };
    const stopped = { ...partial, info: { ...partial.info, error: { name: "MessageAbortedError" } }, parts: partial.parts.map((part) => part.id === "running" ? { ...part, state: { status: "error", error: "aborted" } } : part) };
    const answer = { info: { id: "answer", role: "assistant", finish: "stop", tokens: { input: 11, output: 3 } }, parts: [{ id: "answer-text", type: "text", text: "recovered by fork" }] };
    let prompts = 0;
    let failedStatuses = 0;
    let forkedMessages = 0;
    let aborted = false;
    const client = { session: {
      create: async () => ({ data: { id: "transport-child" } }),
      fork: async () => ({ data: { id: "transport-fork" } }),
      promptAsync: async () => { prompts++; return { data: undefined }; },
      status: async () => {
        if (prompts === 1 && failedStatuses++ > 0) throw new Error("API unavailable");
        return { data: {} };
      },
      messages: async (input: { path: { id: string } }) => {
        if (input.path.id === "transport-child") return { data: [aborted ? stopped : partial] };
        return { data: forkedMessages++ ? [stopped, answer] : [stopped] };
      },
      abort: async () => { aborted = true; return { data: true }; },
    } };

    await expect(runtime(client).call({ agent: "worker", node: "work", prompt: "work", state: {} })).resolves.toMatchObject({
      text: "recovered by fork",
      sessionId: "transport-fork",
      usage: { turns: 2, input: 19, output: 5 },
      tools: [{ tool: "read", output: "context" }],
      retryTrace: [{ kind: "transport", action: "fork", sessionId: "transport-child", progressText: "context retained" }],
    });
  });

  it("automatically retains failed diagnostics and forks useful context once", async () => {
    const partial = { info: { id: "partial", role: "assistant", finish: "tool-calls", cost: 0.01, tokens: { input: 12, output: 3 } }, parts: [{ id: "tool", type: "tool", tool: "read", state: { status: "completed", input: { file: "a" }, output: "context" } }, { id: "progress", type: "reasoning", text: "found useful context" }] };
    const answer = { info: { id: "answer", role: "assistant", finish: "stop", tokens: { input: 15, output: 2 } }, parts: [{ id: "answer-text", type: "text", text: "finished from context" }] };
    let forkSource: string | undefined;
    let forkPolls = 0;
    const client = { session: {
      create: async () => ({ data: { id: "failed-child" } }),
      fork: async (input: { path: { id: string } }) => { forkSource = input.path.id; return { data: { id: "forked-child" } }; },
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async (input: { path: { id: string } }) => {
        if (input.path.id === "failed-child") return { data: [partial] };
        return { data: forkPolls++ === 0 ? [partial] : [partial, answer] };
      },
      abort: async () => ({ data: true }),
    } };
    const agentRuntime = runtime(client);

    await expect(agentRuntime.call({ agent: "worker", node: "inspect", prompt: "inspect", state: {} })).resolves.toMatchObject({
      text: "finished from context",
      sessionId: "forked-child",
      usage: { turns: 2, input: 27, output: 5, cost: 0.01 },
      tools: [{ tool: "read", status: "completed", output: "context" }],
      retryTrace: [{ kind: "inactivity", action: "fork", sessionId: "failed-child", progressText: "found useful context" }],
    });
    expect(forkSource).toBe("failed-child");
  });

  it("classifies exhausted structure repair and agent rejection", async () => {
    let prompts = 0;
    const invalidClient = { session: {
      create: async () => ({ data: { id: "structured-child" } }),
      promptAsync: async () => { prompts++; return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: Array.from({ length: prompts }, (_, index) => ({ info: { id: `bad-${index}`, role: "assistant", finish: "stop" }, parts: [{ id: `text-${index}`, type: "text", text: "not json" }] })) }),
      abort: async () => ({ data: true }),
    } };
    const schemaFailure = await runtime(invalidClient).call({ agent: "worker", node: "decide", prompt: "decide", state: {}, schema: { type: "object" } }).catch((error: unknown) => error);
    expect(schemaFailure).toMatchObject({ kind: "schema", sessionId: "structured-child", progressText: "not json", retryable: false });
    expect(prompts).toBe(3);

    const rejectedClient = { session: {
      create: async () => ({ data: { id: "rejected-child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { id: "rejected", role: "assistant", error: { name: "ProviderError" } }, parts: [{ id: "reason", type: "reasoning", text: "provider rejected request" }] }] }),
      abort: async () => ({ data: true }),
    } };
    const semanticFailure = await runtime(rejectedClient).call({ agent: "worker", node: "work", prompt: "work", state: {} }).catch((error: unknown) => error);
    expect(semanticFailure).toMatchObject({ kind: "semantic", sessionId: "rejected-child", progressText: "provider rejected request", retryable: false });
  });
});
