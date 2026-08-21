import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { solutionLodGraph } from "./solution-lod/graph.js";
import type { AgentDefinition, CommandModel, ConnectorConfig, ConnectorDefinition, ConnectorGraph, ConnectorPresetConfig, ModelDefinition, OpenCodeModel, SolutionLodPresetOptions, SolutionPresetModel, SolutionPresetRole, SolutionRoleModelAssignments } from "./types.js";
import { DEFAULT_SOLUTION_ROLE_LIMITS } from "./solution-lod/types.js";
import { SOLUTION_ROLE_CONTRACTS } from "./solution-lod/roles.js";

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
  if (!fs.existsSync(file)) return solutionLodPresetDefinition();
  const coreEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "opencode-langgraph": coreEntry } });
  const config = await jiti.import<ConnectorConfig>(file, { default: true });
  return "preset" in config ? presetDefinition(config.preset, config.options) : config;
}

function presetDefinition(preset: ConnectorPresetConfig["preset"], options?: SolutionLodPresetOptions): ConnectorDefinition {
  if (preset === "solution-lod") return solutionLodPresetDefinition(options);
  throw new Error(`Unknown LangGraph connector preset: ${String(preset)}. Use solution-lod.`);
}

function solutionLodPresetDefinition(options: SolutionLodPresetOptions = {}): ConnectorDefinition {
  const modelName = (role: SolutionPresetRole) => `${role}-model`;
  const roles = Object.keys(SOLUTION_ROLE_CONTRACTS) as SolutionPresetRole[];
  const models = Object.fromEntries(roles.map((role) => [modelName(role), presetModel(options.models?.[role] ?? SOLUTION_ROLE_CONTRACTS[role].defaultModel)]));
  const agent = (role: SolutionPresetRole): AgentDefinition => {
    const contract = SOLUTION_ROLE_CONTRACTS[role];
    return { model: modelName(role), opencodeAgent: contract.agent, systemPrompt: contract.systemPrompt, tools: contract.tools, maxSteps: options.roleLimits?.[role]?.maxTurns ?? DEFAULT_SOLUTION_ROLE_LIMITS[role].maxTurns ?? contract.maxSteps };
  };
  return {
    version: 1,
    models,
    agents: Object.fromEntries(roles.map((role) => [role, agent(role)])),
    graphs: { "solution-lod": solutionLodGraph({ agents: { inspect: "inspect", synthesize: "synthesize", implement: "implement", verify: "verify", present: "present" }, roleLimits: options.roleLimits, maxParallelActivations: options.maxParallelActivations }) },
    defaultGraph: "solution-lod",
  };
}

function presetModel(model: SolutionPresetModel): ModelDefinition {
  return typeof model === "string" ? opencodeModel({ model }) : model;
}

/** Apply the per-session model proxy to the built-in role model entries. */
export function withSolutionRoleModelAssignments(definition: ConnectorDefinition, assignments: SolutionRoleModelAssignments | undefined): ConnectorDefinition {
  if (!assignments || !Object.keys(assignments).length) return definition;
  const models = { ...definition.models };
  for (const [role, model] of Object.entries(assignments) as Array<[SolutionPresetRole, ModelDefinition | undefined]>) {
    if (model) models[`${role}-model`] = model;
  }
  return { ...definition, models };
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
  preset: "solution-lod",
});
`;
}

export type { AgentDefinition, ConnectorConfig, ConnectorDefinition, ConnectorGraph } from "./types.js";
