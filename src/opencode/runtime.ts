import { spawn } from "node:child_process";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { AgentBudgetStop, AgentCall, AgentCallLimits, AgentCallResult, AgentPromptTrace, AgentRetryTrace, AgentRuntime, AgentToolTrace, AgentUsage, ConnectorDefinition, UsageStreamingEstimate } from "../core/types.js";
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
export const OPENCODE_RUNTIME_RETRY_POLICY = {
  maxRecoveries: 1,
  startup: { retries: 1, backoffMs: 25, action: "fresh" },
  transport: { pollRetries: 2, retries: 1, backoffMs: 50, action: "fork-if-useful" },
  inactivity: { retries: 1, backoffMs: 50, action: "fork-if-useful" },
  schema: { retries: 2, action: "same-session" },
  semantic: { retries: 0, action: "none" },
} as const;

export type OpenCodeRuntimeFailureKind = "startup" | "transport" | "inactivity" | "schema" | "semantic";

export class OpenCodeRuntimeError extends Error {
  readonly name = "OpenCodeRuntimeError";

  constructor(
    readonly kind: OpenCodeRuntimeFailureKind,
    message: string,
    readonly diagnostics: {
      sessionId?: string;
      usage?: AgentUsage;
      tools?: AgentToolTrace[];
      progressText?: string;
      retryTrace?: AgentRetryTrace[];
      retryable: boolean;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  get sessionId(): string | undefined { return this.diagnostics.sessionId; }
  get usage(): AgentUsage | undefined { return this.diagnostics.usage; }
  get tools(): AgentToolTrace[] | undefined { return this.diagnostics.tools; }
  get progressText(): string | undefined { return this.diagnostics.progressText; }
  get retryTrace(): AgentRetryTrace[] | undefined { return this.diagnostics.retryTrace; }
  get retryable(): boolean { return this.diagnostics.retryable; }
}

function runtimeError(error: unknown, kind: OpenCodeRuntimeFailureKind, diagnostics: Partial<OpenCodeRuntimeError["diagnostics"]> = {}): OpenCodeRuntimeError {
  if (error instanceof OpenCodeRuntimeError) {
    const tools = diagnostics.tools && error.tools && diagnostics.tools !== error.tools ? [...diagnostics.tools, ...error.tools] : error.tools ?? diagnostics.tools;
    const merged = { ...diagnostics, ...error.diagnostics, ...(tools ? { tools } : {}) };
    return new OpenCodeRuntimeError(error.kind, error.message, { ...merged, retryable: error.retryable }, { cause: error.cause });
  }
  return new OpenCodeRuntimeError(kind, errorMessage(error), { retryable: kind === "transport" || kind === "inactivity", ...diagnostics }, { cause: error });
}

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
    if (part.type === "tool") return [part.id, part.type, part.state];
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

function hasActiveTool(messages: Array<{ parts: Part[] }>): boolean {
  return messages.some((message) => message.parts.some((part) => {
    if (part.type !== "tool") return false;
    const status = (part.state as Record<string, unknown>).status;
    return status !== "completed" && status !== "error";
  }));
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
    const retries: AgentRetryTrace[] = [];
    const consumed: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const consumedTools: AgentToolTrace[] = [];
    const limits = { maxTurns: this.options.definition.agents[input.agent]?.maxSteps, ...input.limits };
    let next = input;
    let startupSignature: string | undefined;
    while (true) {
      try {
        const result = await this.callInternal(next);
        if (!retries.length) return result;
        const usage = addUsage(consumed, result.usage);
        const tools = [...consumedTools, ...(result.tools ?? [])];
        return { ...result, ...(usage.turns || usage.cost ? { usage } : {}), ...(tools.length ? { tools } : {}), retryTrace: retries };
      } catch (error) {
        const failure = runtimeError(error, "semantic");
        const useful = Boolean(failure.sessionId && (failure.progressText || failure.tools?.length || failure.usage?.turns));
        const canFork = typeof (this.options.plugin.client.session as { fork?: unknown }).fork === "function";
        const freshCall = !input.session || input.session.strategy === "fresh";
        const signature = `${failure.kind}:${failure.sessionId ? failure.message.replace(failure.sessionId, "<session>") : failure.message}`;
        const repeatedStartup = failure.kind === "startup" && startupSignature === signature;
        const canRecover = retries.length < OPENCODE_RUNTIME_RETRY_POLICY.maxRecoveries;
        const kindRetries = retries.filter((item) => item.kind === failure.kind).length;
        let action: AgentRetryTrace["action"] = "none";
        if (canRecover && failure.retryable && failure.kind === "startup" && kindRetries < OPENCODE_RUNTIME_RETRY_POLICY.startup.retries && freshCall && !repeatedStartup) action = "fresh";
        else if (canRecover && failure.retryable && failure.kind === "transport" && kindRetries < OPENCODE_RUNTIME_RETRY_POLICY.transport.retries && useful && canFork) action = "fork";
        else if (canRecover && failure.retryable && failure.kind === "inactivity" && kindRetries < OPENCODE_RUNTIME_RETRY_POLICY.inactivity.retries && useful && canFork) action = "fork";
        const trace: AgentRetryTrace = {
          kind: failure.kind, message: failure.message, action, sessionId: failure.sessionId,
          usage: failure.usage, tools: failure.tools, progressText: failure.progressText,
        };
        if (action === "none") {
          const usage = addUsage(consumed, failure.usage);
          const tools = [...consumedTools, ...(failure.tools ?? [])];
          throw new OpenCodeRuntimeError(failure.kind, failure.message, {
            ...failure.diagnostics, usage, ...(tools.length ? { tools } : {}), retryTrace: [...retries, trace], retryable: false,
          }, { cause: failure.cause });
        }
        retries.push(trace);
        const totalUsage = addUsage(consumed, failure.usage);
        Object.assign(consumed, totalUsage);
        consumedTools.push(...failure.tools ?? []);
        if (failure.kind === "startup") startupSignature = signature;
        if (action === "fork") await this.options.plugin.client.session.abort({ path: { id: failure.sessionId! }, query: { directory: input.directory ?? this.options.directory } }).catch(() => {});
        const backoffMs = failure.kind === "startup" ? OPENCODE_RUNTIME_RETRY_POLICY.startup.backoffMs : OPENCODE_RUNTIME_RETRY_POLICY[failure.kind as "transport" | "inactivity"].backoffMs;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        next = {
          ...input,
          session: action === "fork" ? { strategy: "fork", sessionId: failure.sessionId } : { strategy: "fresh" },
          limits: remainingLimits(limits, consumed),
        };
      }
    }
  }

  private async callInternal(input: AgentCall): Promise<AgentCallResult> {
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
      let structured: unknown;
      let validated: unknown;
      try {
        structured = input.schema ? parseCommandStructured(output) : undefined;
        validated = structured !== undefined && input.validateStructured ? input.validateStructured(structured) : structured;
      } catch (error) {
        throw new OpenCodeRuntimeError("schema", `Command agent ${input.agent} returned invalid structured output: ${errorMessage(error)}`, { progressText: output, retryable: false }, { cause: error });
      }
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: agent.model, text: output, state: input.state, ...(validated !== undefined ? { structured: validated } : {}) });
      return { text: output, structured: validated };
    }
    const selected = model.model === "inherit" ? this.options.parentModel : modelId(model.model);
    if (!selected) throw new Error(`Agent ${input.agent} inherits a model, but the parent OpenCode message did not provide one`);
    if ((input.session?.strategy === "continue" || input.session?.strategy === "fork") && !input.session.sessionId) {
      throw new Error(`Agent ${input.agent} requested session ${input.session.strategy} without a session ID`);
    }
    let sessionId: string | undefined;
    let before: { data: Array<{ info: { id?: string; role: string; finish?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }; parts: Part[] }> };
    try {
      if (input.session?.strategy === "continue") {
        sessionId = input.session.sessionId!;
      } else if (input.session?.strategy === "fork") {
        sessionId = input.session.sessionId!;
        const parent = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true });
        const abortedMessage = [...parent.data].reverse().find((message) => {
          const info = message.info as typeof message.info & { error?: unknown };
          return info.role === "assistant" && Boolean(info.error);
        });
        const forked = await this.options.plugin.client.session.fork({
          path: { id: sessionId }, query: { directory },
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
      before = reusingSession
        ? await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true })
        : { data: [] };
    } catch (error) {
      const kind = sessionId ? "transport" : "startup";
      throw runtimeError(error, kind, { sessionId, retryable: kind === "startup" || Boolean(sessionId) });
    }
    let baselineUsage = sessionUsage(before.data);
    let baselineMessageIds = new Set(before.data.flatMap((message) => message.info.id ? [message.info.id] : []));
    let baselinePartIds = new Set(before.data.flatMap((message) => message.parts.map((part) => part.id)));
    const inputEstimated = estimateTokens(composedPrompt.system.length + composedPrompt.input.length + (composedPrompt.schemaInstruction?.length ?? 0));
    this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, state: input.state, sessionId, prompt: composedPrompt, streaming: { inputEstimated, outputEstimated: 0 } });
    const abort = () => { void this.options.plugin.client.session.abort({ path: { id: sessionId! }, query: { directory } }).catch(() => {}); };
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
    let usage: AgentUsage = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const tools: AgentToolTrace[] = [];
    let progressText = "";
    try {
      const limits = { maxTurns: agent.maxSteps, ...input.limits };
      const attempts = input.schema ? Math.min(4, Math.max(2, 1 + (input.retryCount ?? OPENCODE_RUNTIME_RETRY_POLICY.schema.retries))) : 1;
      let prompt = `${composedPrompt.input}${composedPrompt.schemaInstruction ? `\n\n${composedPrompt.schemaInstruction}` : ""}`;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await this.options.plugin.client.session.promptAsync({
            path: { id: sessionId }, query: { directory },
            body: { agent: agent.opencodeAgent, model: selected, system: composedPrompt.system, tools: agent.tools, parts: [{ type: "text", text: prompt }] } as never,
            throwOnError: true,
          });
        } catch (error) {
          throw runtimeError(error, "transport", { sessionId, usage, ...(tools.length ? { tools } : {}) });
        }
        const output = await this.waitForAnswer(
          sessionId, input.node, input.agent, `${selected.providerID}/${selected.modelID}`, directory,
          agent.inactivityTimeoutMs ?? envInactivityTimeoutMs() ?? DEFAULT_INACTIVITY_TIMEOUT_MS, agent.maxRuntimeMs ?? 30 * 60_000,
          remainingLimits(limits, usage), usage, inputEstimated, baselineUsage, baselineMessageIds, baselinePartIds,
        );
        progressText = output.text || progressText;
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
          if (attempt + 1 >= attempts) throw new OpenCodeRuntimeError("schema", `${input.node} returned invalid structured output after ${attempts} attempts: ${errorMessage(error)}`, { sessionId, usage, ...(tools.length ? { tools } : {}), progressText: output.text, retryable: false }, { cause: error });
          this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: `Invalid structured output; retrying (${attempt + 1}/${attempts - 1})`, state: input.state, sessionId, usage });
          let current: Awaited<ReturnType<typeof this.options.plugin.client.session.messages>>;
          try {
            current = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true });
          } catch (fetchError) {
            throw runtimeError(fetchError, "transport", { sessionId, usage, ...(tools.length ? { tools } : {}), progressText: output.text });
          }
          baselineUsage = sessionUsage(current.data);
          baselineMessageIds = new Set(current.data.flatMap((message) => message.info.id ? [message.info.id] : []));
          baselinePartIds = new Set(current.data.flatMap((message) => message.parts.map((part) => part.id)));
          const validationError = errorMessage(error);
          const invalidOutput = output.text.slice(0, 4_000);
          prompt = `Your previous JSON failed validation.\n\nFAILED PRECONDITION\n${validationError}\n\nADMISSIBLE CORRECTION\nKeep the same task and every valid prior decision. Correct only the rejected structure, then return one complete JSON value matching the original schema with no prose.\n\nPREVIOUS INVALID OUTPUT\n${invalidOutput}`;
        }
      }
      throw new OpenCodeRuntimeError("schema", `${input.node} returned no structured output`, { sessionId, usage, ...(tools.length ? { tools } : {}), retryable: false });
    } catch (error) {
      const failure = runtimeError(error, "semantic", { sessionId, usage, ...(tools.length ? { tools } : {}), ...(progressText ? { progressText } : {}) });
      this.options.onEvent?.({ node: input.node, status: this.options.signal.aborted ? "interrupted" : "failed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: failure.progressText ?? failure.message, state: input.state, sessionId, ...(failure.usage ? { usage: failure.usage } : {}) });
      throw failure;
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
    let started = false;
    let transportFailures = 0;
    let lastMessages: Array<{ info: { id?: string; role: string; finish?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }; error?: unknown }; parts: Part[] }> = [];
    const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(inactivityTimeoutMs / 4)));
    while (true) {
      if (this.options.signal.aborted) {
        const partialUsage = subtractUsage(sessionUsage(lastMessages), baselineUsage);
        const partialTools = newToolTraces(lastMessages, baselinePartIds);
        throw runtimeError(this.options.signal.reason ?? new Error("LangGraph run aborted"), "semantic", { sessionId, usage: addUsage(priorUsage, partialUsage), ...(partialTools.length ? { tools: partialTools } : {}), ...(lastProgress ? { progressText: lastProgress } : {}), retryable: false });
      }
      let status: Awaited<ReturnType<typeof this.options.plugin.client.session.status>>;
      let messages: Awaited<ReturnType<typeof this.options.plugin.client.session.messages>>;
      try {
        status = await this.options.plugin.client.session.status({ query: { directory }, throwOnError: true });
        messages = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory }, throwOnError: true });
        transportFailures = 0;
      } catch (error) {
        if (transportFailures++ < OPENCODE_RUNTIME_RETRY_POLICY.transport.pollRetries) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * transportFailures));
          continue;
        }
        const partialUsage = subtractUsage(sessionUsage(lastMessages), baselineUsage);
        const partialTools = newToolTraces(lastMessages, baselinePartIds);
        throw runtimeError(error, "transport", { sessionId, usage: addUsage(priorUsage, partialUsage), ...(partialTools.length ? { tools: partialTools } : {}), ...(lastProgress ? { progressText: lastProgress } : {}) });
      }
      const current = status.data[sessionId];
      lastMessages = messages.data;
      const activeTool = hasActiveTool(messages.data);
      if ((current && current.type !== "idle") || activeTool) {
        started = true;
      }
      const usage = subtractUsage(sessionUsage(messages.data), baselineUsage);
      const streaming = streamingEstimate(messages.data, inputEstimated);
      const usageFingerprint = JSON.stringify(usage);
      const streamingFingerprint = JSON.stringify(streaming) ?? "";
      const polledAt = Date.now();
      if (usageFingerprint !== lastUsage || (streamingFingerprint !== lastStreaming && polledAt - lastEstimateEmitAt >= ESTIMATE_EMIT_INTERVAL_MS)) {
        if (usageFingerprint !== lastUsage) lastActivityAt = polledAt;
        lastUsage = usageFingerprint;
        lastStreaming = streamingFingerprint;
        lastEstimateEmitAt = polledAt;
        this.options.onEvent?.({ node, status: "active", agent, model, sessionId, usage: addUsage(priorUsage, usage), ...(streaming ? { streaming } : {}) });
      }
      const fingerprint = activityFingerprint(messages.data);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        if (messages.data.some((message) => !message.info.id || !baselineMessageIds.has(message.info.id))) started = true;
        lastActivityAt = Date.now();
      }
      const assistant = [...messages.data].reverse().find((message) => message.info.role === "assistant" && (!message.info.id || !baselineMessageIds.has(message.info.id)));
      const preview = assistant ? progress(assistant.parts) : "";
      if (preview && preview !== lastProgress) {
        lastProgress = preview;
        this.options.onEvent?.({ node, status: "active", agent, model, text: preview, sessionId });
      }
      if ((!current || current.type === "idle") && !activeTool) {
        if (assistant?.info.role === "assistant" && assistant.info.error) {
          const traces = newToolTraces(messages.data, baselinePartIds);
          throw new OpenCodeRuntimeError("semantic", `OpenCode agent failed: ${JSON.stringify(assistant.info.error)}`, { sessionId, usage: addUsage(priorUsage, usage), ...(traces.length ? { tools: traces } : {}), ...(lastProgress ? { progressText: lastProgress } : {}), retryable: false });
        }
        const output = assistant ? text(assistant.parts) : "";
        const structured = assistant?.info.role === "assistant" ? (assistant.info as typeof assistant.info & { structured?: unknown }).structured : undefined;
        if (output || structured !== undefined) {
          const tools = newToolTraces(messages.data, baselinePartIds);
          return { text: output || JSON.stringify(structured), ...(structured !== undefined ? { structured } : {}), ...(tools.length ? { tools } : {}), ...(usage.turns ? { usage } : {}) };
        }
      }
      const now = Date.now();
      const budgetStop = exceededBudget(usage, latestContextTokens(messages.data), limits);
      if (budgetStop) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
        const tools = newToolTraces(messages.data, baselinePartIds);
        return { text: "", usage, budgetStop, ...(tools.length ? { tools } : {}) };
      }
      if (now - startedAt >= maxRuntimeMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
        const traces = newToolTraces(messages.data, baselinePartIds);
        throw new OpenCodeRuntimeError("inactivity", `OpenCode session ${sessionId} exceeded its ${maxRuntimeMs}ms maximum runtime`, { sessionId, usage: addUsage(priorUsage, usage), ...(traces.length ? { tools: traces } : {}), ...(lastProgress ? { progressText: lastProgress } : {}), retryable: false });
      }
      if (now - lastActivityAt >= inactivityTimeoutMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
        const traces = newToolTraces(messages.data, baselinePartIds);
        const kind = started ? "inactivity" : "startup";
        const message = started ? `OpenCode session ${sessionId} was inactive for ${inactivityTimeoutMs}ms` : `OpenCode session ${sessionId} did not start within ${inactivityTimeoutMs}ms`;
        throw new OpenCodeRuntimeError(kind, message, { sessionId, usage: addUsage(priorUsage, usage), ...(traces.length ? { tools: traces } : {}), ...(lastProgress ? { progressText: lastProgress } : {}), retryable: true });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
