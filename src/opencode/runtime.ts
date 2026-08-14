import { spawn } from "node:child_process";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { AgentCall, AgentCallResult, AgentRuntime, ConnectorDefinition } from "../core/types.js";
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
  onEvent?: (event: { node: string; status: string; agent: string; model: string; text?: string; state?: Record<string, unknown>; sessionId?: string }) => void;
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
    this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: agent.model, state: input.state });
    if (model.backend === "command") {
      const output = await commandCall(model.command, model.args ?? [], model.env, this.options.worktree, `${agent.systemPrompt}\n\n${input.prompt}`, this.options.signal);
      if (!output) throw new Error(`Command agent ${input.agent} returned no output`);
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: agent.model, text: output, state: input.state });
      return { text: output };
    }
    const selected = model.model === "inherit" ? this.options.parentModel : modelId(model.model);
    if (!selected) throw new Error(`Agent ${input.agent} inherits a model, but the parent OpenCode message did not provide one`);
    const created = await this.options.plugin.client.session.create({
      body: { parentID: this.options.parentSessionId, title: `LangGraph · ${input.node} · ${input.agent}` },
      query: { directory: this.options.directory },
      throwOnError: true,
    });
    const sessionId = created.data.id;
    this.options.onEvent?.({ node: input.node, status: "active", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, state: input.state, sessionId });
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
      await this.options.plugin.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: this.options.directory },
        body: {
          agent: agent.opencodeAgent,
          model: selected,
          system: agent.systemPrompt,
          tools: agent.tools,
          parts: [{ type: "text", text: input.prompt }],
        },
        throwOnError: true,
      });
      const output = await this.waitForAnswer(sessionId, input.node, input.agent, `${selected.providerID}/${selected.modelID}`);
      this.options.onEvent?.({ node: input.node, status: "completed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: output, state: input.state, sessionId });
      return { text: output, sessionId };
    } catch (error) {
      this.options.onEvent?.({ node: input.node, status: this.options.signal.aborted ? "interrupted" : "failed", agent: input.agent, model: `${selected.providerID}/${selected.modelID}`, text: error instanceof Error ? error.message : String(error), state: input.state, sessionId });
      throw error;
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      unregisterPermission();
    }
  }

  private async waitForAnswer(sessionId: string, node: string, agent: string, model: string): Promise<string> {
    const deadline = Date.now() + 90_000;
    let lastProgress = "";
    while (Date.now() < deadline) {
      if (this.options.signal.aborted) throw this.options.signal.reason ?? new Error("LangGraph run aborted");
      const status = await this.options.plugin.client.session.status({ query: { directory: this.options.directory }, throwOnError: true });
      const current = status.data[sessionId];
      if (!current || current.type === "idle") {
        const messages = await this.options.plugin.client.session.messages({ path: { id: sessionId }, query: { directory: this.options.directory }, throwOnError: true });
        const assistant = [...messages.data].reverse().find((message) => message.info.role === "assistant");
        if (assistant?.info.role === "assistant" && assistant.info.error) throw new Error(`OpenCode agent failed: ${JSON.stringify(assistant.info.error)}`);
        const output = assistant ? text(assistant.parts) : "";
        if (output) return output;
        const preview = assistant ? progress(assistant.parts) : "";
        if (preview && preview !== lastProgress) {
          lastProgress = preview;
          this.options.onEvent?.({ node, status: "active", agent, model, text: preview, sessionId });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.options.plugin.client.session.abort({ path: { id: sessionId }, query: { directory: this.options.directory } });
    throw new Error(`OpenCode session ${sessionId} timed out`);
  }
}
