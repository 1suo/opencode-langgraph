import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NeolitConfig } from "./types.js";

const runnerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  model: z.string().min(1),
});

const schema = z.object({
  candidates: z.number().int().min(3).max(5).default(3),
  retries: z.number().int().min(1).max(3).default(3),
  contextFiles: z.number().int().min(1).max(200).default(40),
  contextBytes: z.number().int().min(1024).max(2_000_000).default(160_000),
  trusted: runnerSchema,
  hostile: runnerSchema,
  validation: z.array(z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) })).default([]),
});

export const defaultConfig: NeolitConfig = {
  candidates: 3,
  retries: 3,
  contextFiles: 40,
  contextBytes: 160_000,
  trusted: {
    command: "opencode",
    args: ["run", "--pure", "--format", "json"],
    model: "deepseek/deepseek-reasoner",
  },
  hostile: {
    command: "codex",
    args: ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write"],
    model: "gpt-5.6-sol",
  },
  validation: [],
};

export function loadConfig(repo: string): NeolitConfig {
  const file = path.join(repo, "neolit.config.json");
  if (!fs.existsSync(file)) return defaultConfig;
  const user = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NeolitConfig>;
  return schema.parse({ ...defaultConfig, ...user, trusted: { ...defaultConfig.trusted, ...user.trusted }, hostile: { ...defaultConfig.hostile, ...user.hostile } });
}
