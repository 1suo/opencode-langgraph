import type { RunnableConfig } from "@langchain/core/runnables";
import { z, type ZodType } from "zod";
import type { AgentRuntime } from "./types.js";

export interface StructuredAgentNodeOptions<State extends Record<string, unknown>, Output> {
  node?: string;
  agent: string;
  schema: ZodType<Output>;
  prompt: string | ((state: State) => string);
  output: (value: Output, state: State) => Partial<State>;
  retries?: number;
}

export function structuredAgentNode<State extends Record<string, unknown>, Output>(options: StructuredAgentNodeOptions<State, Output>) {
  return async (state: State, config?: RunnableConfig): Promise<Partial<State>> => {
    const runtime = config?.configurable?.langgraphOpenCodeRuntime as AgentRuntime | undefined;
    if (!runtime) throw new Error("Structured agent node was invoked without an OpenCode runtime");
    const prompt = typeof options.prompt === "function" ? options.prompt(state) : options.prompt;
    const result = await runtime.call({
      agent: options.agent,
      prompt,
      node: options.node ?? options.agent,
      state,
      schema: z.toJSONSchema(options.schema) as Record<string, unknown>,
      schemaName: options.node ?? options.agent,
      retryCount: options.retries ?? 2,
    });
    let value = result.structured;
    if (value === undefined) {
      const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
      try { value = JSON.parse((fenced ?? result.text).trim()); }
      catch { throw new Error(`${options.node ?? options.agent} returned invalid JSON`); }
    }
    const parsed = options.schema.safeParse(value);
    if (!parsed.success) throw new Error(`${options.node ?? options.agent} returned invalid structured output: ${z.prettifyError(parsed.error)}`);
    return options.output(parsed.data, state);
  };
}
