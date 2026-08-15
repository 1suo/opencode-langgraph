#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { loadConnectorDefinition, typedConfigFile, writeConnectorConfig } from "./core/config.js";
import { assertValidConnector, validateConnector } from "./core/validate.js";

function repo(value: string): string { return fs.realpathSync(value); }

const program = new Command().name("opencode-langgraph").description("Explicit LangGraph connector for OpenCode").version("0.6.2");

program.command("init").description(`create ${typedConfigFile}`).option("--repo <path>", "target repository", process.cwd()).action((options) => {
  process.stdout.write(`${writeConnectorConfig(repo(options.repo))}\n`);
});

program.command("validate").description("validate graph structure, models, agents, and commands").option("--repo <path>", "target repository", process.cwd()).option("--json").action(async (options) => {
  const root = repo(options.repo);
  const definition = await loadConnectorDefinition(root);
  const diagnostics = await validateConnector(definition);
  if (options.json) process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  else if (!diagnostics.length) process.stdout.write("LangGraph connector configuration is valid\n");
  else for (const item of diagnostics) process.stdout.write(`${item.severity.toUpperCase()} ${item.code} ${item.path}: ${item.message}\n`);
  assertValidConnector(diagnostics);
});

program.command("graph").description("print the compiled graph").option("--repo <path>", "target repository", process.cwd()).option("--name <name>").option("--format <format>", "json or mermaid", "mermaid").action(async (options) => {
  const root = repo(options.repo);
  const definition = await loadConnectorDefinition(root);
  assertValidConnector(await validateConnector(definition));
  const name = options.name ?? definition.defaultGraph;
  const configured = definition.graphs[name];
  if (!configured) throw new Error(`Unknown graph: ${name}`);
  const graph = await configured.graph.getGraphAsync();
  process.stdout.write(`${options.format === "json" ? JSON.stringify(graph.toJSON(), null, 2) : graph.drawMermaid()}\n`);
});

program.command("edit").description("open the typed LangGraph connector configuration").option("--repo <path>", "target repository", process.cwd()).action((options) => {
  const root = repo(options.repo);
  const file = path.join(root, typedConfigFile);
  if (!fs.existsSync(file)) writeConnectorConfig(root);
  const result = spawnSync(process.env.VISUAL || process.env.EDITOR || "vi", [file], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status) process.exitCode = result.status;
});

program.command("open").description("launch OpenCode; install this package first with `opencode plugin opencode-langgraph`").allowUnknownOption(true).argument("[args...]").action((args: string[]) => {
  const result = spawnSync("opencode", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status) process.exitCode = result.status;
});

await program.parseAsync();
