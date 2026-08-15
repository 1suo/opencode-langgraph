import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { progressiveLodGraph } from "./progressive-lod/graph.js";
import type { AgentDefinition, CommandModel, ConnectorConfig, ConnectorDefinition, ConnectorGraph, ConnectorPresetConfig, OpenCodeModel, ProgressiveLodPresetOptions, ProgressivePresetRole } from "./types.js";
import { DEFAULT_ROLE_LIMITS } from "./progressive-lod/types.js";

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
  const defaults: Record<ProgressivePresetRole, "inherit" | `${string}/${string}`> = {
    classifier: "deepseek/deepseek-v4-flash", scout: "deepseek/deepseek-v4-flash", decider: "inherit", answer: "deepseek/deepseek-v4-flash",
    implementer: "inherit", verifier: "inherit", repair: "inherit",
  };
  const modelName = (role: ProgressivePresetRole) => `${role}-model`;
  const models = Object.fromEntries((Object.keys(defaults) as ProgressivePresetRole[]).map((role) => [modelName(role), opencodeModel({ model: options.models?.[role] ?? defaults[role] })]));
  const turns = (role: Exclude<ProgressivePresetRole, "answer">) => options.roleLimits?.[role]?.maxTurns ?? DEFAULT_ROLE_LIMITS[role].maxTurns;
  return {
    version: 1,
    models,
    agents: {
      classifier: { model: modelName("classifier"), opencodeAgent: "plan", systemPrompt: "Classify the supplied request directly. Do not inspect the repository or call tools. Produce exact structured output.", tools: { read: false, grep: false, glob: false, bash: false, edit: false, write: false, question: false, task: false, webfetch: false, websearch: false }, maxSteps: turns("classifier") },
      scout: { model: modelName("scout"), opencodeAgent: "plan", systemPrompt: "Inspect only the active branch and return concise repository evidence. Do not design, decompose, or edit.", tools: { read: true, grep: true, glob: true, bash: true, edit: false, write: false, question: false, task: false, webfetch: false, websearch: false }, maxSteps: turns("scout") },
      decider: { model: modelName("decider"), opencodeAgent: "plan", systemPrompt: "Make one planning disposition from supplied typed evidence. Do not inspect the repository or call tools.", tools: { read: false, grep: false, glob: false, bash: false, edit: false, write: false, question: false, task: false, webfetch: false, websearch: false }, maxSteps: turns("decider") },
      answer: { model: modelName("answer"), opencodeAgent: "plan", systemPrompt: "Answer accurately from the request and repository evidence when needed.", tools: { read: true, grep: true, glob: true, edit: false, write: false, question: false }, maxSteps: 24 },
      verifier: { model: modelName("verifier"), opencodeAgent: "plan", systemPrompt: "Verify the actual worktree once against all implemented leaf contracts. Do not edit files. Produce exact structured output.", tools: { read: true, grep: true, glob: true, bash: true, edit: false, write: false, question: false, task: false }, maxSteps: turns("verifier") },
      implementer: { model: modelName("implementer"), opencodeAgent: "build", systemPrompt: "Implement exactly one cohesive leaf and verify its focused acceptance criteria. Preserve unrelated user work.", tools: { question: false, task: false }, maxSteps: turns("implementer") },
      repair: { model: modelName("repair"), opencodeAgent: "build", systemPrompt: "Repair exactly one previously implemented leaf from verifier findings and rerun its focused checks.", tools: { question: false, task: false }, maxSteps: turns("repair") },
    },
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
