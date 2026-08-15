import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { progressiveLodGraph } from "./progressive-lod/graph.js";
import type { AgentDefinition, CommandModel, ConnectorConfig, ConnectorDefinition, ConnectorGraph, ConnectorPresetConfig, OpenCodeModel } from "./types.js";

export const typedConfigFile = path.join(".opencode", "langgraph.ts");

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

export async function loadConnectorDefinition(repo: string): Promise<ConnectorDefinition> {
  const file = path.join(repo, typedConfigFile);
  if (!fs.existsSync(file)) return progressiveLodPresetDefinition();
  const coreEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "opencode-langgraph": coreEntry } });
  const config = await jiti.import<ConnectorConfig>(file, { default: true });
  return "preset" in config ? presetDefinition(config.preset) : config;
}

function presetDefinition(preset: ConnectorPresetConfig["preset"]): ConnectorDefinition {
  if (preset === "progressive-lod") return progressiveLodPresetDefinition();
  throw new Error(`Unknown LangGraph connector preset: ${String(preset)}. Version 0.5 uses progressive-lod.`);
}

function progressiveLodPresetDefinition(): ConnectorDefinition {
  return {
    version: 1,
    models: { current: opencodeModel({ model: "inherit" }) },
    agents: {
      analyst: { model: "current", opencodeAgent: "plan", systemPrompt: "Ground every planning and verification claim in repository evidence. Produce exact structured output when requested.", tools: { read: true, grep: true, glob: true, edit: false, write: false, question: false } },
      implementer: { model: "current", opencodeAgent: "build", systemPrompt: "Implement the complete bounded plan in the current worktree and verify your edits. Preserve unrelated user work.", tools: { question: false } },
    },
    graphs: { "progressive-lod": progressiveLodGraph({ analystAgent: "analyst", implementerAgent: "implementer" }) },
    defaultGraph: "progressive-lod",
  };
}

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
  preset: "progressive-lod",
});
`;
}

export type { AgentDefinition, ConnectorConfig, ConnectorDefinition, ConnectorGraph } from "./types.js";
