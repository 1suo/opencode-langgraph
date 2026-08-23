import { spawn } from "node:child_process";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { AgentBudgetStop, AgentCall, AgentCallLimits, AgentCallResult, AgentPromptTrace, AgentRuntime, AgentToolTrace, AgentUsage, ConnectorDefinition, UsageStreamingEstimate } from "../core/types.js";
import { errorMessage } from "../core/error-message.js";
import { registerPermissionHandler } from "./permissions.js";

export interface OpenCodeRuntimeOptions {
  plugin: PluginInput;
  definition: ConnectorDefinition;
  parentSessionId: string;
  parentModel?: { providerID: string; modelID: string };
  directory: string;
  worktree: string;
  signal: AbortSignal;
  ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
  onEvent?: (event: { node: string; status: string; agent: string; model: string; text?: string; state?: Record<string, unknown>; structured?: unknown; sessionId?: string; usage?: AgentUsage; streaming?: UsageStreamingEstimate; prompt?: AgentPromptTrace }) => void;
}

function modelId(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new Error(`Invalid OpenCode model: ${value}`);
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

const CHARS_PER_TOKEN = 4;
const ESTIMATE_EMIT_INTERVAL_MS = 1_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60_000;

function envInactivityTimeoutMs(): number | undefined {
  const raw = process.env.OPENCODE_LANGGRAPH_INACTIVITY_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function streamingEstimate(messages: Array<{ info: { role: string; finish?: string }; parts: Part[] }>, inputEstimated: number): UsageStreamingEstimate | undefined {
  const inFlight = [...messages].reverse().find((message) => message.info.role === "assistant" && !message.info.finish);
  if (!inFlight) return undefined;
  let outputChars = 0;
  for (const part of inFlight.parts) {
    if (part.type === "text" && !part.ignored) outputChars += part.text.length;
    else if (part.type === "reasoning") outputChars += part.text.length;
  }
  return { inputEstimated, outputEstimated: estimateTokens(outputChars) };
}

function text(parts: Part[]): string {
  return parts.filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored).map((part) => part.text).join("").trim();
}

function progress(parts: Part[]): string {
  return parts.flatMap((part) => {
    if (part.type === "text" && !part.ignored) return [part.text];
    if (part.type === "reasoning") return [part.text];
    return [];
  }).join("\n").trim();
}

function activityFingerprint(messages: Array<{ info: { id?: string; role: string }; parts: Part[] }>): string {
  return JSON.stringify(messages.map((message) => [message.info.id, message.info.role, message.parts.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return [part.id, part.type, part.text.length];
    if (part.type === "tool") return [part.id, part.type, (part.state as Record<string, unknown>).status];
    return [part.id, part.type];
  })]));
}

function sessionUsage(messages: Array<{ info: { id?: string; role: string; finish?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }; parts: Part[] }>): AgentUsage {
  const usage: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) {
    if (message.info.role !== "assistant" || !message.info.finish) continue;
    usage.turns++;
    usage.input += message.info.tokens?.input ?? 0;
    usage.output += message.info.tokens?.output ?? 0;
    usage.reasoning += message.info.tokens?.reasoning ?? 0;
    usage.cacheRead += message.info.tokens?.cache?.read ?? 0;
    usage.cacheWrite += message.info.tokens?.cache?.write ?? 0;
    usage.cost += message.info.cost ?? 0;
  }
  return usage;
}

function subtractUsage(total: AgentUsage, baseline: AgentUsage): AgentUsage {
  return {
    turns: Math.max(0, total.turns - baseline.turns), input: Math.max(0, total.input - baseline.input),
    output: Math.max(0, total.output - baseline.output), reasoning: Math.max(0, total.reasoning - baseline.reasoning),
    cacheRead: Math.max(0, total.cacheRead - baseline.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, total.cost - baseline.cost),
  };
}

function latestContextTokens(messages: Array<{ info: { role: string; finish?: string; tokens?: { input?: number; cache?: { read?: number } } } }>): number {
  const latest = [...messages].reverse().find((message) => message.info.role === "assistant" && message.info.finish);
  return (latest?.info.tokens?.input ?? 0) + (latest?.info.tokens?.cache?.read ?? 0);
}

function toolTraces(parts: Part[]): AgentToolTrace[] {
  const traces: AgentToolTrace[] = [];
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const state = part.state as Record<string, unknown>;
    if (state.status === "completed") traces.push({
      tool: part.tool, status: "completed" as const, title: state.title as string | undefined,
      input: state.input, output: state.output as string | undefined,
      metadata: state.metadata as Record<string, unknown> | undefined,
    });
    if (state.status === "error") traces.push({ tool: part.tool, status: "error", input: state.input, error: errorMessage(state.error ?? "Tool failed") });
  }
  return traces;
}

function newToolTraces(messages: Array<{ parts: Part[] }>, baselinePartIds: Set<string>): AgentToolTrace[] {
  return messages.flatMap((message) => message.parts.filter((part) => !baselinePartIds.has(part.id))).flatMap((part) => toolTraces([part]));
}

function exceededBudget(usage: AgentUsage, contextTokens: number, limits: AgentCallLimits): AgentBudgetStop | undefined {
  const checks: Array<[AgentBudgetStop["metric"], number, number | undefined]> = [
    ["turns", usage.turns, limits.maxTurns], ["input", usage.input, limits.maxInputTokens],
    ["cacheRead", usage.cacheRead, limits.maxCacheReadTokens], ["context", contextTokens, limits.maxContextTokens],
    ["cost", usage.cost, limits.maxCost],
  ];
  const exceeded = checks.find(([, used, limit]) => limit !== undefined && used >= limit);
  return exceeded ? { kind: "budget", metric: exceeded[0], used: exceeded[1], limit: exceeded[2]! } : undefined;
}

function parseCommandStructured(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? output).trim());
}

function addUsage(left: AgentUsage, right: AgentUsage | undefined): AgentUsage {
  const value = right ?? { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  return { turns: left.turns + value.turns, input: left.input + value.input, output: left.output + value.output, reasoning: left.reasoning + value.reasoning, cacheRead: left.cacheRead + value.cacheRead, cacheWrite: left.cacheWrite + value.cacheWrite, cost: left.cost + value.cost };
}

function remainingLimits(limits: AgentCallLimits, usage: AgentUsage): AgentCallLimits {
  const remaining = (limit: number | undefined, used: number) => limit === undefined ? undefined : Math.max(0, limit - used);
  return {
    ...limits,
    maxTurns: remaining(limits.maxTurns, usage.turns), maxInputTokens: remaining(limits.maxInputTokens, usage.input),
    maxCacheReadTokens: remaining(limits.maxCacheReadTokens, usage.cacheRead), maxCost: remaining(limits.maxCost, usage.cost),
  };
}

function promptTrace(system: string, input: string, schema?: Record<string, unknown>): AgentPromptTrace {
  return {
    system,
    input,
    ...(schema ? { schemaInstruction: `Return only a JSON value matching this JSON Schema. Do not use Markdown fences:\n${JSON.stringify(schema)}` } : {}),
  };
}

async function commandCall(command: string, args: string[], env: Record<string, string> | undefined, cwd: string, prompt: string, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
    child.stdin.end(prompt);
  });
}

export class OpenCodeAgentRuntime implements AgentRuntime {
  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  async call(input: AgentCall): Promise<AgentCallResult> {
    const agent = this.options.definition.agents[input.agent];
    if (!agent) throw new Error(`Unknown LangGraph connector agent: ${input.agent}`);
    const model = this.options.definition.models[agent.model];
    if (!model) throw new Error(`Agent ${input.agent} references unknown model ${agent.model}`);
    const composedPrompt = promptTrace(agent.systemPrompt, input.prompt, input.schema);
    const directory = input.directory ?? this.options.directory;
    const worktree = input.worktree ?? this.options.worktree;
    if (model.backend === "command") {
      this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: agent.model, state: input.state, prompt: composedPrompt });
      const schemaInstruction = composedPrompt.schemaInstruction ? `\n\n${composedPrompt.schemaInstruction}` : "";
      const output = await commandCall(model.command, model.args ?? [], model.env, worktree, `${composedPrompt.system}\n\n${composedPrompt.input}${schemaInstruction}`, this.options.signal);
      if (!output) throw new Error(`Command agent ${input.agent} returned no output`);
      const structured = input.schema ? parseCommandStructured(output) : undefined;
      const validated = structured !== undefined && input.validateStructured ? input.validateStructured(structured) : structured;
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: agent.model, text: output, state: input.state, ...(validated !== undefined ? { structured: validated } : {}) });
      return { text: output, structured: validated };
    }
    const selected = model.model === "inherit" ? this.options.parentModel : modelId(model.model);
    if (!selected) throw new Error(`Agent ${input.agent} inherits a model, but the parent OpenCode message did not provide one`);
    let sessionId: string;
    if (input.session?.strategy === "continue") {
      if (!input.session.sessionId) throw new Error(`Agent ${input.agent} requested session continuation without a session ID`);
      sessionId = input.session.sessionId;
    } else if (input.session?.strategy === "fork") {
      if (!input.session.sessionId) throw new Error(`Agent ${input.agent} requested session fork without a session ID`);
      const parent = await this.options.plugin.client.session.messages({ path: { id: input.session.sessionId }, query: { directory }, throwOnError: true });
      const abortedMessage = [...parent.data].reverse().find((message) => {
        const info = message.info as typeof message.info & { error?: unknown };
        return info.role === "assistant" && Boolean(info.error);
      });
      const forked = await this.options.plugin.client.session.fork({
        path: { id: input.session.sessionId }, query: { directory },
        ...(abortedMessage?.info.id ? { body: { messageID: abortedMessage.info.id } } : {}), throwOnError: true,
      });
      sessionId = forked.data.id;
    } else {
      const created = await this.options.plugin.client.session.create({
        body: { parentID: this.options.parentSessionId, title: `LangGraph · ${input.node} · ${input.agent}` },
        query: { directory },
        throwOnError: true,
      });
      sessionId = created.data.id;
    }
    const reusingSession = input.session?.strategy === "continue" || input.session?.strategy === "fork";
    const before = reusingSession
      ? await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true })
      : { data: [] as Array<{ info: { id?: string; role: string; finish?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }; parts: Part[] }> };
    let baselineUsage = sessionUsage(before.data);
    let baselineMessageIds = new Set(before.data.flatMap((message) => message.info.id ? [message.info.id] : []));
    let baselinePartIds = new Set(before.data.flatMap((message) => message.parts.map((part) => part.id)));
    const inputEstimated = estimateTokens(composedPrompt.system.length + composedPrompt.input.length + (composedPrompt.schemaInstruction?.length ?? 0));
    this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, state: input.state, sessionId, prompt: composedPrompt, streaming: { inputEstimated, outputEstimated: 0 } });
    const abort = () => { void this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } }); };
    const unregisterPermission = registerPermissionHandler(sessionId, async (permission) => {
      const patterns = Array.isArray(permission.pattern) ? permission.pattern : permission.pattern ? [permission.pattern] : ["*"];
      try {
        if (!this.options.ask) throw new Error("No root permission bridge is available");
        await this.options.ask({ permission: permission.type, patterns, always: patterns, metadata: { title: permission.title, childSessionId: sessionId, ...permission.metadata } });
        await this.options.plugin.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permission.id }, query: { directory }, body: { response: "once" }, throwOnError: true });
      } catch {
        await this.options.plugin.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permission.id }, query: { directory }, body: { response: "reject" }, throwOnError: true });
      }
    });
    this.options.signal.addEventListener("abort", abort, { once: true });
    try {
      const limits = { maxTurns: agent.maxSteps, ...input.limits };
      const attempts = input.schema ? Math.min(4, Math.max(2, 1 + (input.retryCount ?? 2))) : 1;
      let usage: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const tools: AgentToolTrace[] = [];
      let prompt = `${composedPrompt.input}${composedPrompt.schemaInstruction ? `\n\n${composedPrompt.schemaInstruction}` : ""}`;
      for (let attempt = 0; attempt < attempts; attempt++) {
        await this.options.plugin.client.session.promptAsync({
          path: { id: sessionId }, query: { directory },
          body: { agent: agent.opencodeAgent, model: selected, system: composedPrompt.system, tools: agent.tools, parts: [{ type: "text", text: prompt }] } as never,
          throwOnError: true,
        });
        const output = await this.waitForAnswer(
          sessionId, input.node, input.agent, `${selected.providerID}/${selected.modelID}`, directory,
          agent.inactivityTimeoutMs ?? envInactivityTimeoutMs() ?? DEFAULT_INACTIVITY_TIMEOUT_MS, agent.maxRuntimeMs ?? 30 * 60_000,
          remainingLimits(limits, usage), usage, inputEstimated, baselineUsage, baselineMessageIds, baselinePartIds,
        );
        usage = addUsage(usage, output.usage);
        if (output.tools) tools.push(...output.tools);
        if (output.budgetStop) return { ...output, usage, ...(tools.length ? { tools } : {}), sessionId };
        if (!input.schema) {
          const measured = usage.turns ? usage : undefined;
          this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: output.text, state: input.state, sessionId, usage: measured });
          return { ...output, ...(measured ? { usage: measured } : {}), ...(tools.length ? { tools } : {}), sessionId };
        }
        try {
          const raw = output.structured !== undefined ? output.structured : parseCommandStructured(output.text);
          const structured = input.validateStructured ? input.validateStructured(raw) : raw;
          const measured = usage.turns ? usage : undefined;
          this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: output.text, state: input.state, structured, sessionId, usage: measured });
          return { ...output, structured, ...(measured ? { usage: measured } : {}), ...(tools.length ? { tools } : {}), sessionId };
        } catch (error) {
          if (attempt + 1 >= attempts) throw new Error(`${input.node} returned invalid structured output after ${attempts} attempts: ${errorMessage(error)}`);
          this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: `Invalid structured output; retrying (${attempt + 1}/${attempts - 1})`, state: input.state, sessionId, usage });
          const current = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true });
          baselineUsage = sessionUsage(current.data);
          baselineMessageIds = new Set(current.data.flatMap((message) => message.info.id ? [message.info.id] : []));
          baselinePartIds = new Set(current.data.flatMap((message) => message.parts.map((part) => part.id)));
          const validationError = errorMessage(error);
          const invalidOutput = output.text.slice(0, 4_000);
          prompt = `Your previous JSON failed validation.\n\nFAILED PRECONDITION\n${validationError}\n\nADMISSIBLE CORRECTION\nKeep the same task and every valid prior decision. Correct only the rejected structure, then return one complete JSON value matching the original schema with no prose.\n\nPREVIOUS INVALID OUTPUT\n${invalidOutput}`;
        }
      }
      throw new Error(`${input.node} returned no structured output`);
    } catch (error) {
      this.options.onEvent?.({ node: input.node, status: this.options.signal.aborted ? "interrupted" : "failed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: errorMessage(error), state: input.state, sessionId });
      throw error;
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      unregisterPermission();
    }
  }

  private async waitForAnswer(sessionId: string, node: string, agent: string, model: string, directory: string, inactivityTimeoutMs: number, maxRuntimeMs: number, limits: AgentCallLimits, priorUsage: AgentUsage, inputEstimated: number, baselineUsage: AgentUsage, baselineMessageIds: Set<string>, baselinePartIds: Set<string>): Promise<Omit<AgentCallResult, "sessionId">> {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastFingerprint = "";
    let lastProgress = "";
    let lastUsage = "";
    let lastStreaming = "";
    let lastEstimateEmitAt = 0;
    const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(inactivityTimeoutMs / 4)));
    while (true) {
      if (this.options.signal.aborted) throw this.options.signal.reason ?? new Error("LangGraph run aborted");
      const status = await this.options.plugin.client.session.status({ query: { directory }, throwOnError: true });
      const current = status.data[sessionId];
      if (current && current.type !== "idle") lastActivityAt = Date.now();
      const messages = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true });
      const usage = subtractUsage(sessionUsage(messages.data), baselineUsage);
      const streaming = streamingEstimate(messages.data, inputEstimated);
      const usageFingerprint = JSON.stringify(usage);
      const streamingFingerprint = JSON.stringify(streaming) ?? "";
      const polledAt = Date.now();
      if (usageFingerprint !== lastUsage || (streamingFingerprint !== lastStreaming && polledAt - lastEstimateEmitAt >= ESTIMATE_EMIT_INTERVAL_MS)) {
        lastUsage = usageFingerprint;
        lastStreaming = streamingFingerprint;
        lastEstimateEmitAt = polledAt;
        this.options.onEvent?.({ node, status: "active", agent, model, sessionId, usage: addUsage(priorUsage, usage), ...(streaming ? { streaming } : {}) });
      }
      const fingerprint = activityFingerprint(messages.data);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastActivityAt = Date.now();
      }
      if (!current || current.type === "idle") {
        const assistant = [...messages.data].reverse().find((message) => message.info.role === "assistant" && (!message.info.id || !baselineMessageIds.has(message.info.id)));
        if (assistant?.info.role === "assistant" && assistant.info.error) throw new Error(`OpenCode agent failed: ${JSON.stringify(assistant.info.error)}`);
        const output = assistant ? text(assistant.parts) : "";
        const structured = assistant?.info.role === "assistant" ? (assistant.info as typeof assistant.info & { structured?: unknown }).structured : undefined;
        if (output || structured !== undefined) {
          const tools = newToolTraces(messages.data, baselinePartIds);
          return { text: output || JSON.stringify(structured), ...(structured !== undefined ? { structured } : {}), ...(tools.length ? { tools } : {}), ...(usage.turns ? { usage } : {}) };
        }
        const preview = assistant ? progress(assistant.parts) : "";
        if (preview && preview !== lastProgress) {
          lastProgress = preview;
          this.options.onEvent?.({ node, status: "active", agent, model, text: preview, sessionId, ...(streaming ? { streaming } : {}) });
        }
      }
      const now = Date.now();
      const budgetStop = exceededBudget(usage, latestContextTokens(messages.data), limits);
      if (budgetStop) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } });
        const tools = newToolTraces(messages.data, baselinePartIds);
        return { text: "", usage, budgetStop, ...(tools.length ? { tools } : {}) };
      }
      if (now - startedAt >= maxRuntimeMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } });
        throw new Error(`OpenCode session ${sessionId} exceeded its ${maxRuntimeMs}ms maximum runtime`);
      }
      if (now - lastActivityAt >= inactivityTimeoutMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } });
        throw new Error(`OpenCode session ${sessionId} was inactive for ${inactivityTimeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
