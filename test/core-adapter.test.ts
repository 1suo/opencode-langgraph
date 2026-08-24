import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, isInterrupted } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAgentRuntime } from "../src/opencode/runtime.js";
import { buildConversationContext, server } from "../src/opencode/server.js";
import { effectivePrompt, graphHelpText, graphNavigationLayer, graphToggleLabel, readVisibleEvents, renderEventGraph, renderPlanTree, renderStructuredEvent, tui, usageLine, type GraphControls } from "../src/opencode/tui.js";
import { appendPluginEvent, listAllRuns, listProjectRuns, readHomeGraphState, readPluginEvents, readSessionGraphEnabled, readSessionGraphName, readStoredRun, reconcileRuns, writeHomeGraphState, writeSessionGraphEnabled, writeSessionGraphName, writeStoredRun } from "../src/opencode/store.js";
import { flattenSchemaLines, renderSchemaInput, renderSchemaOutput, renderSchemaText } from "../src/opencode/schema-view.js";
import { commandModel, loadConnectorDefinition, typedConfigFile, withSolutionRoleModelAssignments, writeConnectorConfig } from "../src/core/config.js";
import { validateConnector } from "../src/core/validate.js";
import type { AgentUsage, ConnectorDefinition } from "../src/core/types.js";
import { applyBatchRecords, completeImplementation, completeVerification, ensureRunnableWork, initialNetwork, mergeRefinementOutput, mergeSolutionDelta, mergeSynthesisOutput, nextQueuedActivation, propagateNetwork, reopenRegion, selectActivationBatch, validateImplementationOutput, validateRefinementOutput, validateSolutionDelta, validateVerificationOutput } from "../src/core/solution-lod/reducer.js";
import { compileActivationPrompt, projectActivationContext, solutionLodGraph } from "../src/core/solution-lod/graph.js";
import { SOLUTION_ROLE_CONTRACTS } from "../src/core/solution-lod/roles.js";
import type { Activation, ActivationTaskResult, ImplementationOutput, SolutionLodState, SolutionNetwork, SynthesisOperation } from "../src/core/solution-lod/types.js";
import { DurableFileSaver } from "../src/core/durable-checkpointer.js";
import { acquireWorktree } from "../src/opencode/worktree-lock.js";
import { prepareVerifierWorkspace, releaseVerifierWorkspace } from "../src/opencode/verifier-workspace.js";

const temporaryDirectories = new Set<string>();
function temp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function mockV8Structured(title: string, prompt = ""): unknown {
  const fingerprint = prompt.match(/"fingerprint":"([^"]+)"/)?.[1];
  const candidateIds = [...prompt.matchAll(/"referenceId":"(r\d+:[^"]+)"/g)].map((match) => match[1]);
  const regionId = title.match(/:(r\d+)/)?.[1] ?? "r1";
  if (title.includes("generate-domain:")) return { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: [{ key: "direct", proposition: "Update target", evidenceRefs: [], stances: [] }, { key: "adapter", proposition: "Update target through an adapter", evidenceRefs: [], stances: [] }] };
  if (title.includes("challenge-domain:")) return { operation: "challenge-domain", verdict: "accept", domainFingerprint: fingerprint, viableCandidateIds: candidateIds };
  if (title.includes("select-candidate:")) return { operation: "select-candidate", domainFingerprint: fingerprint, basis: "lexicographic", selectedCandidateId: `${regionId}:direct`, hardConstraints: [], comparisons: candidateIds.map((candidateId) => ({ candidateId, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: candidateId === `${regionId}:direct` ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) };
  if (title.includes("refine:")) return { evidence: [], children: [], certifiedLeaf: { implementationScope: "bounded test change", criterionIds: ["criterion:scope:r1:0"], evidenceRefs: [], mutationResources: ["src/test.ts"], checks: [{ criterionId: "criterion:scope:r1:0", commandOrObservation: "run focused test" }] }, activations: [] };
  return undefined;
}

function graph(terminates = true) {
  const State = Annotation.Root({ result: Annotation<string> });
  const builder = new StateGraph(State).addNode("work", () => ({ result: "ok" })).addEdge(START, "work");
  if (terminates) builder.addEdge("work", END);
  return builder.compile({ checkpointer: new MemorySaver() });
}

describe("typed graph validation", () => {
  it("publishes separate server and TUI plugin targets with a path-compatible server entry", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { main?: string; exports?: Record<string, string> };
    expect(manifest.main).toBe("./dist/src/opencode/server.js");
    expect(manifest.exports?.["./server"]).toBe("./dist/src/opencode/server.js");
    expect(manifest.exports?.["./tui"]).toBe("./dist/src/opencode/tui.js");
  });

  it("accepts a compiled terminating graph with valid references", async () => {
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false } } },
      graphs: { default: { graph: graph(), initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect(await validateConnector(definition)).toEqual([]);
  });

  it("reports model references and missing checkpoint persistence", async () => {
    const State = Annotation.Root({ result: Annotation<string> });
    const compiled = new StateGraph(State).addNode("work", () => ({ result: "ok" })).addEdge(START, "work").addEdge("work", END).compile();
    const definition: ConnectorDefinition = {
      version: 1,
      models: {},
      agents: { worker: { model: "missing", systemPrompt: "work" } },
      graphs: { default: { graph: compiled, initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect((await validateConnector(definition)).map((item) => item.code)).toEqual(expect.arrayContaining(["REFERENCE", "GRAPH"]));
  });

  it("rejects non-positive agent timeout settings", async () => {
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 0, maxRuntimeMs: -1 } },
      graphs: { default: { graph: graph(), initial: () => ({ result: "" }) } },
      defaultGraph: "default",
    };
    expect((await validateConnector(definition)).map((item) => item.path)).toEqual(expect.arrayContaining(["agents.worker.inactivityTimeoutMs", "agents.worker.maxRuntimeMs"]));
  });

  it("uses the production solution-LOD workflow as the zero-config preset", async () => {
    const project = temp("opencode-langgraph-config-");
    const definition = await loadConnectorDefinition(project);
    expect(definition.defaultGraph).toBe("solution-lod");
    for (const role of ["inspect", "synthesize", "refine", "implement", "verify", "present"]) {
      expect(definition.models[`${role}-model`]).toEqual({ backend: "opencode", model: "inherit" });
    }
    expect(definition.agents.inspect).toMatchObject({ model: "inspect-model", maxSteps: 32, tools: { read: true, bash: false, edit: false, task: false } });
    expect(definition.agents.synthesize).toMatchObject({ model: "synthesize-model", maxSteps: 8, tools: { read: false, bash: false } });
    expect(definition.agents.refine).toMatchObject({ model: "refine-model", maxSteps: 8, tools: { read: false, bash: false } });
    expect(definition.agents.verify).toMatchObject({ model: "verify-model", maxSteps: 16, tools: { bash: true, edit: false } });
    expect(definition.agents.implement).toMatchObject({ model: "implement-model", maxSteps: 32, tools: { task: false } });
    const file = writeConnectorConfig(project);
    expect(path.relative(project, file)).toBe(typedConfigFile);
    expect(fs.readFileSync(file, "utf8")).toContain('preset: "solution-lod"');
    expect((await loadConnectorDefinition(project)).graphs["solution-lod"]).toBeDefined();
  });

  it("applies preset model and activation-quantum overrides", async () => {
    const project = temp("opencode-langgraph-options-");
    const file = writeConnectorConfig(project);
    fs.writeFileSync(file, `import { defineOpenCodeLangGraph } from "opencode-langgraph";\nexport default defineOpenCodeLangGraph({ version: 1, preset: "solution-lod", options: { models: { inspect: "provider/cheap", implement: "provider/strong" }, roleLimits: { inspect: { maxTurns: 3 } } } });\n`);
    const definition = await loadConnectorDefinition(project);
    expect(definition.models["inspect-model"]).toEqual({ backend: "opencode", model: "provider/cheap" });
    expect(definition.models["implement-model"]).toEqual({ backend: "opencode", model: "provider/strong" });
    expect(definition.agents.inspect.maxSteps).toBe(3);
    const initial = definition.graphs["solution-lod"].initial({ task: "x", directory: project, worktree: project, runId: "x" }) as SolutionLodState;
    expect(initial.stateVersion).toBe(8);
  });

  it("applies per-session role assignments without changing the configured definition", async () => {
    const project = temp("solution-lod-model-proxy-");
    const definition = await loadConnectorDefinition(project);
    const assigned = withSolutionRoleModelAssignments(definition, {
      inspect: { backend: "opencode", model: "provider/fast" },
      implement: commandModel({ command: "codex", args: ["exec"] }),
    });
    expect(assigned.models["inspect-model"]).toEqual({ backend: "opencode", model: "provider/fast" });
    expect(assigned.models["implement-model"]).toEqual({ backend: "command", command: "codex", args: ["exec"] });
    expect(definition.models["inspect-model"]).toEqual({ backend: "opencode", model: "inherit" });
  });
});

describe("OpenCode child-session runtime", () => {
  it("maps inherited model and agent settings into an isolated child session", async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const events: unknown[] = [];
    let messagePolls = 0;
    const client = { session: {
      create: async (value: unknown) => { calls.push({ name: "create", value }); return { data: { id: "child-1" } }; },
      promptAsync: async (value: unknown) => { calls.push({ name: "prompt", value }); return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: messagePolls++ ? [{ info: { role: "assistant" }, parts: [{ type: "text", text: "actual answer" }] }] : [] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = {
      version: 1,
      models: { current: { backend: "opencode", model: "inherit" } },
      agents: { planner: { model: "current", opencodeAgent: "plan", systemPrompt: "system", tools: { edit: false, question: false } } },
      graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({
      plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" },
      directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event),
    });
    expect(await runtime.call({ agent: "planner", node: "plan", prompt: "prompt", state: {} })).toEqual({ text: "actual answer", sessionId: "child-1" });
    expect(calls[0].value).toMatchObject({ body: { parentID: "root" } });
    expect(calls[1].value).toMatchObject({ body: { agent: "plan", model: { providerID: "p", modelID: "m" }, system: "system", tools: { edit: false, question: false } } });
    expect(messagePolls).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: "plan", status: "active", state: {}, prompt: { system: "system", input: "prompt" } }),
      expect.objectContaining({ node: "plan", status: "completed", text: "actual answer", state: {} }),
    ]));
  });

  it("creates a fresh child session for every independent activation", async () => {
    const created: string[] = [];
    const client = { session: {
      create: async () => { const id = `child-${created.length + 1}`; created.push(id); return { data: { id } }; },
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async (input: { path: { id: string } }) => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: input.path.id }] }] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { worker: { model: "current", systemPrompt: "work" } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "generate", prompt: "generate", state: {} })).resolves.toMatchObject({ sessionId: "child-1" });
    await expect(runtime.call({ agent: "worker", node: "challenge", prompt: "challenge", state: {} })).resolves.toMatchObject({ sessionId: "child-2" });
    expect(created).toEqual(["child-1", "child-2"]);
  });

  it("streams a live token estimate only while the assistant answer is unfinished", async () => {
    const events: Array<{ status: string; usage?: AgentUsage; streaming?: { inputEstimated: number; outputEstimated: number } }> = [];
    let polls = 0;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: polls < 4 ? { child: { type: "busy" } } : {} }),
      messages: async () => {
        polls++;
        if (polls <= 3) return { data: [{ info: { id: "a1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "x".repeat(400 * polls) }] }] };
        return { data: [{ info: { id: "a1", role: "assistant", finish: "stop", tokens: { input: 900, output: 100, cache: { read: 3_000 } } }, parts: [{ id: "p1", type: "text", text: "final answer" }] }] };
      },
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = {
      version: 1, models: { current: { backend: "opencode", model: "inherit" } },
      agents: { planner: { model: "current", systemPrompt: "system" } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({
      plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" },
      directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event),
    });
    const result = await runtime.call({ agent: "planner", node: "plan", prompt: "prompt", state: {} });
    expect(result.text).toBe("final answer");
    expect(result.usage).toEqual({ turns: 1, input: 900, output: 100, reasoning: 0, cacheRead: 3_000, cacheWrite: 0, cost: 0 });
    expect("streaming" in result).toBe(false);
    expect(events[0]).toMatchObject({ status: "active", streaming: { inputEstimated: 3, outputEstimated: 0 } });
    const withEstimate = events.filter((event) => event.streaming);
    expect(withEstimate).toHaveLength(2);
    expect(withEstimate[1]).toMatchObject({ status: "active", usage: { turns: 0 }, streaming: { inputEstimated: 3, outputEstimated: 100 } });
    const completed = events.at(-1);
    expect(completed).toMatchObject({ status: "completed", usage: { turns: 1, input: 900, cacheRead: 3_000 } });
    expect(completed?.streaming).toBeUndefined();
    const afterFinish = events.filter((event) => event.usage?.turns === 1);
    expect(afterFinish.every((event) => event.streaming === undefined)).toBe(true);
  });

  it("runs command models through stdin", async () => {
    const dir = temp("opencode-langgraph-command-");
    const executable = path.join(dir, "agent");
    fs.writeFileSync(executable, "#!/bin/sh\nread value\nprintf 'seen: %s' \"$value\"\n", { mode: 0o755 });
    const definition: ConnectorDefinition = {
      version: 1, models: { cli: { backend: "command", command: executable } },
      agents: { worker: { model: "cli", systemPrompt: "system" } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({ plugin: {} as never, definition, parentSessionId: "root", directory: dir, worktree: dir, signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "work", prompt: "task", state: {} })).resolves.toMatchObject({ text: "seen: system" });
  });

  it("passes JSON Schema as a portable OpenCode prompt contract and accepts structured data", async () => {
    let prompt: any;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async (value: unknown) => { prompt = value; },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant", structured: { decision: "go" } }, parts: [] }] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: { question: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(prompt.body.format).toBeUndefined();
    expect(prompt.body.parts[0].text).toContain("Return only a JSON value matching this JSON Schema");
  });

  it("retries truncated structured JSON in the same child session", async () => {
    const prompts: any[] = [];
    const malformed = { info: { id: "bad", role: "assistant" }, parts: [{ id: "bad-text", type: "text", text: '{"decision":"go"' }] };
    const repaired = { info: { id: "good", role: "assistant" }, parts: [{ id: "good-text", type: "text", text: '{"decision":"go"}' }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async (value: unknown) => { prompts.push(value); },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: prompts.length < 2 ? [malformed] : [malformed, repaired] }),
      abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: {}, maxSteps: 2 } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" }, sessionId: "child" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.parts[0].text).toContain("Your previous JSON failed validation");
    expect(prompts[1].body.parts[0].text).toContain("ADMISSIBLE CORRECTION");
    expect(prompts[1].body.parts[0].text).not.toContain("ORIGINAL INPUT");
  });

  it("retries valid JSON that fails the typed output contract", async () => {
    const prompts: any[] = [];
    const wrong = { info: { id: "wrong", role: "assistant" }, parts: [{ id: "wrong-text", type: "text", text: '{"decision":"stop"}' }] };
    const repaired = { info: { id: "good", role: "assistant" }, parts: [{ id: "good-text", type: "text", text: '{"decision":"go"}' }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }), promptAsync: async (value: unknown) => { prompts.push(value); }, status: async () => ({ data: {} }),
      messages: async () => ({ data: prompts.length < 2 ? [wrong] : [wrong, repaired] }), abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: {}, maxSteps: 2 } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    const validateStructured = (value: unknown) => {
      if ((value as { decision?: string }).decision !== "go") throw new Error("decision must be go");
      return value;
    };
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" }, validateStructured })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body.parts[0].text).toContain("FAILED PRECONDITION\ndecision must be go");
    expect(prompts[1].body.parts[0].text).not.toContain("ORIGINAL INPUT");
    expect(prompts[1].body.parts[0].text).toContain('PREVIOUS INVALID OUTPUT\n{"decision":"stop"}');
  });

  it("serializes object-shaped validation failures into retry guidance", async () => {
    const prompts: any[] = [];
    const wrong = { info: { id: "wrong", role: "assistant" }, parts: [{ id: "wrong-text", type: "text", text: '{"decision":"stop"}' }] };
    const repaired = { info: { id: "good", role: "assistant" }, parts: [{ id: "good-text", type: "text", text: '{"decision":"go"}' }] };
    const client = { session: {
      create: async () => ({ data: { id: "child" } }), promptAsync: async (value: unknown) => { prompts.push(value); }, status: async () => ({ data: {} }),
      messages: async () => ({ data: prompts.length < 2 ? [wrong] : [wrong, repaired] }), abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: {}, maxSteps: 2 } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    const validateStructured = (value: unknown) => {
      if ((value as { decision?: string }).decision !== "go") throw { code: "INVALID_DECISION", message: "decision must be go" };
      return value;
    };
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" }, validateStructured })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(prompts[1].body.parts[0].text).toContain('FAILED PRECONDITION\n{"code":"INVALID_DECISION","message":"decision must be go"}');
    expect(prompts[1].body.parts[0].text).not.toContain("[object Object]");
  });

  it("keeps a child session alive while tool activity advances", async () => {
    let polls = 0;
    let aborted = false;
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: polls < 4 ? { child: { type: "busy" } } : {} }),
      messages: async () => ({ data: polls++ < 4
        ? [{ info: { id: `assistant-${polls}`, role: "assistant" }, parts: [{ id: `reasoning-${polls}`, type: "reasoning", text: `step ${polls}` }] }]
        : [{ info: { id: "assistant-final", role: "assistant" }, parts: [{ id: "text-final", type: "text", text: "done" }] }] }),
      abort: async () => { aborted = true; return { data: true }; },
    } };
    const definition: ConnectorDefinition = {
      version: 1, models: { current: { backend: "opencode", model: "inherit" } },
      agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 25, maxRuntimeMs: 500 } }, graphs: {}, defaultGraph: "default",
    };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} })).resolves.toMatchObject({ text: "done" });
    expect(polls).toBeGreaterThan(4);
    expect(aborted).toBe(false);
  });

  it("aborts a child session only after genuine inactivity", async () => {
    const stub = (status: () => { data: Record<string, { type: string }> }) => {
      let aborted = false;
      const client = { session: {
        create: async () => ({ data: { id: "child" } }), promptAsync: async () => ({ data: undefined }),
        status,
        messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant" }, parts: [{ id: "reasoning", type: "reasoning", text: "unchanged" }] }] }),
        abort: async () => { aborted = true; return { data: true }; },
      } };
      const definition: ConnectorDefinition = {
        version: 1, models: { current: { backend: "opencode", model: "inherit" } },
        agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, inactivityTimeoutMs: 25, maxRuntimeMs: 150 } }, graphs: {}, defaultGraph: "default",
      };
      const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
      return { promise: runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} }), aborted: () => aborted };
    };
    const idle = stub(async () => ({ data: {} }));
    await expect(idle.promise).rejects.toThrow("was inactive for 25ms");
    expect(idle.aborted()).toBe(true);
    const busy = stub(async () => ({ data: { child: { type: "busy" } } }));
    await expect(busy.promise).rejects.toThrow("was inactive for 25ms");
    expect(busy.aborted()).toBe(true);
  });

  it("resolves the inactivity timeout from the agent setting, then the environment, then the default", async () => {
    const previous = process.env.OPENCODE_LANGGRAPH_INACTIVITY_TIMEOUT_MS;
    const stubClient = () => ({ session: {
      create: async () => ({ data: { id: "child" } }), promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant" }, parts: [{ id: "reasoning", type: "reasoning", text: "unchanged" }] }] }),
      abort: async () => ({ data: true }),
    } });
    try {
      process.env.OPENCODE_LANGGRAPH_INACTIVITY_TIMEOUT_MS = "30";
      const envOnly: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { worker: { model: "current", systemPrompt: "work", tools: {}, maxRuntimeMs: 500 } }, graphs: {}, defaultGraph: "default" };
      const envRuntime = new OpenCodeAgentRuntime({ plugin: { client: stubClient() } as never, definition: envOnly, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
      await expect(envRuntime.call({ agent: "worker", node: "work", prompt: "work", state: {} })).rejects.toThrow("was inactive for 30ms");
      const agentWins: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { worker: { model: "current", systemPrompt: "work", tools: {}, inactivityTimeoutMs: 25, maxRuntimeMs: 500 } }, graphs: {}, defaultGraph: "default" };
      const agentRuntime = new OpenCodeAgentRuntime({ plugin: { client: stubClient() } as never, definition: agentWins, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
      await expect(agentRuntime.call({ agent: "worker", node: "work", prompt: "work", state: {} })).rejects.toThrow("was inactive for 25ms");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LANGGRAPH_INACTIVITY_TIMEOUT_MS;
      else process.env.OPENCODE_LANGGRAPH_INACTIVITY_TIMEOUT_MS = previous;
    }
  });

  it("accounts completed model steps and enforces the configured ceiling only while busy", async () => {
    const run = async (busy: boolean) => {
      let aborted = false;
      const client = { session: {
        create: async () => ({ data: { id: "child" } }), promptAsync: async () => ({ data: undefined }),
        status: async () => ({ data: busy ? { child: { type: "busy" } } : {} }),
        messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant", finish: "stop", cost: .01, tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 40, write: 1 } } }, parts: [{ type: "text", text: "done" }] }] }),
        abort: async () => { aborted = true; return { data: true }; },
      } };
      const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { worker: { model: "current", systemPrompt: "work", tools: { question: false }, maxSteps: 1 } }, graphs: {}, defaultGraph: "default" };
      const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
      return { result: runtime.call({ agent: "worker", node: "work", prompt: "work", state: {} }), aborted: () => aborted };
    };
    const idle = await run(false);
    await expect(idle.result).resolves.toMatchObject({ text: "done", usage: { turns: 1, input: 12, output: 3, reasoning: 2, cacheRead: 40, cacheWrite: 1, cost: .01 } });
    expect(idle.aborted()).toBe(false);
    const busy = await run(true);
    await expect(busy.result).resolves.toMatchObject({ budgetStop: { metric: "turns", used: 1, limit: 1 } });
    expect(busy.aborted()).toBe(true);
  });

  it("forks explicit branch context and reports only delta usage and tools", async () => {
    const old = { info: { id: "old", role: "assistant", finish: "stop", cost: .1, tokens: { input: 100, cache: { read: 500 } } }, parts: [{ id: "old-tool", type: "tool", tool: "read", state: { status: "completed", title: "old", input: {} } }] };
    const fresh = { info: { id: "new", role: "assistant", finish: "stop", cost: .01, tokens: { input: 12, output: 3, cache: { read: 40 } } }, parts: [{ id: "new-tool", type: "tool", tool: "grep", state: { status: "completed", title: "new", input: { pattern: "x" } } }, { id: "new-text", type: "text", text: "done" }] };
    let forkBody: { messageID?: string } | undefined;
    let forkedMessageCalls = 0;
    const client = { session: {
      fork: async (input: { body?: { messageID?: string } }) => { forkBody = input.body; return { data: { id: "forked" } }; }, promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }),
      messages: async (input: { path: { id: string } }) => ({ data: input.path.id === "parent" ? [old] : forkedMessageCalls++ === 0 ? [old] : [old, fresh] }), abort: async () => ({ data: true }),
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { scout: { model: "current", systemPrompt: "scout", tools: { edit: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    const result = await runtime.call({ agent: "scout", node: "scout:p2", prompt: "inspect", state: {}, session: { strategy: "fork", sessionId: "parent" } });
    expect(result).toMatchObject({ sessionId: "forked", usage: { turns: 1, input: 12, output: 3, cacheRead: 40 }, tools: [{ tool: "grep", title: "new" }] });
    expect(forkBody).toBeUndefined();
    expect(result.usage?.cost).toBeCloseTo(.01);
  });

  it("forks before an aborted turn and ignores inherited answers while the new prompt starts", async () => {
    const user = { info: { id: "user", role: "user" }, parts: [{ id: "user-part", type: "text", text: "start" }] };
    const completed = { info: { id: "completed", role: "assistant", finish: "tool-calls" }, parts: [{ id: "completed-part", type: "text", text: "partial" }] };
    const aborted = { info: { id: "aborted", role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] };
    const answer = { info: { id: "answer", role: "assistant", finish: "stop" }, parts: [{ id: "answer-part", type: "text", text: "resumed" }] };
    let forkBody: { messageID?: string } | undefined;
    let forkedMessageCalls = 0;
    const client = { session: {
      fork: async (input: { body?: { messageID?: string } }) => { forkBody = input.body; return { data: { id: "forked" } }; },
      promptAsync: async () => ({ data: undefined }), status: async () => ({ data: {} }), abort: async () => ({ data: true }),
      messages: async (input: { path: { id: string } }) => {
        if (input.path.id === "parent") return { data: [user, completed, aborted] };
        return { data: forkedMessageCalls++ < 2 ? [user, completed] : [user, completed, answer] };
      },
    } };
    const definition: ConnectorDefinition = { version: 1, models: { current: { backend: "opencode", model: "inherit" } }, agents: { scout: { model: "current", systemPrompt: "scout", tools: {} } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal });
    await expect(runtime.call({ agent: "scout", node: "scout:p1", prompt: "continue", state: {}, session: { strategy: "fork", sessionId: "parent" } })).resolves.toMatchObject({ text: "resumed", sessionId: "forked" });
    expect(forkBody).toEqual({ messageID: "aborted" });
  });
});

describe("solution LOD reducer", () => {
  const state = (): SolutionLodState => ({
    stateVersion: 8, runId: "run", originalTask: "change", conversationContext: "prior decision", directory: "/repo", worktree: "/repo", phase: "forming-root-domain", activeBatch: [], results: [],
    network: initialNetwork("change"), usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, callsUsed: 0, startedAt: 0, result: "",
  });
  const candidate = (key: string, proposition: string, outcome: "possible" | "eliminated" | "selected" | "equivalent" = "possible") => ({ key, proposition, outcome, reasons: [], evidenceRefs: [] });
  const contract = (acceptanceCriteria: string[], coveredCriteria = acceptanceCriteria.map((_, index) => index)) => ({ delivery: "change" as const, allowedVariables: [], acceptanceCriteria, coveredCriteria });
  const stateWith = (network: SolutionNetwork): SolutionLodState => ({ ...state(), network });
  const synthesisActivation = (network: SolutionNetwork, regionId: string, operation: SynthesisOperation): Activation => {
    const region = network.regions.find((item) => item.id === regionId)!;
    network.nextActivationId = Math.max(network.nextActivationId, 1_000);
    const activation: Activation = { id: `a${network.nextActivationId++}`, capability: "synthesize", operation, domainFingerprint: region.domainFingerprint, regionId, request: operation, expectedDelta: `${operation}:${regionId}:${region.domainFingerprint}`, contextRefs: [regionId], status: "running", basisRevision: network.revision };
    network.activations.push(activation); region.activationIds.push(activation.id);
    return activation;
  };
  const acceptDomain = (network: SolutionNetwork, regionId = "r1") => {
    const region = network.regions.find((item) => item.id === regionId)!;
    region.domainPhase = "challenging";
    const activation = synthesisActivation(network, regionId, "challenge-domain");
    const accepted = mergeSynthesisOutput(stateWith(network), activation.id, { operation: "challenge-domain", verdict: "accept", domainFingerprint: region.domainFingerprint!, viableCandidateIds: region.candidateIds.filter((id) => network.candidates.find((item) => item.id === id)?.status !== "eliminated") });
    accepted.activations.find((item) => item.id === activation.id)!.status = "completed";
    return accepted;
  };
  const selectDelta = (network: SolutionLodState["network"], activationId: string, ...keys: string[]) => {
    const source = network.activations.find((item) => item.id === activationId); if (source) source.status = "completed";
    const regionId = source?.regionId ?? "r1";
    let current = propagateNetwork(network);
    let region = current.regions.find((item) => item.id === regionId)!;
    if (region.candidateIds.length && !current.candidates.some((item) => item.regionId === regionId && keys.includes(item.key) && item.status !== "eliminated")) {
      current = reopenRegion(current, regionId, "test reselection");
      region = current.regions.find((item) => item.id === regionId)!;
    }
    if (!region.candidateIds.length) {
      region.status = "superposed"; region.domainPhase = "ungenerated";
      const generatedKeys = [...new Set([...keys, keys.length === 1 ? `${keys[0]}-alternative` : "alternative"])];
      const activation = synthesisActivation(current, regionId, "generate-domain");
      current = mergeSynthesisOutput(stateWith(current), activation.id, { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: generatedKeys.map((key) => ({ key, proposition: `${key} approach`, evidenceRefs: [], stances: [] })) });
      current.activations.find((item) => item.id === activation.id)!.status = "completed";
    }
    current = acceptDomain(current, regionId);
    const live = current.regions.find((item) => item.id === regionId)!;
    const viable = live.candidateIds.filter((id) => current.candidates.find((item) => item.id === id)?.status !== "eliminated");
    const selectedId = current.candidates.find((item) => item.regionId === regionId && keys.includes(item.key))?.id ?? viable[0]!;
    const activation = synthesisActivation(current, regionId, "select-candidate");
    current = mergeSynthesisOutput(stateWith(current), activation.id, { operation: "select-candidate", domainFingerprint: live.domainFingerprint!, basis: viable.length === 1 ? "only-viable" : "lexicographic", selectedCandidateId: selectedId, hardConstraints: [], comparisons: viable.map((id) => ({ candidateId: id, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: id === selectedId ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) });
    current.activations.find((item) => item.id === activation.id)!.status = "completed";
    return current;
  };
  const certifyLeaf = (network: SolutionNetwork, regionId = "r1") => {
    const region = network.regions.find((item) => item.id === regionId)!;
    const activation: Activation = { id: `a${network.nextActivationId++}`, capability: "refine", regionId, request: "certify", expectedDelta: `certify:${regionId}`, contextRefs: [regionId], status: "running", basisRevision: network.revision };
    network.activations.push(activation); network.regions.find((item) => item.id === regionId)!.activationIds.push(activation.id);
    return mergeRefinementOutput(network, activation.id, { evidence: [], children: [], certifiedLeaf: { implementationScope: "bounded test change", criterionIds: [...region.criterionIds], evidenceRefs: [], mutationResources: ["src/test.ts"], checks: region.criterionIds.map((criterionId) => ({ criterionId, commandOrObservation: "run focused test" })) }, activations: [] });
  };
  const pushActivation = (network: SolutionLodState["network"], capability: "synthesize" | "refine" | "inspect", regionId: string, id: string) => {
    network.activations.push({ id, capability, regionId, request: capability, expectedDelta: `${capability}:${regionId}:${id}`, contextRefs: [regionId], status: "running", basisRevision: network.revision });
    network.regions.find((region) => region.id === regionId)?.activationIds.push(id);
  };

  it("keeps a criterion-less selection unrefined until refinement splits it", () => {
    const current = state();
    let merged = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], activations: [],
      candidates: [candidate("adapter", "Use an adapter"), candidate("rewrite", "Rewrite the subsystem")], select: [],
    });
    merged = selectDelta(merged, "a1", "adapter");
    expect(merged.regions.find((region) => region.id === "r1")?.status).toBe("unrefined");
    expect(merged.regions.filter((region) => region.parentId === "r1")).toHaveLength(0);
    expect(nextQueuedActivation(ensureRunnableWork(merged).network)).toMatchObject({ capability: "refine", regionId: "r1" });
  });

  it("rejects one result committing to multiple non-equivalent approaches", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", {
      candidates: [candidate("inline", "Inline provenance", "selected"), candidate("grouped", "Grouped details", "selected")],
      constraints: [], evidence: [], select: ["inline", "grouped"], activations: [],
    })).toThrow(/select-candidate operation/);
    expect(() => validateSolutionDelta(current, "r1", {
      candidates: [
        candidate("left", "Left approach", "selected"),
        candidate("right", "Right approach", "selected"),
        { ...candidate("twin", "Twin of left", "selected"), key: "twin" },
      ],
      constraints: [
        { kind: "equivalent", subject: "left", target: "twin", reason: "same approach", evidenceRefs: [] },
      ], evidence: [], select: ["left", "right", "twin"], activations: [],
    })).toThrow(/select-candidate operation/);
    expect(() => validateSolutionDelta(current, "r1", {
      candidates: [
        candidate("left", "Left approach", "selected"),
        candidate("twin", "Twin of left", "selected"),
      ],
      constraints: [
        { kind: "equivalent", subject: "left", target: "twin", reason: "same approach", evidenceRefs: [] },
      ], evidence: [], select: ["left", "twin"], activations: [],
    })).toThrow(/select-candidate operation/);
  });

  it("requires a certified leaf before any selected change becomes actionable", () => {
    const current = state();
    current.network.activations[0].status = "completed";
    let merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["target updated"] }, evidence: [], constraints: [], activations: [],
      candidates: [candidate("direct", "Direct change"), candidate("adapter", "Adapter change")], select: [],
    });
    merged = selectDelta(merged, "a1", "direct");
    expect(merged.regions[0]).toMatchObject({ status: "unrefined" });
    expect(nextQueuedActivation(ensureRunnableWork(merged).network)).toMatchObject({ capability: "refine", regionId: "r1" });
    merged = certifyLeaf(merged);
    expect(merged.regions[0]).toMatchObject({ status: "actionable" });
    expect(nextQueuedActivation(ensureRunnableWork(merged).network)).toMatchObject({ capability: "implement", regionId: "r1" });
  });

  it("materializes refined children, collapses the parent, and inspects each child before synthesis", () => {
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["mapping explicit", "docs updated"];
    current.network.regions[0].criterionIds = ["criterion:scope:r1:0", "criterion:scope:r1:1"];
    current.network = selectDelta(current.network, "a1", "direct");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [
        { key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: ["mapping contract"], acceptanceCriteria: ["mapping is explicit"], coveredCriteria: [0] },
        { key: "docs", objective: "Update docs", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["docs mention mapping"], coveredCriteria: [1] },
      ],
    });
    expect(current.network.regions.find((region) => region.id === "r1")?.status).toBe("collapsed");
    const children = current.network.regions.filter((region) => region.parentId === "r1");
    expect(children.map((region) => region.key)).toEqual(["mapping", "docs"]);
    expect(children.every((region) => region.status === "unformed" && region.lod === 1)).toBe(true);
    const scheduled = ensureRunnableWork(current.network);
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "inspect", regionId: children[0].id });
  });

  it("promotes an inspected child to synthesis only after its facts land", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "direct");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [{ key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }],
    });
    const child = current.network.regions.find((region) => region.parentId === "r1")!;
    pushActivation(current.network, "inspect", child.id, "a3");
    current.network = mergeSolutionDelta(current, "a3", { region: {}, evidence: [{ text: "mapping lives in config", source: "config.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] });
    expect(current.network.regions.find((region) => region.id === child.id)?.status).toBe("superposed");
    expect(nextQueuedActivation(ensureRunnableWork(current.network).network)).toMatchObject({ capability: "synthesize", operation: "generate-domain", regionId: child.id });
  });

  it("drops stale refinement children and the contract when synthesis chooses anew", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "adapter");
    pushActivation(current.network, "refine", "r1", "a2");
    current.network = mergeRefinementOutput(current.network, "a2", {
      evidence: [], activations: [],
      children: [{ key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }],
    });
    current.network = selectDelta(current.network, "a1", "rewrite");
    expect(current.network.regions.filter((region) => region.parentId === "r1")).toHaveLength(0);
    expect(current.network.regions[0]).toMatchObject({ status: "unrefined" });
    expect(current.network.regions[0].selectedCandidateIds).toEqual(["r1:rewrite"]);
  });

  it("rejects refinements that do not split into covering, self-carrying children", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "direct");
    current.network.regions[0].acceptanceCriteria = ["works", "documented"];
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [], activations: [] })).toThrow(/either one certified leaf contract/);
    const child = (key: string, coveredCriteria: number[], acceptanceCriteria: string[] = ["child done"]) => ({ key, objective: `${key} work`, edge: "partOf" as const, allowedVariables: [], acceptanceCriteria, coveredCriteria });
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [])], activations: [] })).toThrow(/does not address any known success criterion/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0])], activations: [] })).toThrow(/collectively cover/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0]), child("left", [1])], activations: [] })).toThrow(/distinct stable name/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0], []), child("right", [0, 1])], activations: [] })).toThrow(/carries no success criterion/);
    expect(() => validateRefinementOutput(current, "r1", { evidence: [], children: [child("left", [0]), child("right", [1])], activations: [] })).not.toThrow();
  });

    it("collapses a repository-backed read-only answer without synthesis or a child LOD, then verifies it", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" },
      evidence: [{ text: "The marker says ready", source: "SMOKE.md:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "ready", acceptanceCriteria: ["Report the marker exactly"], evidenceRefs: ["task", "SMOKE.md:1"] },
    });
    expect(network.regions).toHaveLength(1);
    expect(network.regions[0]).toMatchObject({ delivery: "answer", status: "implemented", answer: "ready", selectedCandidateIds: ["r1:resolved-answer"] });
    expect(network.candidates[0]).toMatchObject({ status: "selected", evidenceIds: ["e1"] });
    network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "verify", status: "queued" });
    const verified = completeVerification(scheduled.network, scheduled.network.activations.at(-1)!.id, { verdict: "pass", summary: "", findings: [], checks: [], activations: [] });
    expect(verified.regions[0].status).toBe("verified");
    expect(ensureRunnableWork(verified).done).toBe(true);
  });

  it("rejects a resolved answer that cites no real fact", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", {
      region: { delivery: "answer" },
      evidence: [], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Trust me.", acceptanceCriteria: ["answered"], evidenceRefs: [] },
    })).toThrow(/cite at least one real fact/);
    expect(() => validateSolutionDelta(current, "r1", {
      region: { delivery: "answer" },
      evidence: [{ text: "fact", source: "a.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Grounded.", acceptanceCriteria: ["answered"], evidenceRefs: ["a.ts:1"] },
    })).toThrow(/user authority/);
    expect(() => validateSolutionDelta(current, "r1", {
      region: { delivery: "answer" },
      evidence: [{ text: "fact", source: "a.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Grounded.", acceptanceCriteria: ["answered"], evidenceRefs: ["task", "a.ts:1"] },
    })).not.toThrow();
  });

  it("rejects downgrading a change goal to an answer while implementation alternatives remain possible", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      candidates: [
        { key: "left", proposition: "do it left", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "right", proposition: "do it right", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], evidence: [], select: [], activations: [],
    });
    expect(() => validateSolutionDelta({ ...current, network }, "r1", {
      region: { delivery: "answer" }, evidence: [], candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "just use left", acceptanceCriteria: ["answered"], evidenceRefs: ["task"] },
    })).toThrow(/remain possible/);
  });

  it("clears a stale conflict lock instead of letting a selected holder contest its own exclusions", () => {
    const current = state();
    let network = mergeSolutionDelta(current, "a1", {
      variables: [{ name: "provenance-surface", seedLabels: ["inline", "tree", "dedicated"] }],
      candidates: [
        { key: "inline", proposition: "Inline", outcome: "selected", reasons: [], evidenceRefs: [], stances: [{ variable: "provenance-surface", relation: "requires", valueLabel: "inline" }, { variable: "provenance-surface", relation: "excludes", valueLabel: "tree" }, { variable: "provenance-surface", relation: "excludes", valueLabel: "dedicated" }] },
        { key: "tree", proposition: "Tree", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "provenance-surface", relation: "requires", valueLabel: "tree" }] },
        { key: "dedicated", proposition: "Dedicated", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "provenance-surface", relation: "requires", valueLabel: "dedicated" }] },
      ],
      constraints: [], evidence: [], select: ["inline"], activations: [],
    });
    network = selectDelta(network, "a1", "inline");
    network = propagateNetwork(network);
    expect(network.regions[0].contradiction).toBeUndefined();
    const locked = propagateNetwork({ ...network, regions: [{ ...network.regions[0], status: "contradiction", contradiction: "Commitments conflict on shared choice: committed moves demand different options." }] });
    expect(locked.regions[0].contradiction).toBeUndefined();
    expect(locked.candidates.find((candidate) => candidate.key === "tree")?.status).toBe("eliminated");
  });

  it("rejects a standalone delivery rewrite without a resolved answer", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      region: { delivery: "answer" }, evidence: [], candidates: [], constraints: [], select: [], activations: [],
    })).toThrow(/may not rewrite the objective, delivery type/);
    expect(() => validateSolutionDelta(current, "r1", "inspect", {
      region: { delivery: "answer" }, evidence: [], candidates: [], constraints: [], select: [], activations: [],
    })).toThrow(/Delivery type may change only through/);
    expect(() => mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" }, evidence: [], candidates: [], constraints: [], select: [], activations: [],
    })).toThrow(/only valid through a complete resolvedAnswer/);
  });

  it("queues verification for a directly-resolved answer", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" },
      evidence: [{ text: "The section is already fully implemented", source: "TODO.md:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Already complete.", acceptanceCriteria: ["confirmed implemented"], evidenceRefs: ["task", "TODO.md:1"] },
    });
    expect(network.regions[0]).toMatchObject({ delivery: "answer", status: "implemented", answer: "Already complete." });
    network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "verify", status: "queued" });
  });

  it("allows independent regions to remain at different LODs", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "composed");
    current.network.regions.push(
      { ...current.network.regions[0], id: "r2", key: "api", parentId: "r1", edge: "partOf" as const, lod: 1, status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], artifactIds: [] },
      { ...current.network.regions[0], id: "r3", key: "storage", parentId: "r1", edge: "partOf" as const, lod: 1, status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], artifactIds: [] },
    );
    const api = current.network.regions.find((region) => region.key === "api")!;
    pushActivation(current.network, "synthesize", api.id, "a99");
    current.network = selectDelta(current.network, "a99", "direct");
    expect(current.network.regions.find((region) => region.key === "api")?.status).toBe("unrefined");
    pushActivation(current.network, "refine", api.id, "a100");
    current.network = mergeRefinementOutput(current.network, "a100", { evidence: [], activations: [], children: [{ key: "ship", objective: "Ship the API work", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["API works"], coveredCriteria: [0] }] });
    expect(current.network.regions.find((region) => region.key === "api")?.status).toBe("collapsed");
    expect(current.network.regions.find((region) => region.key === "ship")?.status).toBe("unformed");
    expect(current.network.regions.find((region) => region.key === "storage")?.status).toBe("unformed");
  });

  it("propagates hard refutations immediately but waits for accepted selection", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [{ text: "rewrite is incompatible", source: "src/a.ts:1", kind: "repository" }], activations: [],
      candidates: [
        candidate("adapter", "Adapter"),
        candidate("rewrite", "Rewrite"),
      ], constraints: [{ kind: "refutes", subject: "e1", target: "rewrite", reason: "incompatible contract" }], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "rewrite")?.status).toBe("eliminated");
    expect(merged.candidates.find((candidate) => candidate.key === "adapter")?.status).toBe("possible");
    expect(merged.regions[0].selectedCandidateIds).toEqual([]);
    const selected = selectDelta(merged, "a1", "adapter");
    expect(selected.candidates.find((candidate) => candidate.key === "adapter")?.status).toBe("selected");
    expect(selected.regions[0].status).toBe("unrefined");
  });

  it("invalidates a selected candidate whose required target is unavailable", () => {
    const current = state();
    let merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] },
      evidence: [{ text: "The dependency is unavailable", source: "src/dependency.ts:1", kind: "repository" }],
      candidates: [candidate("source", "Use the dependent design"), candidate("target", "Provide the dependency")],
      constraints: [
        { kind: "requires", subject: "source", target: "target", reason: "source needs target" },
        { kind: "refutes", subject: "src/dependency.ts:1", target: "target", reason: "dependency is unavailable", evidenceRefs: ["src/dependency.ts:1"] },
      ],
      select: [], activations: [],
    });
    expect(merged.candidates.find((item) => item.key === "target")?.status).toBe("eliminated");
    expect(merged.candidates.find((item) => item.key === "source")).toMatchObject({ status: "eliminated", declaredStatus: "possible" });
    expect(merged.candidates.find((item) => item.key === "source")?.eliminationReasons).toContain("source needs target");
    expect(merged.regions[0].status).toBe("contradiction");
    expect(propagateNetwork(merged)).toEqual(merged);
  });

  it("does not eliminate a refutes target when the refuting candidate is itself rejected", () => {
    const current = state();
    let merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [{ text: "bad-a violates contract", source: "a:1", kind: "repository" }, { text: "bad-b is legacy", source: "b:1", kind: "repository" }], activations: [],
      candidates: [
        candidate("good", "Good"),
        candidate("bad-a", "Bad A"),
        candidate("bad-b", "Bad B"),
      ], constraints: [
        { kind: "refutes", subject: "bad-a", target: "good", reason: "bad-a disagrees" },
        { kind: "refutes", subject: "bad-b", target: "good", reason: "bad-b disagrees" },
        { kind: "refutes", subject: "a:1", target: "bad-a", reason: "violates contract", evidenceRefs: ["a:1"] },
        { kind: "refutes", subject: "b:1", target: "bad-b", reason: "legacy path", evidenceRefs: ["b:1"] },
      ], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "good")?.status).toBe("possible");
    merged = selectDelta(merged, "a1", "good");
    expect(merged.candidates.find((candidate) => candidate.key === "good")?.status).toBe("selected");
    expect(merged.regions[0].status).toBe("unrefined");
  });

  it("still fires a refutes constraint from a non-candidate subject like task or evidence", () => {
    const current = state();
    let merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        candidate("kept", "Kept"),
        candidate("ruled-out", "Ruled out"),
      ], constraints: [{ kind: "refutes", subject: "task", target: "ruled-out", reason: "the request itself rules this out" }], select: [],
    });
    expect(merged.candidates.find((candidate) => candidate.key === "ruled-out")?.status).toBe("eliminated");
    expect(merged.candidates.find((candidate) => candidate.key === "kept")?.status).toBe("possible");
    merged = selectDelta(merged, "a1", "kept");
    expect(merged.candidates.find((candidate) => candidate.key === "kept")?.status).toBe("selected");
  });

  it("recomputes symmetric exclusion idempotently from authored candidate state", () => {
    const current = state();
    let merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [candidate("left", "Left"), { ...candidate("right", "Right"), outcome: "selected" }],
      constraints: [{ kind: "excludes", subject: "left", target: "right", reason: "mutually exclusive" }], select: ["right"],
    });
    expect(merged.candidates.find((item) => item.key === "left")?.status).toBe("possible");
    merged = selectDelta(merged, "a1", "right");
    expect(merged.candidates.find((item) => item.key === "left")?.status).toBe("eliminated");
    const again = propagateNetwork(merged);
    expect(again.revision).toBe(merged.revision);
    expect(again.candidates.find((item) => item.key === "left")?.eliminationReasons).toEqual(["mutually exclusive"]);
  });

  it("rejects role overreach and endpoint-invalid constraints before merge", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", "inspect", {
      evidence: [], candidates: [candidate("x", "X")], constraints: [], select: [], activations: [],
    })).toThrow(/Inspection may report sourced facts/);
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      evidence: [], candidates: [candidate("x", "X")], constraints: [{ kind: "requires", subject: "task", target: "x", reason: "invalid hard endpoint" }], select: [], activations: [],
    })).toThrow(/Invalid requires endpoints/);
  });

  it("requires observable implementation and criterion-specific verification evidence", () => {
    const current = state(); current.network.regions[0].acceptanceCriteria = ["target updated"]; current.network.regions[0].criterionIds = ["criterion:scope:r1:0"];
    current.network = certifyLeaf(selectDelta(current.network, "a1", "direct"));
    expect(() => validateImplementationOutput(current, "r1", { status: "completed", summary: "done", changedFiles: [], checks: [], activations: [] })).toThrow(/focused check/);
    expect(() => validateVerificationOutput(current, "r1", { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "smoke", passed: true, evidence: "unrelated" }], activations: [] })).toThrow(/criterion-specific evidence/);
    expect(() => validateVerificationOutput(current, "r1", { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: yes" }], completionEvidence: { implementation: "already satisfied after inspection", directTest: "focused passed", correctnessReview: "reviewed", releaseGate: "full passed", changedFiles: [], focusedTests: ["focused"], fullChecks: ["full"] }, activations: [] })).not.toThrow();
  });

  it("demotes previously selected candidates when a resolved answer lands", () => {
    const current = state();
    current.network = selectDelta(current.network, "a1", "inspect-then-split");
    const merged = mergeSolutionDelta(current, "a1", {
      region: { delivery: "answer" }, evidence: [{ text: "Already covered", source: "src/x.spec.ts:1", kind: "repository" }],
      candidates: [], constraints: [], select: [], activations: [],
      resolvedAnswer: { answer: "Already covered.", acceptanceCriteria: ["confirmed"], evidenceRefs: ["src/x.spec.ts:1"] },
    });
    const region = merged.regions[0];
    const selected = merged.candidates.filter((candidate) => candidate.regionId === region.id && candidate.status === "selected");
    expect(selected.map((candidate) => candidate.key)).toEqual(["resolved-answer"]);
    expect(merged.candidates.find((candidate) => candidate.key === "inspect-then-split")?.status).not.toBe("selected");
    expect(region.status).toBe("implemented");
  });

  it("rejects a delta that eliminates every candidate without a selection", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], select: [],
    });
    expect(() => validateSolutionDelta(current, current.network.regions[0].id, {
      evidence: [], constraints: [], activations: [], select: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["supporting evidence misread as defeater"], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "eliminated", reasons: ["supporting evidence misread as defeater"], evidenceRefs: [] },
      ],
    })).toThrow(/cannot be directly eliminated/);
    expect(() => validateSolutionDelta(current, current.network.regions[0].id, {
      evidence: [], constraints: [], activations: [], select: ["alpha"],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "possible", reasons: [], evidenceRefs: [] },
      ],
    })).toThrow(/select-candidate operation/);
  });

  it("rejects an all-eliminating delta even when it selects an unknown candidate key", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [], constraints: [], select: [],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] }],
    });
    expect(() => validateSolutionDelta(current, "r1", {
      evidence: [], constraints: [], activations: [], select: ["ghost"],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["misread defeater"], evidenceRefs: [] }],
    })).toThrow(/select-candidate operation/);
    expect(() => validateSolutionDelta(current, "r1", {
      evidence: [], constraints: [], activations: [], select: ["alpha"],
      candidates: [{ key: "alpha", proposition: "Alpha", outcome: "eliminated", reasons: ["misread defeater"], evidenceRefs: [] }],
    })).toThrow(/select-candidate operation/);
  });

  it("resynthesizes a pruned region even when its completed synthesis activation survives", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], constraints: [], activations: [], select: [],
      candidates: [
        { key: "alpha", proposition: "Alpha", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "beta", proposition: "Beta", outcome: "possible", reasons: [], evidenceRefs: [] },
      ],
    });
    // Legacy end-state: the region's synthesis completed, then every candidate was eliminated.
    current.network.activations.push({ id: "a9", capability: "synthesize", regionId: "r1", request: "form domain", expectedDelta: "synthesis:r1", contextRefs: ["r1"], status: "completed", basisRevision: current.network.revision });
    for (const candidate of current.network.candidates) candidate.status = "eliminated";
    // Simulate pruneRun: reopen the region, keep only its completed activations, clear its activation list.
    const reopened = reopenRegion(current.network, "r1", "pruned for resynthesis");
    const pruned = {
      ...reopened,
      activations: reopened.activations.filter((item) => item.regionId !== "r1" || item.status === "completed"),
      regions: reopened.regions.map((item) => item.id === "r1" ? { ...item, activationIds: [] } : item),
    };
    const scheduled = ensureRunnableWork(pruned);
    expect(scheduled.blocked).toBeUndefined();
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "synthesize", regionId: "r1" });
  });

  it("canonicalizes region-prefixed candidate keys and rejects dangling constraints", () => {
    const current = state();
    expect(() => mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "r1:direct", proposition: "Direct extension", outcome: "selected", reasons: [], evidenceRefs: [] }],
      constraints: [{ kind: "requires", subject: "imaginary-subject", target: "imaginary-target", reason: "decorative prose" }],
      select: ["r1:direct"],
    })).toThrow(/unknown endpoint/);
    expect(() => mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], candidates: [], select: [], activations: [],
      constraints: [{ kind: "acceptance", subject: "task", target: "task", reason: "inert" } as never],
    })).toThrow(/Unknown constraint kind/);
    expect(current.network.candidates).toEqual([]);
  });

  it("never makes a bare selection actionable without a certified refinement", () => {
    const current = state();
    const network = selectDelta(current.network, "a1", "direct");
    expect(network.regions[0]).toMatchObject({ status: "unrefined" });
    expect(nextQueuedActivation(ensureRunnableWork(network).network)).toMatchObject({ capability: "refine" });
  });

  it("ignores resolvedAnswer injected into a change-delivery synthesis delta", () => {
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["files change"];
    current.network.regions[0].criterionIds = ["criterion:scope:r1:0"];
    current.network = selectDelta(current.network, "a1", "direct");
    const network = mergeSolutionDelta({ ...current, network: current.network }, current.network.activations.at(-1)!.id, {
      region: { delivery: "change" }, evidence: [], constraints: [], activations: [], select: [], candidates: [],
      resolvedAnswer: { answer: "Here is a plan", acceptanceCriteria: ["describe it"], evidenceRefs: [] },
    });
    expect(network.regions[0]).toMatchObject({ delivery: "change", status: "unrefined", selectedCandidateIds: ["r1:direct"] });
    expect(network.regions[0].answer).toBeUndefined();
  });

  it("reopens one implicated region while preserving sibling verification and artifacts", () => {
    const network = initialNetwork("change");
    network.regions.push(
      { ...network.regions[0], id: "r2", key: "left", parentId: "r1", edge: "partOf", lod: 1, status: "verified", artifactIds: ["x1"], activationIds: [], candidateIds: [], selectedCandidateIds: [] },
      { ...network.regions[0], id: "r3", key: "right", parentId: "r1", edge: "partOf", lod: 1, status: "verified", artifactIds: ["x2"], activationIds: [], candidateIds: ["r3:choice"], selectedCandidateIds: ["r3:choice"] },
    );
    network.candidates.push({ id: "r3:choice", regionId: "r3", key: "choice", proposition: "choice", status: "selected", evidenceIds: [], eliminationReasons: [] });
    network.artifacts.push({ id: "x1", regionId: "r2", kind: "file", path: "left.ts", summary: "left", activationId: "a1" }, { id: "x2", regionId: "r3", kind: "file", path: "right.ts", summary: "right", activationId: "a1" });
    const reopened = reopenRegion(network, "r3", "criterion failed");
    expect(reopened.regions.find((region) => region.id === "r2")?.status).toBe("verified");
    expect(reopened.regions.find((region) => region.id === "r3")?.status).toBe("unformed");
    expect(reopened.artifacts.map((artifact) => artifact.path)).toEqual(["left.ts", "right.ts"]);
  });

  it("schedules the frontier by viable-domain size, deepest first on ties", () => {
    const network = initialNetwork("task");
    network.activations[0].status = "completed";
    network.regions[0].status = "collapsed";
    network.regions[0].domainPhase = "selected";
    network.regions[0].acceptanceCriteria = ["settled"];
    for (const [id, key, viableCount, lod] of [["r2", "wide", 4, 0], ["r3", "narrow", 2, 0], ["r4", "deep-tie", 3, 2], ["r5", "shallow-tie", 3, 1]] as const) {
      network.regions.push({ ...network.regions[0], id, key, scopeId: `scope:${id}`, parentId: "r1", edge: "partOf", lod, objective: key, delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "superposed", domainPhase: "challenging", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
      for (let index = 0; index < viableCount; index += 1) {
        const candidateId = `${id}:c${index}`;
        network.candidates.push({ id: candidateId, regionId: id, key: `c${index}`, proposition: `option ${index}`, status: "possible", evidenceIds: [], eliminationReasons: [], stances: [] });
        network.regions.find((region) => region.id === id)!.candidateIds.push(candidateId);
      }
    }
    // One pass, width 4: narrow first (viable 2), tie broken by depth (r4 before r5), wide last.
    const scheduled = ensureRunnableWork(network, 4);
    expect(scheduled.network.activations.filter((item) => item.status === "queued").slice(-4).map((item) => item.regionId)).toEqual(["r3", "r4", "r5", "r2"]);
  });

  it("projects shared choices with bindings and refuted options into activation payloads", () => {
    const current = state();
    current.network.variables.push({ id: "v1", name: "http-client", ownerRegionId: "r1", seedLabels: ["undici", "node-fetch"] });
    current.network.evidence.push({ id: "e7", text: "repo standardizes on undici", source: "src/http.ts:1", kind: "repository", fingerprint: "f7" }, { id: "e8", text: "unrelated fact", source: "other.ts:1", kind: "repository", fingerprint: "f8" });
    current.network.constraints.push({ id: "c7", kind: "refutes", subject: "e7", target: "v1:node-fetch", reason: "conflicts with repo standard", sourceActivationId: "a1", sourceKind: "repo-evidence", evidenceRefs: ["e7"] });
    current.network.regions[0].evidenceIds.push("e7");
    current.network.activations[0].contextRefs.push("e7");
    const projection = projectActivationContext(current, current.network.activations[0]) as { variableStates: unknown[] };
    expect(projection.variableStates).toEqual([{
      id: "v1", name: "http-client", declaredAt: "r1", knownLabels: ["undici", "node-fetch"], binding: undefined, bindingWitnesses: [], bindingConflict: undefined,
      unavailableLabels: ["node-fetch"], unavailabilityWitnesses: [{ valueLabel: "node-fetch", constraintId: "c7", relationship: "refutes", evidenceRefs: ["e7"], reason: "conflicts with repo standard" }],
    }]);
  });

  it("projects every conflicting binding witness instead of overwriting one", () => {
    const current = state();
    current.network.variables.push({ id: "v1", name: "runtime", ownerRegionId: "r1", seedLabels: ["node", "bun"] });
    current.network.candidates.push(
      { id: "r1:node", regionId: "r1", key: "node", proposition: "Node", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "node" }] },
      { id: "r1:bun", regionId: "r1", key: "bun", proposition: "Bun", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "bun" }] },
    );
    current.network.regions[0].candidateIds = ["r1:node", "r1:bun"];
    current.network.regions[0].selectedCandidateIds = ["r1:node", "r1:bun"];
    const projection = projectActivationContext(current, current.network.activations[0]) as { variableStates: Array<{ binding?: string; bindingConflict?: string[]; bindingWitnesses: Array<{ candidateId: string }> }> };
    expect(projection.variableStates[0].binding).toBeUndefined();
    expect(projection.variableStates[0].bindingConflict).toEqual(["bun", "node"]);
    expect(projection.variableStates[0].bindingWitnesses.map((item) => item.candidateId)).toEqual(["r1:bun", "r1:node"]);
  });

  it("projects only referenced context and the collapsed ancestry", () => {
    const current = state();
    current.network.evidence.push({ id: "e1", text: "relevant", source: "a.ts", kind: "repository", fingerprint: "1" }, { id: "e2", text: "unrelated", source: "b.ts", kind: "repository", fingerprint: "2" });
    current.network.regions[0].evidenceIds.push("e1");
    current.network.activations[0].contextRefs.push("e1");
    for (let index = 0; index < 300; index += 1) {
      const suffix = String(index);
      current.network.evidence.push({ id: `noise-e${suffix}`, text: `unrelated fact ${suffix}`, source: `noise/${suffix}.ts:1`, kind: "repository", fingerprint: `ne${suffix}` });
      current.network.artifacts.push({ id: `noise-x${suffix}`, regionId: "r1", kind: "file", path: `noise/${suffix}.txt`, summary: `unrelated ${suffix}`, activationId: "a1" });
    }
    const projection = JSON.stringify(projectActivationContext(current, current.network.activations[0]));
    expect(projection).toContain("prior decision");
    expect(projection).toContain("relevant");
    expect(projection).not.toContain("unrelated");
    expect(projection.length, "projection must stay bounded by references, not by network size").toBeLessThan(JSON.stringify(current.network).length / 3);
    expect(projection).not.toContain("nextActivationId");
  });

  it("gives agents concise role-native instructions instead of controller vocabulary", () => {
    for (const contract of Object.values(SOLUTION_ROLE_CONTRACTS)) {
      expect(contract.systemPrompt).not.toMatch(/\b(?:LOD|ancestry|region|collapsed|domain|activation|allowedVariables)\b/i);
      expect(contract.systemPrompt.length).toBeLessThan(1_100);
    }
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["target behavior works"];
    current.network.regions[0].criterionIds = ["criterion:scope:r1:0"];
    current.network.candidates.push({ id: "r1:direct", regionId: "r1", key: "direct", proposition: "Extend the existing implementation", status: "selected", evidenceIds: [], eliminationReasons: [] });
    current.network.regions[0].candidateIds = ["r1:direct"];
    current.network.regions[0].selectedCandidateIds = ["r1:direct"];
    const implement = { ...current.network.activations[0], capability: "implement" as const, request: "Implement the selected behavior" };
    const projection = projectActivationContext(current, implement);
    expect(projection).toMatchObject({
      goal: "change",
      successCriteria: [{ criterionId: "criterion:scope:r1:0", criterion: "target behavior works" }],
      chosenApproach: [{ regionId: "r1", scopeId: "scope:r1", candidateId: "r1:direct", choice: "Extend the existing implementation", evidenceIds: [] }],
    });
    expect(projection).not.toHaveProperty("decisionsAlreadyMade");
    expect(projection).not.toHaveProperty("region");
    expect(projection).not.toHaveProperty("collapsedAncestry");
    expect(projection).not.toHaveProperty("domain");
    expect(projection).not.toHaveProperty("availableCapabilities");
  });

  it("compiles confirmed facts and unresolved claims into different operational permissions", () => {
    const current = state();
    current.network.evidence.push(
      { id: "e1", text: "package pins Node 20", source: "package.json:4", kind: "repository", status: "confirmed", fingerprint: "f1" },
      { id: "e2", text: "Node 16 may be unsupported", source: "model", kind: "inference", status: "hypothesis", validationKind: "repository-evidence", fingerprint: "f2" },
    );
    current.network.activations[0].contextRefs.push("e1", "e2");
    const compiled = compileActivationPrompt(current, { ...current.network.activations[0], capability: "synthesize" });
    expect(compiled).toContain("CONFIRMED FACTS");
    expect(compiled).toContain("package pins Node 20");
    expect(compiled).toContain("UNRESOLVED CLAIMS — NO PRUNING AUTHORITY");
    expect(compiled).toContain("Node 16 may be unsupported");
    expect(compiled).toContain("generation, challenge, and selection are exclusive");
    expect(compiled).toContain("Never self-approve");
    expect(compiled).not.toContain("nextActivationId");
  });

  it("keeps compiled prompts bounded when unrelated graph state grows", () => {
    const current = state();
    const activation = current.network.activations[0];
    const before = compileActivationPrompt(current, activation);
    for (let index = 0; index < 300; index++) current.network.evidence.push({ id: `noise-${index}`, text: `noise ${index}`, source: `noise/${index}`, kind: "repository", fingerprint: `n${index}` });
    expect(compileActivationPrompt(current, activation)).toBe(before);
  });

  it("preserves user wording while keeping the same local operation contract", () => {
    const left = state(); const right = state();
    left.originalTask = "Add a cache without changing deployment";
    right.originalTask = "Introduce caching while preserving the deployment topology";
    const leftPrompt = compileActivationPrompt(left, left.network.activations[0]);
    const rightPrompt = compileActivationPrompt(right, right.network.activations[0]);
    expect(leftPrompt).toContain(left.originalTask);
    expect(rightPrompt).toContain(right.originalTask);
    expect(leftPrompt).toContain("inspect: Find repository facts needed");
    expect(rightPrompt).toContain("inspect: Find repository facts needed");
  });

  it("compiles a bounded operational contract for every role", () => {
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["criterion zero"];
    current.network.candidates.push({ id: "r1:a", regionId: "r1", key: "a", proposition: "Existing approach", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [] });
    current.network.regions[0].candidateIds.push("r1:a");
    current.network.artifacts.push({ id: "x1", regionId: "r1", kind: "file", path: "src/a.ts", summary: "implemented output", activationId: "a0" });
    current.network.activations[0].contextRefs.push("x1");
    for (const capability of ["inspect", "synthesize", "refine", "implement", "verify", "present"] as const) {
      const compiled = compileActivationPrompt(current, { ...current.network.activations[0], capability });
      expect(compiled).toContain(`LOCAL OPERATION\n${capability}:`);
      expect(compiled).toContain("DECISION BOUNDARY");
      expect(compiled).toContain("DATA BOUNDARY");
      expect(compiled).toContain("Return exactly one JSON value");
      expect(compiled.length).toBeLessThan(3500);
      expect(flattenSchemaLines(renderSchemaInput(compiled)!)).toContain(capability);
      if (capability === "synthesize") expect(compiled).toContain("CURRENT ALTERNATIVES\n[{\"referenceId\":\"r1:a\"");
      if (capability === "refine") { expect(compiled).toContain("NUMBERED PARENT CRITERIA"); expect(compiled).toContain("ONE-LEVEL DECOMPOSITION CONTRACT"); }
      if (capability === "implement" || capability === "verify" || capability === "present") expect(compiled).toContain("implemented output");
    }
  });

  it("forms an unformed region by inspection before synthesis, then reports convergence instead of looping", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    network.regions[0].status = "superposed";
    network.regions[0].domainPhase = "ungenerated";
    const first = ensureRunnableWork(network);
    expect(first.network.activations.at(-1)).toMatchObject({ capability: "synthesize", operation: "generate-domain", status: "queued" });
    first.network.activations.at(-1)!.status = "completed";
    const second = ensureRunnableWork(first.network);
    expect(second.blocked).toContain("No activation can make a novel state delta");
    expect(second.network.activations).toHaveLength(2);
  });

  it("schedules inspection for an unformed region before any synthesis", () => {
    const current = state();
    current.network.activations[0].status = "completed";
    const scheduled = ensureRunnableWork(current.network);
    expect(scheduled.done).toBe(false);
    expect(nextQueuedActivation(scheduled.network)).toMatchObject({ capability: "inspect", regionId: "r1" });
  });

  it("reschedules a failed implement activation instead of dead-ending", () => {
    let network = initialNetwork("change");
    network.regions[0].acceptanceCriteria = ["works"]; network.regions[0].criterionIds = ["criterion:scope:r1:0"];
    network = certifyLeaf(selectDelta(network, "a1", "direct"));
    network.activations.push({ id: "a2", capability: "implement", regionId: "r1", request: "implement", expectedDelta: `implement:r1:${network.revision}`, contextRefs: ["r1"], status: "failed", basisRevision: network.revision });
    const scheduled = ensureRunnableWork(network);
    expect(scheduled.done).toBe(false);
    expect(scheduled.network.regions[0].status).toBe("actionable");
    expect(scheduled.network.activations.at(-1)).toMatchObject({ capability: "implement", status: "queued" });
  });

  it("collapses an equivalent surviving set as one implementer-local choice", () => {
    const current = state();
    let network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["behavior is equivalent"] }, evidence: [], activations: [],
      candidates: [
        { key: "a", proposition: "Equivalent implementation A", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "b", proposition: "Equivalent implementation B", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [{ kind: "equivalent", subject: "a", target: "b", reason: "same external contract" }], select: [],
    });
    network = certifyLeaf(selectDelta(network, "a1", "a"));
    expect(network.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:a", "r1:b"] });
  });

  it("rejects multiple selected non-equivalent alternatives before merge", () => {
    const current = state();
    current.network.regions[0].acceptanceCriteria = ["one coherent design"];
    current.network.regions[0].criterionIds = ["criterion:scope:r1:0"];
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      region: { acceptanceCriteria: ["one coherent design"] }, evidence: [], constraints: [], activations: [],
      candidates: [
        { key: "event-shape", proposition: "Choose an event shape", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "duplicate-policy", proposition: "Choose a duplicate policy", outcome: "selected", reasons: [], evidenceRefs: [] },
      ], select: ["event-shape", "duplicate-policy"],
    })).toThrow(/select-candidate operation/);
  });

  it("gives fail distinct blocked semantics instead of silently reopening a choice", () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    network.regions[0].status = "implemented";
    network.regions[0].candidateIds = ["r1:choice", "r1:alt"];
    network.regions[0].selectedCandidateIds = ["r1:choice"];
    network.candidates.push(
      { id: "r1:choice", regionId: "r1", key: "choice", proposition: "chosen approach", status: "selected", evidenceIds: [], eliminationReasons: [] },
      { id: "r1:alt", regionId: "r1", key: "alt", proposition: "alternative approach", status: "possible", evidenceIds: [], eliminationReasons: [] },
    );
    network.activations.push({ id: "a2", capability: "verify", regionId: "r1", request: "verify", expectedDelta: "verification:r1", contextRefs: ["r1"], status: "running", basisRevision: 0 });
    const verified = completeVerification(network, "a2", { verdict: "fail", summary: "evidence contradicts the design", findings: [], checks: [], activations: [] });
    expect(verified.regions[0].status).toBe("blocked");
    expect(verified.regions[0].contradiction).toContain("evidence contradicts");
    const scheduled = ensureRunnableWork(verified);
    expect(scheduled.done).toBe(false);
    expect(scheduled.blocked).toContain("evidence contradicts the design");
  });

  it("treats transitively chained equivalence as one interchangeable set", () => {
    const current = state();
    let network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["one behavior"] }, evidence: [], activations: [],
      candidates: [
        { key: "a", proposition: "A", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "b", proposition: "B", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "c", proposition: "C", outcome: "possible", reasons: [], evidenceRefs: [] },
      ],
      constraints: [{ kind: "equivalent", subject: "a", target: "b", reason: "same" }, { kind: "equivalent", subject: "b", target: "c", reason: "same" }],
      select: [],
    });
    network = certifyLeaf(selectDelta(network, "a1", "a"));
    expect(network.regions[0].status).not.toBe("contradiction");
    expect(network.regions[0]).toMatchObject({ status: "actionable", selectedCandidateIds: ["r1:a", "r1:b", "r1:c"] });
  });

  it("rejects duplicate candidate keys and normalized proposition/stance identities", () => {
    const current = state();
    expect(() => mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        { key: "auth service", proposition: "Auth service", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "auth-service", proposition: "Auth service, refined", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], select: [],
    })).toThrow(/duplicates another candidate key/);
    expect(() => mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [
        { key: "first", proposition: "Use the existing auth service.", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "renamed", proposition: "use the existing AUTH service", outcome: "possible", reasons: [], evidenceRefs: [] },
      ], constraints: [], select: [],
    })).toThrow(/duplicates established candidate/);
    expect(current.network.candidates).toEqual([]);
  });

  it("keeps the same proposition distinct when its normalized stances differ", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [], select: [], constraints: [],
      variables: [{ name: "runtime", seedLabels: ["node", "bun"] }],
      candidates: [
        { key: "node", proposition: "Use the selected runtime", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "runtime", relation: "requires", valueLabel: "node" }] },
        { key: "bun", proposition: "Use the selected runtime", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "runtime", relation: "requires", valueLabel: "bun" }] },
      ],
    });
    expect(network.candidates).toHaveLength(2);
  });

  it("deduplicates constraints by operative identity instead of paraphrased reason text", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] },
      evidence: [{ text: "API already exports x", source: "src/api.ts:1", kind: "repository" }],
      candidates: [{ key: "reuse", proposition: "Reuse the API", outcome: "possible", reasons: [], evidenceRefs: [] }],
      constraints: [
        { kind: "supports", subject: "src/api.ts:1", target: "reuse", reason: "The export exists", sourceKind: "repo-evidence", evidenceRefs: ["src/api.ts:1"] },
        { kind: "supports", subject: "src/api.ts:1", target: "reuse", reason: "Existing API export supports reuse", sourceKind: "repo-evidence", evidenceRefs: ["src/api.ts:1"] },
        { kind: "supports", subject: "src/api.ts:1", target: "reuse", reason: "Reuse is supported by that export", sourceKind: "repo-evidence", evidenceRefs: ["src/api.ts:1"] },
      ],
      select: [], activations: [],
    });
    expect(network.constraints).toHaveLength(1);
    expect(network.constraints[0]).toMatchObject({ kind: "supports", subject: "e1", target: "r1:reuse", evidenceRefs: ["e1"] });
    expect(network.regions[0].constraintIds).toEqual([network.constraints[0].id]);
  });

  it("batches queued read-only activations on pairwise distinct regions and keeps mutating work singleton", () => {
    const network = initialNetwork("task");
    for (const id of ["r2", "r3"]) network.regions.push({ ...network.regions[0], id, key: id, scopeId: `scope:${id}`, parentId: "r1", edge: "partOf", lod: 1, objective: id, delivery: "change", allowedVariables: [], acceptanceCriteria: [], status: "unformed", domainPhase: "inspecting", candidateIds: [], selectedCandidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] });
    const queued = (id: string, capability: Activation["capability"], regionId: string, basisRevision = 0) => network.activations.push({ id, capability, regionId, request: id, expectedDelta: id, contextRefs: [regionId], status: "queued", basisRevision });
    queued("a2", "inspect", "r2"); queued("a3", "inspect", "r3"); queued("a4", "synthesize", "r1"); queued("a5", "implement", "r3", 1);
    expect(selectActivationBatch(network, 4).map((item) => item.id)).toEqual(["a1", "a2", "a3"]);
    expect(selectActivationBatch(network, 2).map((item) => item.id)).toEqual(["a1", "a2"]);
    for (const item of network.activations) item.status = "completed";
    queued("a9", "implement", "r1", 5); queued("a10", "inspect", "r2", 5);
    network.regions[0].status = "actionable";
    expect(selectActivationBatch(network, 4).map((item) => item.id)).toEqual(["a9"]);
  });

  it("applies batch records in (basisRevision, activationId) order regardless of completion order", () => {
    const network = initialNetwork("task");
    network.activations.push({ id: "a2", capability: "inspect", regionId: "r1", request: "a2", expectedDelta: "a2", contextRefs: ["r1"], status: "running", basisRevision: 1 });
    const record = (activationId: string, basisRevision: number, text: string): ActivationTaskResult => ({
      activationId, regionId: "r1", capability: "inspect", basisRevision, startedAt: 0, finishedAt: 0,
      usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "applied", networkDelta: { kind: "delta", delta: { evidence: [{ text, source: text, kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] } },
    });
    const application = applyBatchRecords(network, [record("a2", 1, "second"), record("a1", 0, "first")]);
    expect(application.applied).toEqual(["a1", "a2"]);
    expect(application.network.evidence.map((item) => item.text)).toEqual(["first", "second"]);
    expect(application.network.activations.filter((item) => ["a1", "a2"].includes(item.id)).map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  it("propagates a failed activation record and clears a stale commitment-conflict lock", () => {
    const network = initialNetwork("task");
    network.activations[0].status = "running";
    network.variables.push({ id: "v1", name: "runtime", ownerRegionId: "r1", seedLabels: ["node", "bun"] });
    network.candidates.push(
      { id: "r1:node", regionId: "r1", key: "node", proposition: "Use Node", status: "selected", declaredStatus: "selected", evidenceIds: [], declaredEvidenceIds: [], eliminationReasons: [], declaredEliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "node" }] },
      { id: "r1:bun", regionId: "r1", key: "bun", proposition: "Use Bun", status: "eliminated", declaredStatus: "possible", evidenceIds: [], declaredEvidenceIds: [], eliminationReasons: ["refuted"], declaredEliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "bun" }] },
    );
    network.regions[0].candidateIds = ["r1:node", "r1:bun"];
    network.regions[0].selectedCandidateIds = ["r1:node"];
    network.regions[0].status = "contradiction";
    network.regions[0].contradiction = "Commitments conflict on shared choice: stale";
    const failed: ActivationTaskResult = {
      activationId: "a1", regionId: "r1", capability: "inspect", basisRevision: 0, startedAt: 0, finishedAt: 1,
      usage: { turns: 1, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, outcome: "error", error: "invalid output", networkDelta: null,
    };
    const application = applyBatchRecords(network, [failed]);
    expect(application.failed).toEqual(["a1"]);
    expect(application.network.regions[0].contradiction).toBeUndefined();
    expect(application.network.regions[0].status).not.toBe("contradiction");
  });

  it("does not retain a conflict lock when confirmed evidence kills one binder in the same propagation", () => {
    const network = initialNetwork("task");
    network.variables.push({ id: "v1", name: "runtime", ownerRegionId: "r1", seedLabels: ["node", "bun"] });
    network.evidence.push({ id: "e1", text: "Bun is unavailable", source: "tool", kind: "tool", fingerprint: "bun-unavailable" });
    network.candidates.push(
      { id: "r1:node", regionId: "r1", key: "node", proposition: "Use Node", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "node" }] },
      { id: "r1:bun", regionId: "r1", key: "bun", proposition: "Use Bun", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "bun" }] },
    );
    network.constraints.push({ id: "c1", kind: "refutes", subject: "e1", target: "r1:bun", reason: "runtime unavailable", sourceActivationId: "a1", sourceKind: "repo-evidence", evidenceRefs: ["e1"] });
    network.regions[0].candidateIds = ["r1:node", "r1:bun"];
    network.regions[0].selectedCandidateIds = ["r1:node", "r1:bun"];
    const accepted = acceptDomain(propagateNetwork(network));
    for (const candidate of accepted.candidates) if (candidate.regionId === "r1") { candidate.status = "selected"; candidate.declaredStatus = "selected"; }
    accepted.regions[0].selectedCandidateIds = ["r1:node", "r1:bun"];
    const propagated = propagateNetwork(accepted);
    expect(propagated.candidates.find((item) => item.id === "r1:bun")?.status).toBe("eliminated");
    expect(propagated.regions[0].contradiction).toBeUndefined();
    expect(propagated.regions[0].selectedCandidateIds).toEqual(["r1:node"]);
  });

  it("marks a record superseded when its region disappeared from the current solution", () => {
    const network = mergeSolutionDelta(state(), "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "only", proposition: "Only path", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["only"],
    });
    network.activations[0].status = "completed";
    network.activations.push({ id: "a9", capability: "refine", regionId: "r1", request: "split", expectedDelta: "refine:r1", contextRefs: ["r1"], status: "running", basisRevision: network.revision });
    const split = mergeRefinementOutput(network, "a9", { evidence: [], activations: [], children: [{ key: "child", objective: "Child work", edge: "partOf", allowedVariables: [], acceptanceCriteria: [], coveredCriteria: [0] }] });
    const child = split.regions.find((item) => item.key === "child")!;
    split.activations.push({ id: "a2", capability: "inspect", regionId: child.id, request: "a2", expectedDelta: "a2", contextRefs: [child.id], status: "running", basisRevision: split.revision });
    const reopened = reopenRegion(split, split.regions[0].id, "contradiction");
    const record: ActivationTaskResult = {
      activationId: "a2", regionId: child.id, capability: "inspect", basisRevision: 1, startedAt: 0, finishedAt: 0,
      usage: { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "applied", networkDelta: { kind: "delta", delta: { evidence: [{ text: "late", source: "late", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [] } },
    };
    const application = applyBatchRecords(reopened, [record]);
    expect(application.superseded).toEqual(["a2"]);
    expect(application.applied).toEqual([]);
    expect(application.network.activations.find((item) => item.id === "a2")?.status).toBe("superseded");
    expect(application.network.evidence.some((item) => item.text === "late")).toBe(false);
  });

  it("frees an activation signature for requeueing after supersede or failure", () => {
    const current = state();
    const network = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "left", proposition: "Left", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["left"],
    });
    network.activations[0].status = "completed";
    network.activations.push({ id: "a9", capability: "synthesize", regionId: "r1", request: "again", expectedDelta: "novel:r1", contextRefs: ["r1"], status: "superseded", basisRevision: 0 });
    expect(ensureRunnableWork(network).done).toBe(false);
  });

  it("retains the workspace mutation of a failed implement record and blocks its region", () => {
    const network = mergeSolutionDelta(state(), "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], activations: [],
      candidates: [{ key: "direct", proposition: "Direct", outcome: "selected", reasons: [], evidenceRefs: [] }], constraints: [], select: ["direct"],
    });
    network.activations.push({ id: "a2", capability: "implement", regionId: "r1", request: "a2", expectedDelta: "a2", contextRefs: ["r1"], status: "running", basisRevision: network.revision });
    network.regions[0].status = "implementing";
    const record: ActivationTaskResult = {
      activationId: "a2", regionId: "r1", capability: "implement", basisRevision: network.revision, startedAt: 0, finishedAt: 0,
      usage: { turns: 1, input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      outcome: "error", error: "invalid structured output", changedFiles: ["target.txt"], networkDelta: null,
    };
    const application = applyBatchRecords(network, [record]);
    expect(application.failed).toEqual(["a2"]);
    expect(application.network.activations.find((item) => item.id === "a2")?.status).toBe("failed");
    expect(application.network.artifacts.some((item) => item.kind === "file" && item.path === "target.txt")).toBe(true);
  });

  const actionableSingleChoice = () => {
    const network = initialNetwork("change");
    network.activations[0].status = "completed";
    const region = network.regions[0];
    region.status = "actionable"; region.candidateIds = ["r1:direct"]; region.selectedCandidateIds = ["r1:direct"]; region.acceptanceCriteria = ["works"];
    network.candidates.push({ id: "r1:direct", regionId: "r1", key: "direct", proposition: "implement it", status: "selected", evidenceIds: [], eliminationReasons: [] });
    return network;
  };
  const blockedImplementCycle = (network: SolutionLodState["network"], changedFiles: string[] = [], checks: ImplementationOutput["checks"] = []): SolutionLodState["network"] => {
    const id = `a${network.activations.length + 1}`;
    network.activations.push({ id, capability: "implement", regionId: "r1", request: "implement", expectedDelta: `implement:r1:${network.revision}`, contextRefs: ["r1"], status: "running", basisRevision: network.revision });
    network.regions[0].activationIds.push(id);
    network.regions[0].status = "implementing";
    return completeImplementation(network, id, { status: "blocked", summary: "missing prerequisite", changedFiles: [], checks, blocker: "missing prerequisite", activations: [] }, changedFiles);
  };

  it("stalls a region after three contentless reopens despite fresh artifact ids each cycle", () => {
    const sameChecks: ImplementationOutput["checks"] = [{ name: "lint", passed: false, evidence: "same failure" }];
    let current = actionableSingleChoice();
    for (let cycle = 0; cycle < 3; cycle++) current = blockedImplementCycle(current, [], sameChecks);
    expect(current.regions[0]).toMatchObject({ status: "superposed", reopens: 3 });
    expect(current.artifacts).toHaveLength(3);
    const stalled = blockedImplementCycle(current, [], sameChecks);
    expect(stalled.regions[0]).toMatchObject({ status: "stalled", reopens: 3 });
    expect(stalled.regions[0].contradiction).toBe("Region r1 stalled: 3 reopens without new evidence");
    const scheduled = ensureRunnableWork(stalled);
    expect(scheduled.done).toBe(false);
    expect(scheduled.blocked).toBe("Region r1 stalled: 3 reopens without new evidence");
    expect(nextQueuedActivation(scheduled.network)).toBeUndefined();
  });

  it("resets the reopen counter only on genuinely new evidence or artifact content", () => {
    let current = actionableSingleChoice();
    for (let cycle = 0; cycle < 3; cycle++) current = blockedImplementCycle(current);
    expect(current.regions[0].reopens).toBe(3);
    current = blockedImplementCycle(current, ["target.txt"]);
    expect(current.regions[0]).toMatchObject({ status: "superposed", reopens: 1 });
    current = blockedImplementCycle(current, ["target.txt"]);
    expect(current.regions[0].reopens).toBe(2);
    current.evidence.push({ id: "e1", text: "fresh repository fact", source: "src/new.ts", kind: "repository", fingerprint: "fresh1" });
    current.regions[0].evidenceIds.push("e1");
    current = blockedImplementCycle(current, ["target.txt"]);
    expect(current.regions[0]).toMatchObject({ status: "superposed", reopens: 1 });
  });

  it("declares a shared choice once and resolves candidate stances against it", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], constraints: [], select: [], activations: [],
      variables: [{ name: "HTTP Client", seedLabels: ["undici"] }],
      candidates: [{ key: "reuse", proposition: "Reuse undici", outcome: "selected", reasons: [], evidenceRefs: [], stances: [{ variable: "http-client", relation: "requires", valueLabel: "undici" }] }],
      select: ["reuse"],
    });
    expect(merged.variables.map((item) => item.name)).toEqual(["http-client"]);
    expect(merged.candidates[0].stances).toEqual([{ variableId: merged.variables[0].id, relation: "requires", valueLabel: "undici" }]);
  });

  it("keeps shared-choice spellings canonical and names unique", () => {
    const current = state();
    current.network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], select: [], activations: [],
      variables: [{ name: "http-client", seedLabels: ["undici"] }],
      candidates: [{ key: "a", proposition: "A", outcome: "possible", reasons: [], evidenceRefs: [] }],
    });
    expect(() => validateSolutionDelta(current, "r1", {
      region: {}, evidence: [], candidates: [{ key: "b", proposition: "B", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "http-client", relation: "prefers", valueLabel: "Undici" }] }], constraints: [], select: [], activations: [],
    })).toThrow(/Reuse the established option spelling/);
    expect(() => validateSolutionDelta(current, "r1", {
      region: {}, evidence: [], candidates: [{ key: "b", proposition: "B", outcome: "possible", reasons: [], evidenceRefs: [] }], constraints: [], select: [], activations: [],
      variables: [{ name: "http client" }],
    })).toThrow(/already exists/);
  });

  it("round-trips constraint provenance through merge", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: { acceptanceCriteria: ["works"] }, evidence: [], select: [], activations: [],
      candidates: [
        { key: "left", proposition: "L", outcome: "possible", reasons: [], evidenceRefs: [] },
        { key: "right", proposition: "R", outcome: "possible", reasons: [], evidenceRefs: [] },
      ],
      constraints: [{ kind: "excludes", subject: "left", target: "right", reason: "cannot coexist", sourceKind: "user-task", evidenceRefs: [] }],
    });
    expect(merged.constraints[0]).toMatchObject({ sourceKind: "user-task", kind: "excludes", subject: merged.candidates[0].id });
    expect(() => validateSolutionDelta(current, "r1", {
      region: {}, evidence: [], candidates: [{ key: "x", proposition: "X", outcome: "possible", reasons: [], evidenceRefs: [] }], constraints: [
        { kind: "excludes", subject: "task", target: "x", reason: "invalid direction", sourceKind: "repo-evidence", evidenceRefs: [] },
      ], select: [], activations: [],
    })).toThrow(/Invalid excludes endpoints/);
  });

  it("rejects stances on choices declared outside the region's subtree", () => {
    const current = state();
    current.network.regions.push({ ...current.network.regions[0], id: "r2", key: "left", parentId: "r1", edge: "partOf" as const, lod: 1, objective: "left", status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
    current.network.regions.push({ ...current.network.regions[0], id: "r3", key: "right", parentId: "r1", edge: "partOf" as const, lod: 1, objective: "right", status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
    current.network.variables.push({ id: "v9", name: "left-only", ownerRegionId: "r2" });
    current.network.activations.push({ id: "a9", capability: "synthesize", regionId: "r3", request: "choose", expectedDelta: "s-r3", contextRefs: ["r3"], status: "running", basisRevision: 0 });
    expect(() => mergeSolutionDelta(current, "a9", {
      region: {}, evidence: [], constraints: [], select: [], activations: [], variables: [],
      candidates: [{ key: "move", proposition: "Move", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "left-only", relation: "requires", valueLabel: "x" }] }],
    })).toThrow(/declared at r2 and is not visible here/);
  });

  it("keeps duplicate primal couplings legal and rejects only true transitive cycles", () => {
    const current = state();
    for (const [id, delta] of [["a2", "s-r1-again"], ["a3", "s-r1-third"], ["a4", "s-r1-fourth"]] as const) {
      current.network.activations.push({ id, capability: "synthesize", regionId: "r1", request: "more", expectedDelta: delta, contextRefs: ["r1"], status: "running", basisRevision: 0 });
    }
    current.network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], select: [], activations: [],
      variables: [{ name: "http-client" }, { name: "auth-db" }, { name: "cache-layer" }],
      candidates: [{ key: "first", proposition: "First move", outcome: "possible", reasons: [], evidenceRefs: [], stances: [
        { variable: "http-client", relation: "requires", valueLabel: "undici" },
        { variable: "auth-db", relation: "requires", valueLabel: "sqlite" },
      ] }],
    });
    // A second move coupling the SAME variable pair is a parallel edge, not a cycle.
    expect(() => {
      current.network = mergeSolutionDelta(current, "a2", {
        region: {}, evidence: [], constraints: [], select: [], activations: [], variables: [],
        candidates: [{ key: "parallel", proposition: "Parallel move", outcome: "possible", reasons: [], evidenceRefs: [], stances: [
          { variable: "http-client", relation: "prefers", valueLabel: "undici" },
          { variable: "auth-db", relation: "excludes", valueLabel: "postgres" },
        ] }],
      });
    }).not.toThrow();
    // Extend the chain: auth-db <-> cache-layer.
    expect(() => {
      current.network = mergeSolutionDelta(current, "a3", {
        region: {}, evidence: [], constraints: [], select: [], activations: [], variables: [],
        candidates: [{ key: "chain", proposition: "Chain move", outcome: "possible", reasons: [], evidenceRefs: [], stances: [
          { variable: "auth-db", relation: "prefers", valueLabel: "sqlite" },
          { variable: "cache-layer", relation: "requires", valueLabel: "redis" },
        ] }],
      });
    }).not.toThrow();
    // Coupling the outer vertices of the chain closes a real cycle.
    expect(() => mergeSolutionDelta(current, "a4", {
      region: {}, evidence: [], constraints: [], select: [], activations: [], variables: [],
      candidates: [{ key: "closer", proposition: "Cycle closer", outcome: "possible", reasons: [], evidenceRefs: [], stances: [
        { variable: "http-client", relation: "requires", valueLabel: "undici" },
        { variable: "cache-layer", relation: "prefers", valueLabel: "redis" },
      ] }],
    })).toThrow(/close a coupling cycle/);
  });

  it("prunes requiring moves everywhere once a committed move excludes an option", () => {
    const current = state();
    current.network.regions.push({ ...current.network.regions[0], id: "r2", key: "child", parentId: "r1", edge: "refines" as const, lod: 1, objective: "child", status: "unformed" as const, candidateIds: ["r2:move"], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
    current.network.variables.push({ id: "v1", name: "http-client", ownerRegionId: "r1", seedLabels: [] });
    current.network.evidence.push({ id: "e5", text: "the platform forbids extra clients", source: "docs/adr/0007.md:1", kind: "repository", fingerprint: "f5" });
    current.network.candidates.push(
      { id: "r2:move", regionId: "r2", key: "move", proposition: "Move needing undici", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "undici" }] },
      { id: "r1:committer", regionId: "r1", key: "committer", proposition: "Commit that rules undici out", status: "selected", declaredStatus: "selected", evidenceIds: [], eliminationReasons: [], stances: [] },
    );
    current.network.regions[0].candidateIds = ["r1:committer"];
    current.network.constraints.push({ id: "c7", kind: "excludes", subject: "r1:committer", target: "v1:undici", reason: "this approach forbids adding any client", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: ["e5"] });
    const accepted = acceptDomain(propagateNetwork(current.network));
    const committer = accepted.candidates.find((candidate) => candidate.id === "r1:committer")!;
    committer.status = "selected"; committer.declaredStatus = "selected"; accepted.regions[0].selectedCandidateIds = [committer.id];
    const propagated = propagateNetwork(accepted);
    expect(propagated.candidates.find((candidate) => candidate.id === "r2:move")?.status).toBe("eliminated");
    expect(propagated.candidates.find((candidate) => candidate.id === "r2:move")?.eliminationReasons.join(" ")).toMatch(/rules out shared choice http-client="undici"/);
  });

  it("keeps coordinate excludes inert while their subject is uncommitted and rejects uncited ones", () => {
    const build = () => {
      const fresh = state();
      fresh.network.regions.push({ ...fresh.network.regions[0], id: "r2", key: "child", parentId: "r1", edge: "refines" as const, lod: 1, objective: "child", status: "unformed" as const, candidateIds: ["r2:move"], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
      fresh.network.variables.push({ id: "v1", name: "http-client", ownerRegionId: "r1", seedLabels: [] });
      fresh.network.candidates.push(
        { id: "r2:move", regionId: "r2", key: "move", proposition: "Move needing undici", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "undici" }] },
        { id: "r1:idle", regionId: "r1", key: "idle", proposition: "Uncommitted excluder", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [] },
      );
      return fresh;
    };
    const inactive = build();
    inactive.network.constraints.push({ id: "cx", kind: "excludes", subject: "r1:idle", target: "v1:undici", reason: "idle grudge", sourceActivationId: "a9", sourceKind: "model-inference", evidenceRefs: ["e9"] });
    inactive.network.evidence.push({ id: "e9", text: "cited anyway", source: "x:1", kind: "repository", fingerprint: "e9" });
    // Singleton region force-selects the move; inertness means it is not eliminated.
    expect(propagateNetwork(inactive.network).candidates.find((candidate) => candidate.id === "r2:move")?.status).not.toBe("eliminated");
    expect(() => validateSolutionDelta(build(), "r1", {
      region: {}, evidence: [], candidates: [{ key: "idle2", proposition: "Idle", outcome: "possible", reasons: [], evidenceRefs: [] }], constraints: [
        { kind: "excludes", subject: "idle2", target: "http-client:undici", reason: "uncited exclusion", sourceKind: "model-inference", evidenceRefs: [] },
      ], select: [], activations: [],
    })).toThrow(/at least one cited fact/);
  });

  it("binds a committed choice and prunes conflicting moves elsewhere while prefers survives", () => {
    const current = state();
    current.network.regions.push({ ...current.network.regions[0], id: "r2", key: "child", parentId: "r1", edge: "refines" as const, lod: 1, objective: "child", status: "unformed" as const, candidateIds: [], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
    let network = mergeSolutionDelta(current, "a1", {
      region: {}, evidence: [], constraints: [], select: [], activations: [],
      variables: [{ name: "http-client" }],
      candidates: [{ key: "reuse", proposition: "Reuse undici", outcome: "possible", reasons: [], evidenceRefs: [], stances: [{ variable: "http-client", relation: "requires", valueLabel: "undici" }] }, { key: "other", proposition: "Use another client", outcome: "possible", reasons: [], evidenceRefs: [] }],
      select: [],
    });
    network = selectDelta(network, "a1", "reuse");
    network.candidates.push(
      { id: "r2:excl", regionId: "r2", key: "excl", proposition: "Excluding move", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: network.variables[0].id, relation: "excludes", valueLabel: "undici" }] },
      { id: "r2:reqother", regionId: "r2", key: "reqother", proposition: "Requires another option", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: network.variables[0].id, relation: "requires", valueLabel: "node-fetch" }] },
      { id: "r2:flexible", regionId: "r2", key: "flexible", proposition: "Any client works", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: network.variables[0].id, relation: "prefers", valueLabel: "undici" }] },
    );
    const propagated = propagateNetwork(network);
    expect(propagated.candidates.find((candidate) => candidate.id === "r2:excl")?.status).toBe("eliminated");
    expect(propagated.candidates.find((candidate) => candidate.id === "r2:reqother")?.status).toBe("eliminated");
    expect(propagated.candidates.find((candidate) => candidate.id === "r2:flexible")?.status).toBe("possible");
    expect(propagated.candidates.find((candidate) => candidate.key === "reuse")?.status).toBe("selected");
  });

  it("prunes requiring moves across regions only when a coordinate refutation cites facts", () => {
    const build = () => {
      const current = state();
      current.network.regions.push({ ...current.network.regions[0], id: "r2", key: "child", parentId: "r1", edge: "refines" as const, lod: 1, objective: "child", status: "unformed" as const, candidateIds: ["r2:move"], selectedCandidateIds: [], activationIds: [], artifactIds: [] });
      current.network.variables.push({ id: "v1", name: "http-client", ownerRegionId: "r1" });
      current.network.evidence.push({ id: "e9", text: "the repo standardizes on undici everywhere", source: "src/http.ts:1", kind: "repository", fingerprint: "f9" });
      current.network.candidates.push({ id: "r2:move", regionId: "r2", key: "move", proposition: "Move needing undici", status: "possible", evidenceIds: [], eliminationReasons: [], stances: [{ variableId: "v1", relation: "requires", valueLabel: "undici" }] });
      return current;
    };
    const cited = build();
    cited.network.constraints.push({ id: "c9", kind: "refutes", subject: "e9", target: "v1:undici", reason: "repo forbids additional clients here", sourceActivationId: "a9", sourceKind: "repo-evidence", evidenceRefs: ["e9"] });
    const pruned = propagateNetwork(cited.network);
    expect(pruned.candidates.find((candidate) => candidate.id === "r2:move")?.status).toBe("eliminated");
    expect(pruned.candidates.find((candidate) => candidate.id === "r2:move")?.eliminationReasons.join(" ")).toMatch(/refuted by cited evidence/);

    const uncited = build();
    uncited.network.constraints.push({ id: "c10", kind: "refutes", subject: "e9", target: "v1:undici", reason: "a hunch", sourceActivationId: "a9", sourceKind: "model-inference", evidenceRefs: [] });
    expect(propagateNetwork(uncited.network).candidates.find((candidate) => candidate.id === "r2:move")?.status).not.toBe("eliminated");

    expect(() => validateSolutionDelta(build(), "r1", {
      region: {}, evidence: [], candidates: [], constraints: [{ kind: "refutes", subject: "task", target: "http-client:undici", reason: "uncited", evidenceRefs: [] }], select: [], activations: [],
    })).toThrow(/at least one cited fact/);
    expect(() => validateSolutionDelta(build(), "r1", {
      region: {}, evidence: [], candidates: [], constraints: [{ kind: "refutes", subject: "task", target: "http-client:undici", reason: "phantom citation", evidenceRefs: ["ghost"] }], select: [], activations: [],
    })).toThrow(/unknown fact/);
  });

  it("prevents unresolved inference from pruning a shared option", () => {
    const current = state();
    current.network.variables.push({ id: "v1", name: "runtime", ownerRegionId: "r1", seedLabels: ["node20"] });
    current.network.evidence.push({ id: "e9", text: "Node 20 might be required", source: "model", kind: "inference", status: "hypothesis", validationKind: "repository-evidence", fingerprint: "h9" });
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      region: {}, evidence: [], variables: [], candidates: [{ key: "legacy", proposition: "Use Node 16", outcome: "possible", reasons: [], evidenceRefs: [] }],
      constraints: [{ kind: "refutes", subject: "task", target: "runtime:node20", reason: "hypothesis", sourceKind: "model-inference", evidenceRefs: ["e9"] }], select: [], activations: [],
    })).toThrow(/unresolved claim/);
  });

  it("does not let an inspector self-confirm inference metadata", () => {
    const current = state();
    const merged = mergeSolutionDelta(current, "a1", {
      region: {}, variables: [], candidates: [], constraints: [], select: [], activations: [],
      evidence: [{ text: "Maybe Node 20 only", source: "model", kind: "inference", status: "confirmed" }],
    } as never);
    expect(merged.evidence[0]).toMatchObject({ kind: "inference", status: "hypothesis" });
  });

  it("validates a hypothesis only through independent evidence and preserves the proof", () => {
    const current = state();
    current.network.evidence.push({ id: "e9", text: "Node 20 only", source: "model", kind: "inference", status: "hypothesis", validationKind: "repository-evidence", fingerprint: "h9" });
    const delta = {
      region: {}, variables: [], candidates: [], constraints: [], select: [], activations: [],
      evidence: [{ text: "engines requires Node 20", source: "package.json:8", kind: "repository" as const }],
      validations: [{ claimRef: "e9", verdict: "confirmed" as const, evidenceRefs: ["package.json:8"], reason: "package engines field" }],
    };
    expect(() => validateSolutionDelta(current, "r1", "inspect", delta)).not.toThrow();
    const merged = mergeSolutionDelta(current, "a1", delta);
    const proofId = merged.evidence.find((item) => item.source === "package.json:8")!.id;
    expect(merged.evidence.find((item) => item.id === "e9")).toMatchObject({ status: "confirmed", validationEvidenceRefs: [proofId], validationReason: "package engines field" });
  });

  it("rejects model-forged user authority", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      region: {}, evidence: [], variables: [], candidates: [{ key: "x", proposition: "X", outcome: "possible", reasons: [], evidenceRefs: [] }],
      constraints: [{ kind: "refutes", subject: "task", target: "x", reason: "user allegedly forbade it", sourceKind: "user-task", evidenceRefs: ["task"] }], select: [], activations: [],
    })).toThrow(/cannot assert user-task authority/);
  });

  it("prevents tool-free synthesis and refinement from fabricating confirmed observations", () => {
    const current = state();
    expect(() => validateSolutionDelta(current, "r1", "synthesize", {
      region: {}, variables: [], evidence: [{ text: "alleged file fact", source: "src/x.ts:1", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [],
    })).toThrow(/tool-free role cannot create confirmed/);
    expect(() => validateRefinementOutput(current, "r1", {
      evidence: [{ text: "alleged tool result", source: "command", kind: "tool" }], activations: [],
      children: [{ key: "child", objective: "Do work", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["works"], coveredCriteria: [0] }],
    })).toThrow(/Refinement is tool-free/);
  });
});

describe("solution LOD graph", () => {
  const synthesisOutput = (input: { node: string; state?: SolutionLodState }, key = "direct", proposition = "Update target") => {
    const regionId = input.node.split(":").at(-1)!;
    const region = input.state?.network.regions.find((item) => item.id === regionId);
    if (input.node.startsWith("generate-domain:")) return { text: "", structured: { operation: "generate-domain", evidence: [], variables: [], constraints: [], candidates: [{ key, proposition, evidenceRefs: [], stances: [] }, { key: `${key}-alternative`, proposition: `${proposition} with an adapter`, evidenceRefs: [], stances: [] }] } };
    if (input.node.startsWith("challenge-domain:")) return { text: "", structured: { operation: "challenge-domain", verdict: "accept", domainFingerprint: region?.domainFingerprint, viableCandidateIds: region?.candidateIds ?? [] } };
    if (input.node.startsWith("select-candidate:")) return { text: "", structured: { operation: "select-candidate", domainFingerprint: region?.domainFingerprint, basis: "lexicographic", selectedCandidateId: `${regionId}:${key}`, hardConstraints: [], comparisons: (region?.candidateIds ?? []).map((candidateId) => ({ candidateId, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: candidateId === `${regionId}:${key}` ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) } };
    return undefined;
  };
  const certifiedLeaf = { text: "", structured: { evidence: [], children: [], certifiedLeaf: { implementationScope: "bounded test change", criterionIds: ["criterion:scope:r1:0"], evidenceRefs: [], mutationResources: ["target.txt"], checks: [{ criterionId: "criterion:scope:r1:0", commandOrObservation: "run focused test" }] }, activations: [] } };

  it("executes a collapsed region and verifies it without a fixed role pipeline", async () => {
    const directory = temp("solution-lod-graph-");
    fs.writeFileSync(path.join(directory, "target.txt"), "before");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const calls: string[] = [];
    const retryCounts = new Map<string, number | undefined>();
    const runtime = { call: async (input: { node: string; retryCount?: number; state?: SolutionLodState }) => {
      calls.push(input.node);
      retryCounts.set(input.node, input.retryCount);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", allowedVariables: ["solution family"], acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: ["e1"] }] } };
      const synthesis = synthesisOutput(input); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return certifiedLeaf;
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: ["target.txt"], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], completionEvidence: { implementation: "measured target.txt", directTest: "target check passed", correctnessReview: "reviewed target", releaseGate: "suite passed", changedFiles: ["target.txt"], focusedTests: ["target"], fullChecks: ["suite"] }, activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "update", directory, worktree: directory, runId: "run" }), { recursionLimit: 64, configurable: { thread_id: "run", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} } });
    expect(calls).toEqual(["inspect:r1", "generate-domain:r1", "challenge-domain:r1", "select-candidate:r1", "refine:r1", "implement:r1", "verify:r1"]);
    expect(retryCounts.get("generate-domain:r1")).toBe(2);
    expect(retryCounts.get("challenge-domain:r1")).toBe(2);
    expect(retryCounts.get("select-candidate:r1")).toBe(2);
    expect(retryCounts.get("inspect:r1")).toBeUndefined();
    expect(configured.progress?.(result)).toMatchObject({ phase: "completed", semantic: { kind: "solution-lod-v2" } });
    expect(configured.result?.(result)).toContain("Implemented and verified");
    expect(configured.result?.(result)).not.toContain("stale pre-implementation design");
  });

  it("stalls a region terminally after three contentless blocked-implement reopens", async () => {
    const directory = temp("solution-lod-stalled-");
    fs.writeFileSync(path.join(directory, "target.txt"), "base");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const calls: string[] = [];
    const runtime = { call: async (input: { node: string; state?: SolutionLodState }) => {
      calls.push(input.node);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] } };
      const synthesis = synthesisOutput(input); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return certifiedLeaf;
      if (input.node === "implement:r1") return { text: "", structured: { status: "blocked", summary: "missing prerequisite", changedFiles: [], checks: [], blocker: "missing prerequisite", activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "update", directory, worktree: directory, runId: "stalled" }), { recursionLimit: 128, configurable: { thread_id: "stalled", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} } });
    expect(calls.filter((node) => node === "implement:r1")).toHaveLength(4);
    const region = (result as SolutionLodState).network.regions.find((item) => item.id === "r1")!;
    expect(region.status).toBe("stalled");
    expect(region.reopens).toBe(3);
    expect(configured.progress?.(result)?.phase).toBe("blocked");
    expect(configured.result?.(result)).toContain("Region r1 stalled: 3 reopens without new evidence");
  });

  it("isolates malformed activation output and terminates with retained state", async () => {
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async () => { throw new Error("invalid structured output"); } };
    const result = await configured.graph.invoke(configured.initial({ task: "x", directory: "/repo", worktree: "/repo", runId: "bad" }), { recursionLimit: 32, configurable: { thread_id: "bad", langgraphOpenCodeRuntime: runtime } });
    expect(configured.progress?.(result)?.phase).toBe("blocked");
    expect((result as SolutionLodState).network.activations.some((activation) => activation.status === "failed")).toBe(true);
    expect(configured.result?.(result)).toContain("blocked");
  });

  it("reconciles actual files changed during implementation without claiming pre-existing dirt", async () => {
    const directory = temp("solution-lod-artifacts-");
    fs.writeFileSync(path.join(directory, "target.txt"), "base"); fs.writeFileSync(path.join(directory, "untouched.txt"), "base");
    fs.writeFileSync(path.join(directory, "untouched.txt"), "user dirt");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const runtime = { call: async (input: { node: string; state?: SolutionLodState }) => {
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["files updated"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] } };
      const synthesis = synthesisOutput(input, "direct", "change files"); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return certifiedLeaf;
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "agent change"); fs.writeFileSync(path.join(directory, "new.txt"), "new"); return { text: "", structured: { status: "completed", summary: "done", changedFiles: [], checks: [{ name: "files updated", passed: true, evidence: "files updated: target.txt and new.txt" }], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "files updated", passed: true, evidence: "files updated: target.txt and new.txt" }], completionEvidence: { implementationOutcome: "changed", implementation: "measured target.txt and new.txt", directTest: "files updated check passed", correctnessReview: "reviewed files", releaseGate: "suite passed", changedFiles: ["new.txt", "target.txt"], focusedTests: ["files updated"], fullChecks: ["suite"], criterionIds: ["criterion:scope:r1:0"], inspectionEvidenceRefs: [] }, activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["untouched.txt", "M:user"], ["target.txt", "clean:base"]]) : new Map([["untouched.txt", "M:user"], ["target.txt", "M:agent"], ["new.txt", "?:new"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "change", directory, worktree: directory, runId: "artifacts" }), { recursionLimit: 32, configurable: { thread_id: "artifacts", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {}, langgraphSnapshotWorkspace: snapshot } });
    const files = (result as SolutionLodState).network.artifacts.filter((item) => item.kind === "file").map((item) => item.path).sort();
    expect(files).toEqual(["new.txt", "target.txt"]);
    expect(files).not.toContain("untouched.txt");
  });

  it("retains a workspace mutation when the implementer's final output is malformed", async () => {
    const directory = temp("solution-lod-malformed-mutation-");
    fs.writeFileSync(path.join(directory, "target.txt"), "base");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    let first = true;
    const runtime = { call: async (input: { node: string; state?: SolutionLodState }) => {
      if (first && input.node === "inspect:r1") { first = false; return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] } }; }
      const synthesis = synthesisOutput(input, "direct", "update target"); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return certifiedLeaf;
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "retained"); throw new Error("invalid structured output"); }
      throw new Error("recovery activation also malformed");
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["target.txt", "clean:base"]]) : new Map([["target.txt", "M:retained"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "change", directory, worktree: directory, runId: "malformed-mutation" }), { recursionLimit: 32, configurable: { thread_id: "malformed-mutation", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {}, langgraphSnapshotWorkspace: snapshot } });
    expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("retained");
    expect((result as SolutionLodState).network.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", path: "target.txt" })]));
    expect(configured.progress?.(result)?.phase).toBe("blocked");
  });

  it("fans a read-only batch out in parallel, merges deterministically, and clears the results log", async () => {
    const directory = temp("solution-lod-parallel-");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const events: string[] = [];
    let open = 0; let maxOpen = 0;
    const runtime = { call: async (input: { node: string; state?: SolutionLodState }) => {
      events.push(`start:${input.node}`); open++; maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 25));
      open--; events.push(`end:${input.node}`);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { acceptanceCriteria: ["left answered", "right answered"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] } };
      const synthesis = synthesisOutput(input, input.node.endsWith(":r1") ? "split" : "direct", input.node.endsWith(":r1") ? "Two independent answers" : "Answer directly"); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return { text: "", structured: { evidence: [], activations: [], children: [
        { key: "left", objective: "Answer the left question", edge: "partOf", delivery: "answer", allowedVariables: [], acceptanceCriteria: ["left answered"], coveredCriteria: [0] },
        { key: "right", objective: "Answer the right question", edge: "partOf", delivery: "answer", allowedVariables: [], acceptanceCriteria: ["right answered"], coveredCriteria: [1] },
      ] } };
      if (input.node === "inspect:r2") return { text: "", structured: { region: {}, evidence: [{ text: "left context", source: "left:1", kind: "inference" }], candidates: [], constraints: [], select: [], activations: [] } };
      if (input.node === "inspect:r3") return { text: "", structured: { region: {}, evidence: [{ text: "right context", source: "right:1", kind: "inference" }], candidates: [], constraints: [], select: [], activations: [] } };
      if (input.node === "refine:r2" || input.node === "refine:r3") {
        const region = input.state!.network.regions.find((item) => item.id === input.node.slice("refine:".length))!;
        return { text: "", structured: { evidence: [], children: [], certifiedLeaf: { implementationScope: "bounded answer", criterionIds: [...region.criterionIds], evidenceRefs: [], mutationResources: [region.key], checks: region.criterionIds.map((criterionId) => ({ criterionId, commandOrObservation: "check answer" })) }, activations: [] } };
      }
      if (input.node === "present:r2") return { text: "", structured: { answer: "left answer" } };
      if (input.node === "present:r3") return { text: "", structured: { answer: "right answer" } };
      if (input.node === "verify:r2") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "left answered", passed: true, evidence: "left answered: left answer" }], activations: [] } };
      if (input.node === "verify:r3") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "right answered", passed: true, evidence: "right answered: right answer" }], activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    const result = await configured.graph.invoke(configured.initial({ task: "answer two questions", directory, worktree: directory, runId: "parallel" }), { recursionLimit: 128, configurable: { thread_id: "parallel", langgraphOpenCodeRuntime: runtime } });
    expect(maxOpen).toBe(2);
    expect(events.indexOf("start:generate-domain:r2")).toBeGreaterThan(-1);
    expect(events.indexOf("start:generate-domain:r3")).toBeGreaterThan(-1);
    const final = result as SolutionLodState;
    expect(configured.progress?.(final)?.phase).toBe("completed");
    expect(configured.result?.(final)).toBe("left answer\n\nright answer");
    expect(final.results).toEqual([]);
    expect(final.activeBatch).toEqual([]);
    expect(final.network.activations.filter((item) => !["completed", "superseded"].includes(item.status)).map((item) => item.status)).toEqual([]);
  });

  it("routes the implement singleton through acquire before dispatching its activation task", async () => {
    const directory = temp("solution-lod-acquire-");
    fs.writeFileSync(path.join(directory, "target.txt"), "before");
    const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new MemorySaver() });
    const order: string[] = [];
    const runtime = { call: async (input: { node: string }) => {
      order.push(`node:${input.node}`);
      if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [], candidates: [], constraints: [], select: [], activations: [] } };
      const synthesis = synthesisOutput(input); if (synthesis) return synthesis;
      if (input.node === "refine:r1") return certifiedLeaf;
      if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], activations: [] } }; }
      if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], completionEvidence: { implementation: "measured target.txt", directTest: "target check passed", correctnessReview: "reviewed target", releaseGate: "suite passed", changedFiles: ["target.txt"], focusedTests: ["target"], fullChecks: ["suite"] }, activations: [] } };
      throw new Error(`unexpected node ${input.node}`);
    } };
    let snapshots = 0;
    const snapshot = () => snapshots++ === 0 ? new Map([["target.txt", "clean:before"]]) : new Map([["target.txt", "M:after"]]);
    const result = await configured.graph.invoke(configured.initial({ task: "update", directory, worktree: directory, runId: "acquire" }), { recursionLimit: 64, configurable: { thread_id: "acquire", langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => { order.push("acquire"); }, langgraphSnapshotWorkspace: snapshot } });
    expect(order.filter((item) => item === "acquire")).toHaveLength(1);
    expect(order.indexOf("acquire")).toBeLessThan(order.indexOf("node:implement:r1"));
    expect(configured.progress?.(result)?.phase).toBe("completed");
    expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("after");
    const final = result as SolutionLodState;
    expect(final.results).toEqual([]);
    expect(final.network.artifacts.some((item) => item.kind === "file" && item.path === "target.txt")).toBe(true);
  });
});

describe("activation IO schema views", () => {
  const spans = (lines: NonNullable<ReturnType<typeof renderSchemaOutput>>, match: string) => lines.find((line) => line.spans.some((span) => span.text.includes(match)))!;

  it("renders a synthesis delta with outcome badges, constraint kinds, and selection", () => {
    const lines = renderSchemaOutput({
      region: { objective: "Add exports", acceptanceCriteria: ["exports exist"], allowedVariables: ["api shape"], delivery: "change" },
      evidence: [{ text: "core has 3 modules", source: "src/core/index.ts:1", kind: "repository" }],
      candidates: [
        { key: "barrel", proposition: "Barrel file", outcome: "selected", reasons: [], evidenceRefs: [] },
        { key: "inline", proposition: "Inline exports", outcome: "eliminated", reasons: ["duplicates imports"], evidenceRefs: [] },
      ],
      constraints: [
        { kind: "refutes", subject: "task", target: "inline", sourceKind: " repo-evidence ", evidenceRefs: [" e1 ", " ", 7, "e2"], reason: "conflicts with the public api" },
        { kind: "excludes", subject: "draft", target: "public", evidenceRefs: [" u1 "] },
        { kind: "requires", subject: "model", target: "evidence", sourceKind: "model-inference", evidenceRefs: ["", " "] },
        { kind: "supports", subject: "user", target: "task", sourceKind: "user-task" },
      ],
      select: ["barrel"],
      activations: [{ capability: "inspect", regionId: "r2", request: "check package exports", expectedDelta: "exports-fact", contextRefs: [] }],
    });
    expect(lines).toBeDefined();
    const flat = flattenSchemaLines(lines!);
    expect(flat).toContain("[SYNTHESIS DELTA]");
    expect(flat).toContain("GOAL Add exports");
    expect(flat).toContain("✓ exports exist");
    expect(flat).toContain("● core has 3 modules");
    expect(flat).toContain("◆ [CHOSEN] Barrel file");
    expect(flat).toContain("× [REJECTED] Inline exports");
    expect(flat).toContain("↳ duplicates imports");
    expect(flat).toContain("[repo-evidence:e1,e2] [REFUTES] task → inline  · conflicts with the public api");
    expect(flat).toContain("[unknown:u1] [EXCLUDES] draft → public");
    expect(flat).toContain("[model-inference] [REQUIRES] model → evidence");
    expect(flat).toContain("[user-task] [SUPPORTS] user → task");
    expect(flat).toContain("SELECTION barrel");
    expect(flat).toContain("→ inspect r2");
    expect(spans(lines!, "[CHOSEN]").spans.some((span) => span.tone === "success")).toBe(true);
    expect(spans(lines!, "[REFUTES]").spans.some((span) => span.tone === "error")).toBe(true);
    expect(spans(lines!, "↳ duplicates").spans[0].tone).toBe("error");
    expect(lines!.flatMap((line) => line.spans).find((span) => span.text.includes("src/core/index.ts:1"))?.tone).toBe("muted");
  });

  it("renders forced refinements as next steps with per-child criteria and coverage", () => {
    const split = renderSchemaOutput({
      evidence: [], activations: [],
      children: [
        { key: "mapping", objective: "Resolve mapping", edge: "refines", allowedVariables: [], acceptanceCriteria: ["mapping is explicit"], coveredCriteria: [0] },
        { key: "docs", objective: "Update docs", edge: "partOf", allowedVariables: [], acceptanceCriteria: ["docs mention mapping"], coveredCriteria: [1] },
      ],
    })!;
    const flat = flattenSchemaLines(split);
    expect(flat).toContain("[REFINEMENT]");
    expect(flat).toContain("[2 NEXT STEPS]");
    expect(flat).toContain("⌇ [REFINES] Resolve mapping");
    expect(flat).toContain("· covers #0 · mapping");
    expect(flat).toContain("■ [PART OF] Update docs");
    expect(flat).toContain("✓ docs mention mapping");
  });

    it("renders implementation files and check outcomes plus blocked reasons", () => {
    const completed = renderSchemaOutput({ status: "completed", summary: "did the thing", changedFiles: ["src/a.ts"], checks: [{ name: "lint", passed: true, evidence: "clean" }, { name: "test", passed: false, evidence: "1 failing" }], activations: [] })!;
    const completedFlat = flattenSchemaLines(completed);
    expect(completedFlat).toContain("[IMPLEMENTATION]");
    expect(completedFlat).toContain("[COMPLETED]");
    expect(completedFlat).toContain("+ src/a.ts");
    expect(completedFlat).toContain("✓ lint");
    expect(completedFlat).toContain("— clean");
    expect(completedFlat).toContain("✗ test");
    expect(completedFlat).toContain("— 1 failing");
    expect(spans(completed, "✗ test").spans[0].tone).toBe("error");
    const blocked = renderSchemaOutput({ status: "blocked", changedFiles: [], blocker: "missing config key" })!;
    const blockedFlat = flattenSchemaLines(blocked);
    expect(blockedFlat).toContain("[BLOCKED]");
    expect(blockedFlat).toContain("BLOCKER missing config key");
    expect(blocked.flatMap((line) => line.spans).find((span) => span.text.includes("missing config key"))?.tone).toBe("error");
  });

  it("renders verification verdicts and criterion-mapped findings", () => {
    const reopened = renderSchemaOutput({ verdict: "reopen", summary: "earlier choice contradicted", findings: [{ criterion: "exports exist", regionId: "r2", problem: "chosen barrel breaks cjs consumers", evidence: "grep dist" }], activations: [] })!;
    const flat = flattenSchemaLines(reopened);
    expect(flat).toContain("[VERIFICATION]");
    expect(flat).toContain("[REOPEN]");
    expect(flat).toContain("! exports exist  r2");
    expect(flat).toContain("chosen barrel breaks cjs consumers");
    expect(flat).toContain("— grep dist");
    expect(spans(reopened, "[REOPEN]").spans.some((span) => span.tone === "accent")).toBe(true);
    expect(spans(reopened, "! exports exist").spans[0].tone).toBe("warning");
  });

  it("renders presentation answers and falls back for unknown payloads", () => {
    const answer = renderSchemaOutput({ answer: "The answer is 4." })!;
    expect(flattenSchemaLines(answer)).toContain("The answer is 4.");
    expect(renderSchemaOutput({ unrelated: true })).toBeUndefined();
    expect(renderSchemaOutput("text only")).toBeUndefined();
  });

  it("recovers schema views from raw JSON text for runs recorded without structured payloads", () => {
    const fromPlain = renderSchemaText('{"verdict":"pass","summary":"ok","findings":[],"checks":[{"name":"t","passed":true,"evidence":"e"}],"activations":[]}');
    expect(flattenSchemaLines(fromPlain!)).toContain("[VERIFICATION]");
    expect(flattenSchemaLines(fromPlain!)).toContain("[PASS]");
    const fromFenced = renderSchemaText(' preamble\n```json\n{"status":"completed","summary":"done","changedFiles":["a.ts"],"checks":[],"activations":[]}\n```\n');
    expect(flattenSchemaLines(fromFenced!)).toContain("+ a.ts");
    expect(renderSchemaText("plain prose output")).toBeUndefined();
    expect(renderSchemaText(undefined)).toBeUndefined();
  });

  it("renders activation input projections by semantics and rejects unknown shapes", () => {
    const input = renderSchemaInput(JSON.stringify({
      userRequest: "Add named exports",
      yourAssignment: "Choose the export approach",
      goal: "Pick an export strategy",
      successCriteria: ["imports keep working"],
      chooseOnly: ["api shape"],
      mustNotChooseSolution: false,
      facts: [{ referenceId: "e1", fact: "core has 3 modules", source: "src/core:1" }],
      relationships: [{ relationship: "requires", from: "barrel", to: "core", explanation: "re-exports everything" }],
      earlierChoices: ["Use an adapter"],
      alternativesAlreadyConsidered: [{ approach: "Inline exports", status: "rejected", reasonsRejected: ["no single entry"] }],
      nextStepsContract: { split: "split into covering children", leafNote: "leaves are computed" },
    }))!;
    const flat = flattenSchemaLines(input);
    expect(flat).toContain("[ACTIVATION INPUT]");
    expect(flat).toContain("REQUEST Add named exports");
    expect(flat).toContain("ASSIGNMENT Choose the export approach");
    expect(flat).toContain("GOAL Pick an export strategy");
    expect(flat).toContain("✓ imports keep working");
    expect(flat).toContain("CHOOSE ONLY api shape");
    expect(flat).toContain("● core has 3 modules");
    expect(flat).toContain("[REQUIRES] barrel → core");
    expect(flat).toContain("· re-exports everything");
    expect(flat).toContain("CHOSEN SO FAR Use an adapter");
    expect(flat).toContain("× Inline exports");
    expect(flat).toContain("SPLIT split into covering children");
    expect(flat).toContain("LEAVES leaves are computed");
    expect(spans(input, "[REQUIRES]").spans.some((span) => span.tone === "info")).toBe(true);
    expect(renderSchemaInput("not json")).toBeUndefined();
    expect(renderSchemaInput(undefined)).toBeUndefined();
    expect(renderSchemaInput(JSON.stringify({ userRequest: "x" }))).toBeUndefined();
  });

  it("emits the validated structured payload on completed runtime events", async () => {
    const events: Array<{ node: string; status: string; structured?: unknown }> = [];
    const client = { session: {
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{ info: { role: "assistant", structured: { decision: "go" } }, parts: [] }] }),
      abort: async () => ({ data: true }),
    } };
    const definition = { version: 1 as const, models: { current: { backend: "opencode" as const, model: "inherit" } }, agents: { planner: { model: "current", systemPrompt: "decide", tools: { question: false } } }, graphs: {}, defaultGraph: "default" };
    const runtime = new OpenCodeAgentRuntime({ plugin: { client } as never, definition, parentSessionId: "root", parentModel: { providerID: "p", modelID: "m" }, directory: "/repo", worktree: "/repo", signal: new AbortController().signal, onEvent: (event) => events.push(event) });
    await expect(runtime.call({ agent: "planner", node: "decide", prompt: "go?", state: {}, schema: { type: "object" } })).resolves.toMatchObject({ structured: { decision: "go" } });
    expect(events.find((event) => event.status === "completed")?.structured).toEqual({ decision: "go" });
  });
});

describe("worktree queue", () => {
  it("runs verifier mutations in a disposable copy and removes it", async () => {
    const stateHome = temp("opencode-langgraph-verifier-state-");
    const project = temp("opencode-langgraph-verifier-project-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      fs.mkdirSync(path.join(project, ".git"));
      fs.writeFileSync(path.join(project, ".git", "config"), "private");
      fs.writeFileSync(path.join(project, "source.txt"), "original");
      const workspace = await prepareVerifierWorkspace("isolated-run", project);
      expect(fs.readFileSync(path.join(workspace, "source.txt"), "utf8")).toBe("original");
      expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
      fs.writeFileSync(path.join(workspace, "source.txt"), "verifier mutation");
      fs.writeFileSync(path.join(workspace, "generated.txt"), "test output");
      expect(fs.readFileSync(path.join(project, "source.txt"), "utf8")).toBe("original");
      expect(fs.existsSync(path.join(project, "generated.txt"))).toBe(false);
      await releaseVerifierWorkspace("isolated-run");
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });

  it("refuses to mirror filesystem root or the user home", async () => {
    await expect(prepareVerifierWorkspace("unsafe-root", path.parse(process.cwd()).root)).rejects.toThrow("unsafe verifier worktree");
    await expect(prepareVerifierWorkspace("unsafe-home", os.homedir())).rejects.toThrow("unsafe verifier worktree");
  });

  it("serializes leases in FIFO order", async () => {
    const stateHome = temp("opencode-langgraph-lock-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      const controller = new AbortController();
      const first = await acquireWorktree("/repo", controller.signal);
      let acquired = false;
      const secondPromise = acquireWorktree("/repo", controller.signal).then((lease) => { acquired = true; return lease; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(acquired).toBe(false);
      first.release();
      const second = await secondPromise;
      expect(acquired).toBe(true);
      second.release();
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });

  it("immediately recovers a lease whose owner process exited", async () => {
    const stateHome = temp("opencode-langgraph-dead-lock-");
    const prior = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      const id = createHash("sha256").update(path.resolve("/repo")).digest("hex");
      const root = path.join(stateHome, "opencode-langgraph", "locks", id);
      fs.mkdirSync(path.join(root, "queue"), { recursive: true });
      fs.writeFileSync(path.join(root, "owner"), JSON.stringify({ ticket: "dead", pid: 2_147_483_647 }));
      const controller = new AbortController();
      const started = Date.now();
      const lease = await acquireWorktree("/repo", controller.signal);
      expect(Date.now() - started).toBeLessThan(1_000);
      lease.release();
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME; else process.env.OPENCODE_LANGGRAPH_STATE_HOME = prior;
    }
  });
});

describe("host reconciliation", () => {
  it("writes stored runs atomically and rejects path-like run IDs", () => {
    const stateHome = temp("opencode-langgraph-run-files-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      const run = { runId: "safe-run", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: "/repo", worktree: "/repo", status: "queued" as const };
      writeStoredRun(run);
      expect(readStoredRun("safe-run")).toEqual(run);
      const directory = path.join(stateHome, "opencode-langgraph", "runs");
      expect(fs.readdirSync(directory)).toEqual(["safe-run.json"]);
      expect(() => writeStoredRun({ ...run, runId: "../escape" })).toThrow(/Invalid run ID/);
      expect(() => readStoredRun("../escape", stateHome)).toThrow(/Invalid run ID/);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("fails running, queued, and pausing runs whose host process exited and leaves live runs untouched", async () => {
    const stateHome = temp("opencode-langgraph-reconcile-");
    const project = temp("opencode-langgraph-reconcile-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"]);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      const base = { rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project };
      writeStoredRun({ ...base, runId: "dead-running", status: "running", hostPid: deadPid });
      writeStoredRun({ ...base, runId: "dead-queued", status: "queued", hostPid: deadPid });
      writeStoredRun({ ...base, runId: "dead-pausing", status: "pausing", hostPid: deadPid });
      writeStoredRun({ ...base, runId: "absent-host", status: "running" });
      writeStoredRun({ ...base, runId: "live-running", status: "running", hostPid: process.pid });
      writeStoredRun({ ...base, runId: "live-pausing", status: "pausing", hostPid: process.pid });
      writeStoredRun({ ...base, runId: "dead-completed", status: "completed", hostPid: deadPid });
      writeStoredRun({ ...base, runId: "dead-paused", status: "paused", hostPid: deadPid });
      reconcileRuns();
      expect(readStoredRun("dead-running").status).toBe("failed");
      expect(readStoredRun("dead-queued").status).toBe("failed");
      expect(readStoredRun("dead-pausing").status).toBe("failed");
      expect(readStoredRun("absent-host").status).toBe("failed");
      expect(readStoredRun("live-running")).toMatchObject({ status: "running", hostPid: process.pid });
      expect(readStoredRun("live-pausing")).toMatchObject({ status: "pausing", hostPid: process.pid });
      expect(readStoredRun("dead-completed").status).toBe("completed");
      expect(readStoredRun("dead-paused").status).toBe("paused");
      const events = readPluginEvents("root", stateHome).filter((event) => event.text === "Host process exited before the run finished");
      expect(events.map((event) => event.runId).sort()).toEqual(["absent-host", "dead-pausing", "dead-queued", "dead-running"]);
      for (const event of events) expect(event).toMatchObject({ node: "__end__", status: "failed", graph: "solution-lod" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("reconciles stale runs from a dead host when the server plugin starts", async () => {
    const stateHome = temp("opencode-langgraph-reconcile-server-");
    const project = temp("opencode-langgraph-reconcile-server-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      writeStoredRun({ runId: "stale", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project, status: "running", hostPid: 2_147_483_647 });
      writeStoredRun({ runId: "fresh", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project, status: "running", hostPid: process.pid });
      await server({ client: {}, directory: project, worktree: project } as never);
      expect(readStoredRun("stale").status).toBe("failed");
      expect(readStoredRun("fresh").status).toBe("running");
      expect(readPluginEvents("root", stateHome).at(-1)).toMatchObject({ runId: "stale", node: "__end__", status: "failed", text: "Host process exited before the run finished" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });
});

describe("durable checkpoints", () => {
  it("resumes an interrupt through a separately opened durable saver", async () => {
    const directory = temp("opencode-langgraph-checkpoints-");
    const State = Annotation.Root({ answer: Annotation<string> });
    const compile = (saver: DurableFileSaver) => new StateGraph(State)
      .addNode("ask", () => ({ answer: interrupt("question") as string }))
      .addEdge(START, "ask").addEdge("ask", END).compile({ checkpointer: saver });
    const firstSaver = new DurableFileSaver(directory);
    const first = await compile(firstSaver).invoke({ answer: "" }, { configurable: { thread_id: "durable" } });
    expect(isInterrupted(first)).toBe(true);
    const secondSaver = new DurableFileSaver(directory);
    const resumed = await compile(secondSaver).invoke(new Command({ resume: "yes" }), { configurable: { thread_id: "durable" } });
    expect(resumed.answer).toBe("yes");
  });
});

describe("OpenCode automatic graph routing", () => {
  it("passes a bounded semantic conversation frame without duplicating the current message", () => {
    const long = "x".repeat(2_000);
    const context = buildConversationContext([
      { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "Implement the requested fix" }] },
      { info: { id: "tool", role: "assistant" }, parts: [{ type: "reasoning", text: "private reasoning" }, { type: "tool", text: "tool output" }] },
      { info: { id: "old-assistant", role: "assistant" }, parts: [{ type: "text", text: long }, { type: "text", text: "hidden", synthetic: true }] },
      { info: { id: "current", role: "user" }, parts: [{ type: "text", text: "Fix that too" }] },
    ], "current", "Fix that too");
    expect(context).toContain("USER: Implement the requested fix");
    expect(context).toContain("ASSISTANT: ");
    expect(context).not.toContain("private reasoning");
    expect(context).not.toContain("tool output");
    expect(context).not.toContain("hidden");
    expect(context).not.toContain("Fix that too");
    expect(context.length).toBeLessThan(1_300);
  });

  it("drops an unpersisted current-message duplicate by content", () => {
    expect(buildConversationContext([
      { info: { id: "prior", role: "user" }, parts: [{ type: "text", text: "Earlier requirement" }] },
      { info: { id: "different-api-id", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
    ], "current", "Continue")).toBe("USER: Earlier requirement");
  });

  it("persists cross-process cancellation and emits a terminal event", async () => {
    const state = temp("opencode-langgraph-cancel-");
    const project = temp("opencode-langgraph-cancel-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(project, "file.txt"), "value");
      const verifierWorkspace = await prepareVerifierWorkspace("run", project);
      writeStoredRun({ checkpointVersion: 6, runId: "run", rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory: project, worktree: project, status: "interrupted" });
      const hooks = await server({ client: {}, directory: "/repo", worktree: "/repo" } as never);
      await hooks["command.execute.before"]?.({ command: "graph-cancel", sessionID: "root", arguments: "" }, { parts: [] } as never);
      expect(readStoredRun("run").status).toBe("cancelled");
      expect(fs.existsSync(verifierWorkspace)).toBe(false);
      expect(readPluginEvents("root", state).at(-1)).toMatchObject({ runId: "run", node: "__end__", status: "interrupted", text: "Cancelled by user" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("runs the graph from a root chat message and records visible events", async () => {
    const state = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    let child = 0;
    const posted: unknown[] = [];
    const parents = new Map<string, string | undefined>([["root", undefined]]);
    const titles = new Map<string, string>();
    const client = { session: {
      get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
      create: async ({ body }: { body: { parentID: string; title: string } }) => {
        const id = `child-${++child}`;
        parents.set(id, body.parentID);
        titles.set(id, body.title);
        return { data: { id } };
      },
      promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
      status: async () => ({ data: {} }),
      messages: async ({ path: requestPath }: { path: { id: string } }) => {
        if (requestPath.id === "root") return { data: ["message-1", "message-command"].map((parentID) => ({ info: { role: "assistant", parentID }, parts: [{ type: "text", text: "The answer is 4." }] })) };
        const title = titles.get(requestPath.id) ?? "";
        const structured = title.includes("inspect:r1")
          ? { region: { delivery: "answer", acceptanceCriteria: ["State the sum"] }, evidence: [{ text: "2+2 is 4", source: "arithmetic", kind: "inference" }], candidates: [], constraints: [], select: [], activations: [], resolvedAnswer: { answer: "The answer is 4.", acceptanceCriteria: ["State the sum"], evidenceRefs: ["task"] } }
          : title.includes("synthesize:r1") ? { evidence: [], candidates: [{ key: "answer", proposition: "Answer directly", outcome: "selected", reasons: [], evidenceRefs: ["e1"] }], constraints: [], select: ["answer"], activations: [] }
          : title.includes("present:r1") ? { answer: "The answer is 4." }
          : title.includes("verify:r1") ? { verdict: "pass", summary: "Answer matches the facts", findings: [], checks: [{ name: "State the sum", passed: true, evidence: "State the sum: 2+2 is 4" }], activations: [] } : undefined;
        return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: "The answer is 4." }] }] };
      },
      abort: async () => ({ data: true }),
    } };
    try {
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const config = {} as { command?: Record<string, unknown>; agent?: Record<string, { tools?: Record<string, boolean>; maxSteps?: number; permission?: Record<string, unknown> }> };
      await hooks.config?.(config as never);
      expect(Object.keys(config.command ?? {})).toEqual(["run-graph", "graph-resume", "graph-pause", "graph-cancel"]);
      expect(config.agent?.["langgraph-presenter"]).toMatchObject({ maxSteps: 8, tools: { read: false, bash: false, edit: false, task: false, skill: false } });
      expect(config.agent?.["langgraph-inspector"]).toMatchObject({ maxSteps: 32, tools: { read: true, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-synthesizer"]).toMatchObject({ maxSteps: 8, tools: { read: false, bash: false, skill: false }, permission: { bash: "deny", external_directory: "deny" } });
      expect(config.agent?.["langgraph-verifier"]).toMatchObject({ tools: { bash: true, edit: false, skill: false }, permission: { bash: "allow", edit: "deny", external_directory: "deny" } });
      expect(Object.keys(hooks.tool ?? {})).toEqual(["langgraph_start", "langgraph_inspect", "langgraph_prune", "langgraph_resume", "langgraph_cancel", "langgraph_pause"]);
      const output = {
        message: { id: "message-1", sessionID: "root", role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } },
        parts: [{ id: "part-1", messageID: "message-1", sessionID: "root", type: "text", text: "What is 2+2?" }],
      };
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-1" }, output as never);
      expect(output.parts).toHaveLength(1);
      await hooks["command.execute.before"]?.({ command: "run-graph", sessionID: "root", arguments: "What is 2+2?" }, { parts: output.parts } as never);
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-command", model: { providerID: "test", modelID: "model" } }, {
        ...output,
        message: { ...output.message, id: "message-command" },
        parts: [{ ...output.parts[0], id: "part-command", messageID: "message-command" }],
      } as never);
      let deadline = Date.now() + 2_000;
      while (readPluginEvents("root").at(-1)?.userMessageId !== "message-command" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readPluginEvents("root").at(-1)?.userMessageId).toBe("message-command");
      writeSessionGraphEnabled("root", true, state);
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message-1" }, output as never);
      expect(output.parts.at(-1)).toMatchObject({ type: "text", synthetic: true });
      expect(output.parts.at(-1)?.id).toMatch(/^prt_/);
      expect(output.message.agent).toBe("langgraph-presenter");
      deadline = Date.now() + 4_000;
      while ((child < 2 || posted.length < 3) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(child).toBe(2);
      expect(posted).toHaveLength(3);
      expect(posted.at(-1)).toMatchObject({ body: { agent: "langgraph-presenter" } });
      expect((posted.at(-1) as { body: Record<string, unknown> }).body.tools).toBeUndefined();
      const events = readPluginEvents("root");
      expect(events.map((event) => event.node)).toEqual(expect.arrayContaining(["__start__", "inspect:r1", "verify:r1", "__end__"]));
      expect(new Set(events.map((event) => event.userMessageId))).toEqual(new Set(["message-command"]));
      const toolContext = { sessionID: "root", directory: project, worktree: project, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;
      const startOutput = await (hooks.tool?.langgraph_start.execute as (args: { task: string }, ctx: never) => Promise<string>)({ task: "What is 2+2?" }, toolContext);
      const started = JSON.parse(startOutput) as { runId: string; status: string };
      expect(started).toMatchObject({ status: "running" });
      deadline = Date.now() + 2_000;
      while (!(["completed", "failed"] as string[]).includes(readStoredRun(started.runId).status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(["completed", "failed"]).toContain(readStoredRun(started.runId).status);
      expect(JSON.parse(await (hooks.tool?.langgraph_inspect.execute as (args: { runId: string }, ctx: never) => Promise<string>)({ runId: started.runId }, toolContext)).runId).toBe(started.runId);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("prunes a blocked run via the langgraph_prune tool and resumes it from the checkpoint", async () => {
    const state = temp("opencode-langgraph-tool-state-");
    const directory = temp("opencode-langgraph-tool-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(directory, "target.txt"), "base");
      let child = 0;
      const posted: unknown[] = [];
      const parents = new Map<string, string | undefined>([["root", undefined]]);
      const titles = new Map<string, string>();
      const prompts = new Map<string, string>();
      const client = { session: {
        get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
        create: async ({ body }: { body: { parentID: string; title: string } }) => {
          const id = `child-${++child}`;
          parents.set(id, body.parentID);
          titles.set(id, body.title);
          return { data: { id } };
        },
        promptAsync: async (input: any) => { posted.push(input); prompts.set(input.path.id, input.body.parts?.map((part: { text?: string }) => part.text ?? "").join("\n") ?? ""); return { data: undefined }; },
        status: async () => ({ data: {} }),
        messages: async ({ path: requestPath }: { path: { id: string } }) => {
          if (requestPath.id === "root") return { data: [{ info: { role: "user", model: { providerID: "test", modelID: "model" } }, parts: [{ type: "text", text: "task" }] }] };
          const title = titles.get(requestPath.id) ?? "";
          let structured: unknown = mockV8Structured(title, prompts.get(requestPath.id));
          if (title.includes("inspect:r1")) {
            structured = { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] };
          } else if (title.includes("implement:r1")) {
            fs.writeFileSync(path.join(directory, "target.txt"), "after");
            structured = { status: "completed", summary: "updated", changedFiles: [], checks: [{ name: "target updated", passed: true, evidence: "target updated to after" }], activations: [] };
          } else if (title.includes("verify:r1")) {
            structured = { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], completionEvidence: { implementationOutcome: "changed", implementation: "measured target.txt", directTest: "target passed", correctnessReview: "reviewed", releaseGate: "suite passed", changedFiles: ["target.txt"], focusedTests: ["target"], fullChecks: ["suite"], criterionIds: ["criterion:scope:r1:0"], inspectionEvidenceRefs: [] }, activations: [] };
          }
          return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: JSON.stringify(structured ?? {}) }] }] };
        },
        abort: async () => ({ data: true }),
      } };
      const hooks = await server({ client, directory, worktree: directory } as never);
      const runId = "tool-run";
      writeStoredRun({ checkpointVersion: 8, runId, rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory, worktree: directory, status: "failed" });

      const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer: new DurableFileSaver(path.join(state, "opencode-langgraph", "checkpoints")) });
      let recovering = false;
      const runtime = { call: async (input: { node: string; state?: SolutionLodState }) => {
        if (!recovering) throw new Error("insufficient balance");
        if (input.node === "inspect:r1") return { text: "", structured: { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] } };
        const region = input.state?.network.regions[0];
        if (input.node === "generate-domain:r1") return { text: "", structured: mockV8Structured(input.node) };
        if (input.node === "challenge-domain:r1") return { text: "", structured: { operation: "challenge-domain", verdict: "accept", domainFingerprint: region?.domainFingerprint, viableCandidateIds: region?.candidateIds } };
        if (input.node === "select-candidate:r1") return { text: "", structured: { operation: "select-candidate", domainFingerprint: region?.domainFingerprint, basis: "lexicographic", selectedCandidateId: "r1:direct", hardConstraints: [], comparisons: region?.candidateIds.map((candidateId) => ({ candidateId, userPreference: "neutral", repositoryCompatibility: "neutral", changeScope: candidateId === "r1:direct" ? "preferred" : "disfavored", irreversibleRisk: "neutral", evidenceRefs: [] })) } };
        if (input.node === "refine:r1") return { text: "", structured: mockV8Structured(input.node) };
          if (input.node === "implement:r1") { fs.writeFileSync(path.join(directory, "target.txt"), "after"); return { text: "", structured: { status: "completed", summary: "updated", changedFiles: ["target.txt"], checks: [{ name: "target updated", passed: true, evidence: "target updated to after" }], activations: [] } }; }
        if (input.node === "verify:r1") return { text: "", structured: { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target updated: after" }], completionEvidence: { implementation: "measured target.txt", directTest: "target check passed", correctnessReview: "reviewed target", releaseGate: "suite passed", changedFiles: ["target.txt"], focusedTests: ["target"], fullChecks: ["suite"] }, activations: [] } };
        throw new Error(`unexpected node ${input.node}`);
      } };
      const failed = await configured.graph.invoke(configured.initial({ task: "task", directory, worktree: directory, runId }), { recursionLimit: 64, configurable: { thread_id: runId, langgraphOpenCodeRuntime: runtime, langgraphAcquireWorktree: async () => {} } });
      expect(configured.progress?.(failed)?.phase).toBe("blocked");
      recovering = true;

      const toolContext = { sessionID: "root", directory, worktree: directory, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;

      const inspectOutput = await (hooks.tool?.langgraph_inspect.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const inspected = JSON.parse(inspectOutput);
      expect(inspected.storedStatus).toBe("failed");
      expect(inspected.phase).toBe("blocked");

      const pruneOutput = await (hooks.tool?.langgraph_prune.execute as (args: { runId?: string; regionId: string; reason?: string; objective?: string }, ctx: never) => Promise<string>)({ regionId: "r1", reason: "insufficient balance during inspection", objective: "Update target with a different approach" }, toolContext);
      expect(JSON.parse(pruneOutput).phase).toBe("pruned");
      expect(readStoredRun(runId).status).toBe("pruned");
      const prunedState = await configured.graph.getState({ configurable: { thread_id: runId } });
      expect((prunedState.values as { network: { regions: Array<{ id: string; objective: string }> } }).network.regions.find((item) => item.id === "r1")?.objective).toBe("Update target with a different approach");

      const resumeOutput = await (hooks.tool?.langgraph_resume.execute as (args: { runId?: string; answer?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const resumed = JSON.parse(resumeOutput);
      expect(resumed.failed, JSON.stringify(resumed)).toBe(false);
      expect(resumed.interrupted).toBe(false);
      expect(readStoredRun(runId).status).toBe("completed");
      expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("after");
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("resumes a paused run whose checkpoint lacks input writes without replaying checkpoint values", async () => {
    const state = temp("opencode-langgraph-tool-state-");
    const directory = temp("opencode-langgraph-tool-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      fs.writeFileSync(path.join(directory, "target.txt"), "base");
      let child = 0;
      const parents = new Map<string, string | undefined>([["root", undefined]]);
      const titles = new Map<string, string>();
      const prompts = new Map<string, string>();
      const client = { session: {
        get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id, parentID: parents.get(requestPath.id) } }),
        create: async ({ body }: { body: { parentID: string; title: string } }) => {
          const id = `child-${++child}`;
          parents.set(id, body.parentID);
          titles.set(id, body.title);
          return { data: { id } };
        },
        promptAsync: async (input: any) => { prompts.set(input.path.id, input.body.parts?.map((part: { text?: string }) => part.text ?? "").join("\n") ?? ""); return { data: undefined }; },
        status: async () => ({ data: {} }),
        messages: async ({ path: requestPath }: { path: { id: string } }) => {
          if (requestPath.id === "root") return { data: [{ info: { role: "user", model: { providerID: "test", modelID: "model" } }, parts: [{ type: "text", text: "task" }] }] };
          const title = titles.get(requestPath.id) ?? "";
          let structured: unknown = mockV8Structured(title, prompts.get(requestPath.id));
          if (title.includes("inspect:r1")) {
            structured = { region: { delivery: "change", acceptanceCriteria: ["target updated"] }, evidence: [{ text: "target exists", source: "target.txt", kind: "repository" }], candidates: [], constraints: [], select: [], activations: [{ capability: "synthesize", request: "form domain", expectedDelta: "domain:r1", contextRefs: [] }] };
          } else if (title.includes("implement:r1")) {
            fs.writeFileSync(path.join(directory, "target.txt"), "after");
            structured = { status: "completed", summary: "updated", changedFiles: [], checks: [{ name: "target updated", passed: true, evidence: "target.txt contains after" }], activations: [] };
          } else if (title.includes("verify:r1")) {
            structured = { verdict: "pass", summary: "ok", findings: [], checks: [{ name: "target updated", passed: true, evidence: "target.txt contains after" }], activations: [] };
          }
          return { data: [{ info: { role: "assistant", structured }, parts: [{ type: "text", text: JSON.stringify(structured ?? {}) }] }] };
        },
        abort: async () => ({ data: true }),
      } };
      const hooks = await server({ client, directory, worktree: directory } as never);
      const runId = "values-run";
      writeStoredRun({ checkpointVersion: 8, runId, rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory, worktree: directory, status: "paused" });

      const checkpointer = new DurableFileSaver(path.join(state, "opencode-langgraph", "checkpoints"));
      const configured = solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", refine: "refine", implement: "implement", verify: "verify", present: "present" }, checkpointer });
      // A paused run checkpointed before any input writes were recorded: channel values exist, channel versions do not.
      // langgraph 1.4.9 throws EmptyInputError for invoke(null) against such a thread, so resume must replay the values.
      await checkpointer.put(
        { configurable: { thread_id: runId } },
        { v: 4, id: "1ef5paused000000000000000000000", ts: new Date().toISOString(), channel_values: configured.initial({ task: "task", directory, worktree: directory, runId }), channel_versions: {}, versions_seen: {} },
        { source: "loop", step: 0, writes: {}, parents: [] },
      );
      const paused = await configured.graph.getState({ configurable: { thread_id: runId } });
      expect(Object.keys(paused.values as object).length).toBeGreaterThan(0);

      const toolContext = { sessionID: "root", directory, worktree: directory, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;
      const resumeOutput = await (hooks.tool?.langgraph_resume.execute as (args: { runId?: string; answer?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const resumed = JSON.parse(resumeOutput);
      expect(resumed.failed).toBe(false);
      expect(resumed.interrupted).toBe(false);
      expect(readStoredRun(runId).status).toBe("completed");
      expect(fs.readFileSync(path.join(directory, "target.txt"), "utf8")).toBe("base");
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("inspects a queued run without a checkpoint and refuses to prune an active one", async () => {
    const state = temp("opencode-langgraph-tool-state-");
    const directory = temp("opencode-langgraph-tool-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    try {
      const hooks = await server({ client: { session: { get: async () => ({ data: { id: "root", parentID: undefined } }) } }, directory, worktree: directory } as never);
      const runId = "fresh-run";
      writeStoredRun({ checkpointVersion: 6, runId, rootSessionId: "root", userMessageId: "message", graph: "solution-lod", task: "task", directory, worktree: directory, status: "queued" });
      const toolContext = { sessionID: "root", directory, worktree: directory, agent: "langgraph-presenter", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never;

      const inspectOutput = await (hooks.tool?.langgraph_inspect.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext);
      const inspected = JSON.parse(inspectOutput);
      expect(inspected.storedStatus).toBe("queued");
      expect(inspected.phase).toBe("no-checkpoint-yet");

      await expect((hooks.tool?.langgraph_prune.execute as (args: { runId?: string; regionId: string }, ctx: never) => Promise<string>)({ regionId: "r1" }, toolContext)).rejects.toThrow(/Cannot prune queued run/);
      await expect((hooks.tool?.langgraph_resume.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext)).rejects.toThrow(/cannot be resumed/);
      await expect((hooks.tool?.langgraph_pause.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext)).rejects.toThrow(/queued and cannot be paused/);
      expect(JSON.parse(await (hooks.tool?.langgraph_cancel.execute as (args: { runId?: string }, ctx: never) => Promise<string>)({}, toolContext))).toMatchObject({ runId, status: "cancelled" });
      expect(readStoredRun(runId).status).toBe("cancelled");
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("adopts the home-screen graph selection for the first session message", async () => {
    const state = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const configDirectory = path.join(project, ".opencode");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(project, "node_modules"), "dir");
    fs.writeFileSync(path.join(configDirectory, "langgraph.ts"), `
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { defineGraph, defineOpenCodeLangGraph } from "opencode-langgraph";
const State = Annotation.Root({ task: Annotation<string>, result: Annotation<string> });
const named = (result: string) => defineGraph({
  graph: new StateGraph(State).addNode("finish", () => ({ result })).addEdge(START, "finish").addEdge("finish", END).compile({ checkpointer: new MemorySaver() }),
  initial: ({ task }: { task: string }) => ({ task, result: "" }),
  result: (value: { result: string }) => value.result,
});
export default defineOpenCodeLangGraph({ version: 1, models: {}, agents: {}, graphs: { first: named("first"), second: named("second") }, defaultGraph: "first" });
`);
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = state;
    const posted: unknown[] = [];
    const client = { session: {
      get: async () => ({ data: { id: "root", parentID: undefined } }),
      messages: async () => ({ data: [{ info: { role: "assistant", parentID: "message" }, parts: [] }] }),
      promptAsync: async (input: unknown) => { posted.push(input); return { data: undefined }; },
    } };
    try {
      writeHomeGraphState(project, { enabled: true, graph: "second" }, state);
      const hooks = await server({ client, directory: project, worktree: project } as never);
      const output = {
        message: { id: "message", sessionID: "root", role: "user", agent: "build", model: { providerID: "test", modelID: "model" }, time: { created: Date.now() } },
        parts: [{ id: "part", messageID: "message", sessionID: "root", type: "text", text: "task" }],
      };
      await hooks["chat.message"]?.({ sessionID: "root", messageID: "message" }, output as never);
      const deadline = Date.now() + 2_000;
      while (readPluginEvents("root", state).at(-1)?.node !== "__end__" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const events = readPluginEvents("root", state);
      expect(events.every((event) => event.graph === "second")).toBe(true);
      expect(events.at(-1)).toMatchObject({ node: "__end__", text: "second" });
      expect(posted).toHaveLength(1);
      expect(readSessionGraphEnabled("root", state)).toBe(true);
      expect(readSessionGraphName("root", state)).toBe("second");
      expect(readHomeGraphState(project, state)).toBeUndefined();
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });
});

describe("OpenCode graph viewer", () => {
  it("shows the actual graph name in the prompt shortcut legend", () => {
    expect(graphToggleLabel(false, "review")).toBe("[F7] graph:off · [F8] view · [F9] help");
    expect(graphToggleLabel(true, "review")).toBe("[F7] graph:review · [F8] view · [F9] help");
  });

  it("keeps graph usage and design help available in the TUI", () => {
    expect(graphHelpText()).toContain("/graph-select");
    expect(graphHelpText()).toContain(".opencode/langgraph.ts");
    expect(graphHelpText()).toContain("defineGraph({ graph, initial, result, progress? })");
    expect(graphHelpText()).toContain("R runs");
    expect(graphHelpText()).toContain("P prompt");
    expect(effectivePrompt({ prompt: { system: "ROLE", input: '{"task":"x"}', schemaInstruction: "SCHEMA" } } as never)).toBe('SYSTEM\nROLE\n\nINPUT\n{"task":"x"}\n\nOUTPUT CONTRACT\nSCHEMA');
  });

  it("ships the TUI framework as runtime dependencies", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(["@opentui/core", "@opentui/solid", "solid-js"]));
    expect(manifest.exports["./tui"]).toBe("./dist/src/opencode/tui.js");
    expect(manifest.scripts.build).toContain("build-tui.mjs");
  });

  it("persists graph selection when graph mode is toggled", () => {
    const stateHome = temp("opencode-langgraph-state-");
    writeSessionGraphName("root", "review", stateHome);
    writeSessionGraphEnabled("root", true, stateHome);
    expect(readSessionGraphName("root", stateHome)).toBe("review");
    expect(readSessionGraphEnabled("root", stateHome)).toBe(true);
    writeSessionGraphEnabled("root", false, stateHome);
    expect(readSessionGraphName("root", stateHome)).toBe("review");
  });

  it("routes graph navigation through scoped keymap commands", () => {
    const calls: string[] = [];
    const controls = new Proxy({}, {
      get: (_target, name) => () => calls.push(String(name)),
    }) as GraphControls;
    const layer = graphNavigationLayer(controls);
    const commandByName = new Map(layer.commands.map((command) => [command.name, command]));

    for (const [key, expected] of [
      ["q", "back"], ["tab", "cycle"], ["1", "tree"], ["2", "detail"], ["r", "runs"], ["o", "output"],
      ["p", "prompt"], ["return", "inspect"], ["up", "up"], ["j", "down"], ["left", "left"],
      ["d", "right"], ["pageup", "pageUp"], ["pagedown", "pageDown"], ["home", "home"], ["end", "end"],
      ["n", "newRun"], ["space", "pause"], ["u", "resume"], ["e", "repair"], ["x", "cancel"],
    ] as const) {
      const binding = layer.bindings.find((candidate) => candidate.key === key);
      expect(binding).toBeDefined();
      commandByName.get(binding!.cmd)?.run();
      expect(calls.pop()).toBe(expected);
    }
  });

  it("renders the actual execution states and collapses both sides of the focus", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "default", status: "completed", agent: "analyst", model: "test/model" };
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...base,
      node: `step_${index}`,
      ...(index === 4 ? { status: "active", progress: { phase: "planning", scope: "subsystem", activeNodeId: "p2", nodes: [{ id: "p2", title: "Resolve controller state", level: "controller", depth: 1, status: "active" }] } } : {}),
    }));
    const layout = renderEventGraph(events, "▶", 4);
    expect(layout.canvas).toContain("2 executions collapsed");
    expect(layout.canvas).toContain("3 executions collapsed");
    expect(layout.canvas).toContain("▶  STEP 4  [ACTIVE]");
    expect(layout.canvas).toContain("planning · p2 Resolve controller state · analyst");
    expect(layout.canvas).not.toContain("STEP 0");
    expect(layout.canvas).not.toContain("STEP 9");
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("renders semantic solution progress as a mixed-LOD hierarchy", () => {
    const base = { at: "now", runId: "run", rootSessionId: "root", graph: "solution-lod", node: "activate", status: "active", agent: "inspector", model: "inherit" };
    const semantic = { kind: "solution-lod-v2" as const, revision: 2, candidates: [], constraints: [], evidence: [], activations: [], artifacts: [], regions: [
      { id: "r1", key: "root", edge: "root" as const, lod: 0, objective: "Requested behavior", status: "collapsed", viable: 1, total: 2, selectedCandidateIds: ["r1:adapter"], candidateIds: ["r1:adapter", "r1:rewrite"], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] },
      { id: "r2", key: "handoff", parentId: "r1", edge: "refines" as const, lod: 1, objective: "Session handoff", status: "superposed", viable: 2, total: 3, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: ["e1", "e2"], activationIds: [], artifactIds: [] },
    ] };
    const tree = renderPlanTree([{ ...base, progress: { phase: "inspect:r2", callsUsed: 3, activeNodeId: "r2", semantic, nodes: [
      { id: "r1", title: "Requested behavior", level: "L0", depth: 0, status: "collapsed", agents: ["synthesize"] },
      { id: "r2", parentId: "r1", title: "Session handoff", level: "L1", depth: 1, status: "superposed", evidence: 2, agents: ["inspect"] },
    ] } }]);
    expect(tree).toContain("SOLUTION LOD  inspect:r2");
    expect(tree).toContain("3 activations");
    expect(tree).toContain("└─ ◇ r2  Session handoff");
    expect(tree).toContain("superposed · L1 · 2/3 viable · refines · 2 evidence INSPECT");
  });

  it("keeps the most recently started execution visible when runs overlap", () => {
    const base = { at: "now", rootSessionId: "root", graph: "default", status: "active", agent: "langgraph", model: "langgraph" };
    const events = [
      { ...base, runId: "older", userMessageId: "message-1", node: "__start__", topology: { nodes: ["older"], edges: [] } },
      { ...base, runId: "newer", userMessageId: "message-2", node: "__start__", topology: { nodes: ["newer"], edges: [] } },
      { ...base, runId: "older", userMessageId: "message-1", node: "__end__", status: "completed" },
    ];
    const layout = renderEventGraph(events);
    expect(layout.canvas).toContain("newer");
    expect(layout.canvas).not.toContain("older");
  });

  it("reads the current project run before route lifecycle callbacks", async () => {
    const project = temp("opencode-langgraph-viewer-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      appendPluginEvent({
        at: new Date().toISOString(), runId: "visible-run", rootSessionId: "root", graph: "default",
        node: "answer", status: "completed", agent: "planner", model: "test/model", text: "visible output",
      });
      writeStoredRun({
        runId: "visible-run", rootSessionId: "root", userMessageId: "message", graph: "default", task: "test",
        directory: project, worktree: project, status: "completed",
      });
      expect(readVisibleEvents(undefined, project, stateHome)).toMatchObject([
        { runId: "visible-run", node: "answer", text: "visible output" },
      ]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("does not leak run state across projects or root sessions", () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const otherProject = temp("opencode-langgraph-other-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      appendPluginEvent({
        at: new Date().toISOString(), runId: "isolated-run", rootSessionId: "root-a", graph: "default",
        userMessageId: "message-a", node: "answer", status: "failed", agent: "planner", model: "test/model",
      });
      writeStoredRun({
        runId: "isolated-run", rootSessionId: "root-a", userMessageId: "message-a", graph: "default", task: "test",
        directory: project, worktree: project, status: "failed",
      });

      expect(readVisibleEvents(undefined, project, stateHome)).toHaveLength(1);
      expect(readVisibleEvents(undefined, otherProject, stateHome)).toEqual([]);
      expect(readVisibleEvents("root-b", project, stateHome)).toEqual([]);
      expect(readVisibleEvents("root-a", project, stateHome, "message-a")).toHaveLength(1);
      expect(readVisibleEvents("root-a", project, stateHome, "message-b")).toEqual([]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("lists project runs newest-first and filters visible events by a specific runId", async () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      for (const [runId, task, status] of [["run-old", "oldest task", "completed"], ["run-new", "newest task", "running"]] as const) {
        writeStoredRun({ runId, rootSessionId: "root-a", userMessageId: `message-${runId}`, graph: "solution-lod", task, directory: project, worktree: project, status });
        appendPluginEvent({ at: new Date().toISOString(), runId, rootSessionId: "root-a", graph: "solution-lod", node: "__start__", status: "active", agent: "langgraph", model: "langgraph" });
        appendPluginEvent({ at: new Date().toISOString(), runId, rootSessionId: "root-a", graph: "solution-lod", node: "answer", status: status === "completed" ? "completed" : "active", agent: "planner", model: "test/model", text: `${runId} output` });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const runs = listProjectRuns(project, stateHome);
      expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"]);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "run-old")).toHaveLength(2);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "run-old").every((event) => event.runId === "run-old")).toBe(true);
      expect(readVisibleEvents(undefined, project, stateHome, undefined, "missing-run")).toEqual([]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("resolves run events by runId even when the run belongs to another session or project", () => {
    const stateHome = temp("opencode-langgraph-state-");
    const project = temp("opencode-langgraph-project-");
    const otherProject = temp("opencode-langgraph-other-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    try {
      writeStoredRun({
        runId: "agent-run", rootSessionId: "agent-session", userMessageId: "message", graph: "solution-lod", task: "agent task",
        directory: project, worktree: project, status: "failed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "agent-run", rootSessionId: "agent-session", graph: "solution-lod",
        node: "__end__", status: "failed", agent: "langgraph", model: "langgraph", text: "contradiction",
      });
      writeStoredRun({
        runId: "foreign-run", rootSessionId: "foreign-session", userMessageId: "message", graph: "default", task: "elsewhere",
        directory: otherProject, worktree: otherProject, status: "completed",
      });

      // The active session has no events of its own, yet the run is inspectable by runId.
      expect(readVisibleEvents("current-session", project, stateHome)).toEqual([]);
      const events = readVisibleEvents("current-session", project, stateHome, undefined, "agent-run");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runId: "agent-run", node: "__end__", text: "contradiction" });

      // The run selector sees runs from every session and worktree.
      expect(listAllRuns(stateHome).map((run) => run.runId).sort()).toEqual(["agent-run", "foreign-run"]);
      expect(listProjectRuns(project, stateHome).map((run) => run.runId)).toEqual(["agent-run"]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("offers the run picker when the active session has no graph events", async () => {
    const project = temp("opencode-langgraph-project-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    let commands: Array<{ name: string; run: () => void }> = [];
    const events = new Map<string, (event: { properties: { sessionID: string } }) => void>();
    const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
    let selector: { title: string; options: Array<{ title: string; value: string; description?: string }>; onSelect: (option: { value: string }) => void } | undefined;
    const api = {
      route: {
        current: { name: "home" },
        register: () => () => undefined,
        navigate: (name: string, params?: Record<string, unknown>) => navigations.push({ name, params }),
      },
      state: { path: { worktree: project, directory: project, config: path.join(project, "config") } },
      event: { on: (type: string, handler: (event: { properties: { sessionID: string } }) => void) => { events.set(type, handler); return () => undefined; } },
      slots: { register: () => "opencode-langgraph" },
      renderer: { requestRender: () => undefined },
      keymap: {
        registerLayer: (layer: { commands: typeof commands }) => { commands.push(...layer.commands); return () => undefined; },
        createKeyMatcher: () => () => false,
        intercept: () => () => undefined,
      },
      ui: {
        dialog: { replace: (render: () => unknown) => { render(); }, clear: () => undefined },
        toast: () => undefined,
        DialogAlert: () => "alert",
        DialogSelect: (props: never) => { selector = props; return "select"; },
      },
      mode: { current: () => "base" },
    };
    try {
      writeStoredRun({
        runId: "agent-run", rootSessionId: "agent-session", userMessageId: "message", graph: "solution-lod", task: "launched by an agent",
        directory: project, worktree: project, status: "failed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "agent-run", rootSessionId: "agent-session", graph: "solution-lod",
        node: "__end__", status: "failed", agent: "langgraph", model: "langgraph",
      });
      await tui(api as never, undefined, {} as never);
      events.get("tui.session.select")?.({ properties: { sessionID: "current-session" } });
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations).toEqual([{ name: "langgraph.graph", params: { runs: true } }]);
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });

  it("renders a structured event summary instead of raw blobs", () => {
    const event = {
      runId: "run", rootSessionId: "root", graph: "solution-lod", node: "implement:r2", status: "failed", agent: "langgraph-implement", model: "inherit",
      text: "Implement the selected behavior",
      progress: { phase: "implement:r2", callsUsed: 3, activeNodeId: "r2", semantic: { kind: "solution-lod-v2" as const, revision: 1, candidates: [], constraints: [], evidence: [], activations: [{ id: "a14", capability: "implement", regionId: "r2", request: "", expectedDelta: "implement:r2:18", senderActivationId: undefined, status: "failed", error: "budget" }], artifacts: [], regions: [{ id: "r2", key: "r2", edge: "refines" as const, lod: 1, objective: "Settle emptiness", status: "actionable", viable: 1, total: 2, selectedCandidateIds: [], candidateIds: [], constraintIds: [], evidenceIds: [], activationIds: [], artifactIds: [] }] }, nodes: [] },
      state: { phase: "blocked", callsUsed: 3, network: { regions: [{ id: "r2", status: "actionable" }], candidates: [], activations: [{ id: "a14", capability: "implement", regionId: "r2", status: "failed", error: "budget" }] } },
      usage: { turns: 12, input: 1000, output: 200, reasoning: 0, cacheRead: 500, cacheWrite: 0, cost: 0.01 },
    } as never;
    const structured = renderStructuredEvent(event);
    expect(structured).toContain("IMPLEMENT:R2  [FAILED]  IMPLEMENT");
    expect(structured).toContain("OUTPUT");
    expect(structured).toContain("Implement the selected behavior");
    expect(structured).toContain("r2  [actionable]");
    expect(structured).toContain("a14:implement  [failed]  r2");
    expect(structured).toContain("budget");
    expect(structured).not.toContain("\"phase\"");
  });

  it("appends the live streaming estimate suffix only while an event carries it", () => {
    const base = { runId: "run", rootSessionId: "root", graph: "solution-lod", node: "synthesize:r6", status: "active", agent: "langgraph-synthesize", model: "inherit" };
    const usage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const streaming = renderStructuredEvent({ ...base, usage, streaming: { inputEstimated: 4_000, outputEstimated: 200 } } as never);
    expect(streaming).toContain("USAGE  0t · 0in · 0cache · ~4.2k live");
    const completed = renderStructuredEvent({ ...base, status: "completed", usage: { ...usage, turns: 2, input: 1_000, cacheRead: 500 } } as never);
    expect(completed).toContain("USAGE  2t · 1kin · 500cache");
    expect(completed).not.toContain("live");
    expect(usageLine(usage, { inputEstimated: 4_000, outputEstimated: 200 })).toBe("0t · 0in · 0cache · ~4.2k live");
    expect(usageLine({ ...usage, cost: 0.5 })).toBe("0t · 0in · 0cache · $0.500");
  });

  it("opens the project graph when no chat session exists yet", async () => {
    const project = temp("opencode-langgraph-project-");
    const stateHome = temp("opencode-langgraph-state-");
    const priorState = process.env.OPENCODE_LANGGRAPH_STATE_HOME;
    process.env.OPENCODE_LANGGRAPH_STATE_HOME = stateHome;
    let commands: Array<{ name: string; run: () => void }> = [];
    const bindings: Array<{ key: string; cmd: string }> = [];
    const events = new Map<string, (event: { properties: { sessionID: string } }) => void>();
    const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const dialogs: string[] = [];
    let renders = 0;
    const api = {
      route: {
        current: { name: "home" },
        register: () => () => undefined,
        navigate: (name: string, params?: Record<string, unknown>) => navigations.push({ name, params }),
      },
      state: { path: { worktree: project, directory: project, config: path.join(project, "config") } },
      event: { on: (type: string, handler: (event: { properties: { sessionID: string } }) => void) => { events.set(type, handler); return () => undefined; } },
      slots: { register: () => "opencode-langgraph" },
      renderer: { requestRender: () => { renders++; } },
      keymap: {
        registerLayer: (layer: { commands: typeof commands; bindings?: typeof bindings }) => { commands.push(...layer.commands); bindings.push(...(layer.bindings ?? [])); return () => undefined; },
        createKeyMatcher: () => () => false,
        intercept: () => () => undefined,
      },
      ui: {
        dialog: { replace: (render: () => unknown) => { dialogs.push(String(render())); }, clear: () => undefined },
        toast: () => undefined,
        DialogAlert: (props: { title: string }) => props.title,
        DialogSelect: (props: { title: string }) => props.title,
      },
      mode: { current: () => "base" },
    };
    try {
      await tui(api as never, undefined, {} as never);
      commands.find((command) => command.name === "langgraph.graph.toggle")?.run();
      expect(readHomeGraphState(project, stateHome)).toEqual({ enabled: true });
      expect(renders).toBe(1);
      events.get("session.created")?.({ properties: { sessionID: "root-session", info: { directory: project } } } as never);
      expect(readSessionGraphEnabled("root-session", stateHome)).toBe(true);
      expect(readHomeGraphState(project, stateHome)).toBeUndefined();
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations).toEqual([{ name: "langgraph.graph", params: { runs: true } }]);
      expect(dialogs).toEqual([]);
      writeStoredRun({
        runId: "run-root", rootSessionId: "root-session", userMessageId: "message", graph: "default", task: "test",
        directory: project, worktree: project, status: "completed",
      });
      appendPluginEvent({
        at: new Date().toISOString(), runId: "run-root", rootSessionId: "root-session", graph: "default",
        node: "answer", status: "completed", agent: "planner", model: "test/model",
      });
      events.get("tui.session.select")?.({ properties: { sessionID: "root-session" } });
      commands.find((command) => command.name === "langgraph.graph.open")?.run();
      expect(navigations.at(-1)).toEqual({ name: "langgraph.graph", params: { sessionID: "root-session" } });
      expect(commands.map((command) => command.name)).toContain("langgraph.graph.select");
      expect(bindings).toContainEqual({ key: "f7", cmd: "langgraph.graph.toggle", desc: "Toggle LangGraph" });
      expect(bindings).toContainEqual({ key: "f9", cmd: "langgraph.graph.help", desc: "LangGraph help" });
    } finally {
      if (priorState === undefined) delete process.env.OPENCODE_LANGGRAPH_STATE_HOME;
      else process.env.OPENCODE_LANGGRAPH_STATE_HOME = priorState;
    }
  });
});
