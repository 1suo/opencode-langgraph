import { spawn } from "node:child_process";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { AgentBudgetStop, AgentCall, AgentCallLimits, AgentCallResult, AgentPromptTrace, AgentRuntime, AgentToolTrace, AgentUsage, ConnectorDefinition } from "../core/types.js";
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
  onEvent?: (event: { node: string; status: string; agent: string; model: string; text?: string; state?: Record<string, unknown>; sessionId?: string; usage?: AgentUsage; prompt?: AgentPromptTrace }) => void;
}

function modelId(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new Error(`Invalid OpenCode model: ${value}`);
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
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
    if (state.status === "error") traces.push({ tool: part.tool, status: "error", input: state.input, error: String(state.error ?? "Tool failed") });
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
    if (model.backend === "command") {
      this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: agent.model, state: input.state, prompt: composedPrompt });
      const schemaInstruction = composedPrompt.schemaInstruction ? `\n\n${composedPrompt.schemaInstruction}` : "";
      const output = await commandCall(model.command, model.args ?? [], model.env, this.options.worktree, `${composedPrompt.system}\n\n${composedPrompt.input}${schemaInstruction}`, this.options.signal);
      if (!output) throw new Error(`Command agent ${input.agent} returned no output`);
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: agent.model, text: output, state: input.state });
      return { text: output, structured: input.schema ? parseCommandStructured(output) : undefined };
    }
    const selected = model.model === "inherit" ? this.options.parentModel : modelId(model.model);
    if (!selected) throw new Error(`Agent ${input.agent} inherits a model, but the parent OpenCode message did not provide one`);
    let sessionId: string;
    if (input.session?.strategy === "continue") {
      if (!input.session.sessionId) throw new Error(`Agent ${input.agent} requested session continuation without a session ID`);
      sessionId = input.session.sessionId;
    } else if (input.session?.strategy === "fork") {
      if (!input.session.sessionId) throw new Error(`Agent ${input.agent} requested session fork without a session ID`);
      const parent = await this.options.plugin.client.session.messages({ path: { id: input.session.sessionId }, query: { directory: this.options.directory }, throwOnError: true });
      const abortedMessage = [...parent.data].reverse().find((message) => {
        const info = message.info as typeof message.info & { error?: unknown };
        return info.role === "assistant" && Boolean(info.error);
      });
      const forked = await this.options.plugin.client.session.fork({
        path: { id: input.session.sessionId }, query: { directory: this.options.directory },
        ...(abortedMessage?.info.id ? { body: { messageID: abortedMessage.info.id } } : {}), throwOnError: true,
      });
      sessionId = forked.data.id;
    } else {
      const created = await this.options.plugin.client.session.create({
        body: { parentID: this.options.parentSessionId, title: `LangGraph · ${input.node} · ${input.agent}` },
        query: { directory: this.options.directory },
        throwOnError: true,
      });
      sessionId = created.data.id;
    }
    const reusingSession = input.session?.strategy === "continue" || input.session?.strategy === "fork";
    const before = reusingSession
      ? await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory: this.options.directory }, throwOnError: true })
      : { data: [] as Array<{ info: { id?: string; role: string; finish?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }; parts: Part[] }> };
    const baselineUsage = sessionUsage(before.data);
    const baselineMessageIds = new Set(before.data.flatMap((message) => message.info.id ? [message.info.id] : []));
    const baselinePartIds = new Set(before.data.flatMap((message) => message.parts.map((part) => part.id)));
    this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, state: input.state, sessionId, prompt: composedPrompt });
    const abort = () => { void this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory: this.options.directory } }); };
    const unregisterPermission = registerPermissionHandler(sessionId, async (permission) => {
      const patterns = Array.isArray(permission.pattern) ? permission.pattern : permission.pattern ? [permission.pattern] : ["*"];
      try {
        if (!this.options.ask) throw new Error("No root permission bridge is available");
        await this.options.ask({ permission: permission.type, patterns, always: patterns, metadata: { title: permission.title, childSessionId: sessionId, ...permission.metadata } });
        await this.options.plugin.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permission.id }, query: { directory: this.options.directory }, body: { response: "once" }, throwOnError: true });
      } catch {
        await this.options.plugin.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permission.id }, query: { directory: this.options.directory }, body: { response: "reject" }, throwOnError: true });
      }
    });
    this.options.signal.addEventListener("abort", abort, { once: true });
    try {
      const schemaInstruction = composedPrompt.schemaInstruction ? `\n\n${composedPrompt.schemaInstruction}` : "";
      await this.options.plugin.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: this.options.directory },
        body: {
          agent: agent.opencodeAgent,
          model: selected,
          system: composedPrompt.system,
          tools: agent.tools,
          parts: [{ type: "text", text: `${composedPrompt.input}${schemaInstruction}` }],
        } as never,
        throwOnError: true,
      });
      const output = await this.waitForAnswer(
        sessionId, input.node, input.agent, `${selected.providerID}/${selected.modelID}`,
        agent.inactivityTimeoutMs ?? 5 * 60_000, agent.maxRuntimeMs ?? 30 * 60_000,
        { maxTurns: agent.maxSteps, ...input.limits }, baselineUsage, baselineMessageIds, baselinePartIds,
      );
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: output.text, state: input.state, sessionId, usage: output.usage });
      return { ...output, sessionId };
    } catch (error) {
      this.options.onEvent?.({ node: input.node, status: this.options.signal.aborted ? "interrupted" : "failed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: error instanceof Error ? error.message : String(error), state: input.state, sessionId });
      throw error;
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      unregisterPermission();
    }
  }

  private async waitForAnswer(sessionId: string, node: string, agent: string, model: string, inactivityTimeoutMs: number, maxRuntimeMs: number, limits: AgentCallLimits, baselineUsage: AgentUsage, baselineMessageIds: Set<string>, baselinePartIds: Set<string>): Promise<Omit<AgentCallResult, "sessionId">> {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastFingerprint = "";
    let lastProgress = "";
    let lastUsage = "";
    const pollIntervalMs = Math.min(250, Math.max(10, Math.floor(inactivityTimeoutMs / 4)));
    while (true) {
      if (this.options.signal.aborted) throw this.options.signal.reason ?? new Error("LangGraph run aborted");
      const status = await this.options.plugin.client.session.status({ query: { directory: this.options.directory }, throwOnError: true });
      const current = status.data[sessionId];
      const messages = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory: this.options.directory }, throwOnError: true });
      const usage = subtractUsage(sessionUsage(messages.data), baselineUsage);
      const usageFingerprint = JSON.stringify(usage);
      if (usageFingerprint !== lastUsage) {
        lastUsage = usageFingerprint;
        this.options.onEvent?.({ node, status: "active", agent, model, sessionId, usage });
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
          this.options.onEvent?.({ node, status: "active", agent, model, text: preview, sessionId });
        }
      }
      const now = Date.now();
      const budgetStop = exceededBudget(usage, latestContextTokens(messages.data), limits);
      if (budgetStop) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory: this.options.directory } });
        const tools = newToolTraces(messages.data, baselinePartIds);
        return { text: "", usage, budgetStop, ...(tools.length ? { tools } : {}) };
      }
      if (now - startedAt >= maxRuntimeMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory: this.options.directory } });
        throw new Error(`OpenCode session ${sessionId} exceeded its ${maxRuntimeMs}ms maximum runtime`);
      }
      if (now - lastActivityAt >= inactivityTimeoutMs) {
        await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory: this.options.directory } });
        throw new Error(`OpenCode session ${sessionId} was inactive for ${inactivityTimeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
