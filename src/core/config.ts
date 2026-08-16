import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { progressiveLodGraph } from "./progressive-lod/graph.js";
import type { AgentDefinition, CommandModel, ConnectorConfig, ConnectorDefinition, ConnectorGraph, ConnectorPresetConfig, OpenCodeModel, ProgressiveLodPresetOptions, ProgressivePresetRole } from "./types.js";
import { DEFAULT_ROLE_LIMITS } from "./progressive-lod/types.js";
import { PROGRESSIVE_ROLE_CONTRACTS } from "./progressive-lod/roles.js";

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
  return "preset" in config ? presetDefinition(config.preset, config.options) : config;
}

function presetDefinition(preset: ConnectorPresetConfig["preset"], options?: ProgressiveLodPresetOptions): ConnectorDefinition {
  if (preset === "progressive-lod") return progressiveLodPresetDefinition(options);
  throw new Error(`Unknown LangGraph connector preset: ${String(preset)}. Version 0.6 uses progressive-lod.`);
}

function progressiveLodPresetDefinition(options: ProgressiveLodPresetOptions = {}): ConnectorDefinition {
  const modelName = (role: ProgressivePresetRole) => `${role}-model`;
  const roles = Object.keys(PROGRESSIVE_ROLE_CONTRACTS) as ProgressivePresetRole[];
  const models = Object.fromEntries(roles.map((role) => [modelName(role), opencodeModel({ model: options.models?.[role] ?? PROGRESSIVE_ROLE_CONTRACTS[role].defaultModel })]));
  const turns = (role: Exclude<ProgressivePresetRole, "answer">) => options.roleLimits?.[role]?.maxTurns ?? DEFAULT_ROLE_LIMITS[role].maxTurns;
  const agent = (role: ProgressivePresetRole): AgentDefinition => {
    const contract = PROGRESSIVE_ROLE_CONTRACTS[role];
    return { model: modelName(role), opencodeAgent: contract.agent, systemPrompt: contract.systemPrompt, tools: contract.tools, maxSteps: role === "answer" ? contract.maxSteps : turns(role) };
  };
  return {
    version: 1,
    models,
    agents: Object.fromEntries(roles.map((role) => [role, agent(role)])),
    graphs: { "progressive-lod": progressiveLodGraph({ classifierAgent: "classifier", scoutAgent: "scout", deciderAgent: "decider", answerAgent: "answer", verifierAgent: "verifier", implementerAgent: "implementer", repairAgent: "repair", roleLimits: options.roleLimits, budgets: options.budgets }) },
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
