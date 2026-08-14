import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentRuntime } from "./types.js";

export interface AgentNodeOptions<State extends Record<string, unknown>> {
  node?: string;
  agent: string;
  prompt: string | ((state: State) => string);
  output: string | ((text: string, state: State) => Partial<State>);
}

export function agentNode<State extends Record<string, unknown>>(options: AgentNodeOptions<State>) {
  return async (state: State, config?: RunnableConfig): Promise<Partial<State>> => {
    const runtime = (config?.configurable?.langgraphOpenCodeRuntime ?? config?.configurable?.neolitRuntime) as AgentRuntime | undefined;
    const node = (options.node ?? config?.configurable?.langgraphOpenCodeNode ?? config?.configurable?.neolitNode) as string | undefined;
    if (!runtime) throw new Error("LangGraph agent node was invoked without an OpenCode runtime");
    const prompt = typeof options.prompt === "function" ? options.prompt(state) : options.prompt;
    const result = await runtime.call({ agent: options.agent, prompt, node: node ?? options.agent, state });
    return typeof options.output === "function" ? options.output(result.text, state) : { [options.output]: result.text } as Partial<State>;
  };
}
