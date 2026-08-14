import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { progressiveCoolingGraph } from "./preset.js";
import type { AgentDefinition, CommandModel, ConnectorConfig, ConnectorDefinition, ConnectorGraph, ConnectorPresetConfig, NeolitDefinition, NeolitGraph, OpenCodeModel } from "./types.js";

export const typedConfigFile = path.join(".opencode", "langgraph.ts");
export const legacyTypedConfigFile = path.join(".neolit", "neolit.config.ts");

export function opencodeModel(input: Omit<OpenCodeModel, "backend">): OpenCodeModel {
  return { backend: "opencode", ...input };
}

export function commandModel(input: Omit<CommandModel, "backend">): CommandModel {
  return { backend: "command", ...input };
}

export function defineGraph<State extends Record<string, unknown>>(graph: ConnectorGraph<State>): ConnectorGraph<State> {
  return graph;
}

export function defineOpenCodeLangGraph<const Config extends ConnectorConfig>(config: Config): Config {
  return config;
}

/** @deprecated Use defineOpenCodeLangGraph. */
export function defineNeolit<const Definition extends NeolitDefinition>(definition: Definition): Definition {
  return definition;
}

export async function loadConnectorDefinition(repo: string): Promise<ConnectorDefinition> {
  const primary = path.join(repo, typedConfigFile);
  const legacy = path.join(repo, legacyTypedConfigFile);
  const file = fs.existsSync(primary) ? primary : fs.existsSync(legacy) ? legacy : undefined;
  if (!file) return neolitPresetDefinition();
  const coreEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "opencode-langgraph": coreEntry, neolit: coreEntry } });
  const config = await jiti.import<ConnectorConfig>(file, { default: true });
  return "preset" in config ? presetDefinition(config.preset) : config;
}

/** @deprecated Use loadConnectorDefinition. */
export const loadNeolitDefinition = loadConnectorDefinition;

function presetDefinition(preset: ConnectorPresetConfig["preset"]): ConnectorDefinition {
  if (preset === "neolit") return neolitPresetDefinition();
  throw new Error(`Unknown LangGraph connector preset: ${preset}`);
}

export function neolitPresetDefinition(): ConnectorDefinition {
  return {
    version: 1,
    models: { current: opencodeModel({ model: "inherit" }) },
    agents: {
      context: { model: "current", opencodeAgent: "explore", systemPrompt: "Build repository-grounded context for downstream agents.", tools: { read: true, grep: true, glob: true, edit: false, write: false, question: false } },
      planner: { model: "current", opencodeAgent: "plan", systemPrompt: "Make grounded, minimal, decision-complete plans.", tools: { read: true, grep: true, glob: true, edit: false, write: false, question: false } },
      implementer: { model: "current", opencodeAgent: "build", systemPrompt: "Implement the approved task and verify the result.", tools: { question: false } },
    },
    graphs: { default: progressiveCoolingGraph({ contextAgent: "context", plannerAgent: "planner", implementerAgent: "implementer" }) },
    defaultGraph: "default",
  };
}

/** @deprecated Use neolitPresetDefinition. */
export const defaultNeolitDefinition = neolitPresetDefinition;

export function writeConnectorConfig(repo: string): string {
  const file = path.join(repo, typedConfigFile);
  if (fs.existsSync(file)) throw new Error(`${typedConfigFile} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, defaultConnectorConfigSource());
  return file;
}

export function defaultConnectorConfigSource(importFrom = "opencode-langgraph"): string {
  return `import { defineOpenCodeLangGraph } from ${JSON.stringify(importFrom)};

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "neolit",
});
`;
}

/** @deprecated Use writeConnectorConfig. */
export const writeNeolitConfig = writeConnectorConfig;
/** @deprecated Use defaultConnectorConfigSource. */
export const defaultNeolitConfigSource = defaultConnectorConfigSource;

export type { AgentDefinition, ConnectorConfig, ConnectorDefinition, ConnectorGraph, NeolitDefinition, NeolitGraph } from "./types.js";
