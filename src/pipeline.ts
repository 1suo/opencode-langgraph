import fs from "node:fs";
import path from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";
import { accumulateContext, formatContext } from "./context.js";
import { loadConfig } from "./config.js";
import { RunEvents } from "./events.js";
import { verifyAndMergeGaps } from "./gaps.js";
import { parseJsonResponse, runAgent } from "./runner.js";
import type { Candidate, NeolitConfig, PipelineState, Route, RunPaths } from "./types.js";
import { assertOnlyFilesChanged, makePatch, snapshotTree } from "./worktree.js";
import { runValidation, safeRelativePath, writeFiles } from "./validation.js";

const emptyValidation = { ok: false, checks: [] };
const GraphState = Annotation.Root({
  runId: Annotation<string>, task: Annotation<string>, repo: Annotation<string>, worktree: Annotation<string>,
  route: Annotation<Route>, context: Annotation<PipelineState["context"]>, requirementIds: Annotation<string[]>,
  rephrasing: Annotation<string>, plan: Annotation<string>, detail: Annotation<string>,
  skeletonFiles: Annotation<Record<string, string>>, report: Annotation<string>, patch: Annotation<string>,
  attempts: Annotation<number>, validation: Annotation<PipelineState["validation"]>, error: Annotation<string>,
});

const textCandidatesSchema = z.object({ candidates: z.array(z.object({ value: z.string().min(1) })) });
const filesCandidatesSchema = z.object({ candidates: z.array(z.object({ files: z.record(z.string(), z.string()) })) });
const filesSchema = z.object({ files: z.record(z.string(), z.string()) });

export interface PipelineRuntime {
  graph: ReturnType<typeof createPipeline>["graph"];
  events: RunEvents;
  config: NeolitConfig;
  paths: RunPaths;
}

function qualifyTask(task: string): Route {
  if (/^(explain|investigate|analy[sz]e|why|find|report|describe)\b/i.test(task)) return "exploratory";
  if (/\b(replace|rename|typo|import)\b/i.test(task) && /[`"']/.test(task)) return "trivial";
  if (/\b(refactor|feature|implement|build|architecture|multi-file|pipeline)\b/i.test(task)) return "complex";
  return "simple";
}

function requirements(task: string): string[] {
  return task.split(/\n|;|\.\s+/).map((part) => part.trim()).filter(Boolean).map((_, index) => `REQ-${index + 1}`);
}

function grounded(value: string, context: PipelineState["context"]): string[] {
  const errors: string[] = [];
  const paths = [...value.matchAll(/`([^`]+\.[A-Za-z0-9]+)`/g)].map((match) => match[1]);
  const known = new Set(context.map((item) => item.path));
  for (const file of paths) if (!known.has(file)) errors.push(`Unknown contextual file: ${file}`);
  return errors;
}

async function textEvolution(stage: string, instruction: string, state: PipelineState, config: NeolitConfig, events: RunEvents, paths: RunPaths): Promise<string> {
  for (let attempt = 1; attempt <= config.retries; attempt += 1) {
    events.node(`${stage}_generate`, attempt > 1 ? "retrying" : "active", `${config.candidates} candidates, attempt ${attempt}`);
    try {
    const output = await runAgent({ role: `${stage}_generate`, cwd: state.worktree, config: config.trusted, artifacts: paths.artifacts, events,
      prompt: `${instruction}\nReturn ONLY strictly valid JSON: {"candidates":[{"value":"..."}]}. Return exactly ${config.candidates} candidates. Do not use Markdown fences; encode newlines inside strings as \\n. Do not inspect files or use tools: all allowed context is below.\nTask: ${state.task}\nRequirements: ${state.requirementIds.join(", ")}\nContext:\n${formatContext(state.context)}` });
    const parsed = textCandidatesSchema.parse(parseJsonResponse(output));
    const candidates: Candidate<string>[] = parsed.candidates.map((candidate, index) => ({ id: `${stage}-${index + 1}`, value: candidate.value, errors: grounded(candidate.value, state.context) }));
    events.node(`${stage}_generate`, "completed");
    events.node(`${stage}_filter`, "active");
    const survivors = candidates.filter((candidate) => candidate.errors.length === 0 && state.requirementIds.every((id) => candidate.value.includes(id)));
    events.node(`${stage}_filter`, survivors.length ? "completed" : "failed", `${survivors.length}/${candidates.length} survived`);
    if (!survivors.length) continue;
    events.node(`${stage}_select`, "active");
    const selectedRaw = await runAgent({ role: `${stage}_select`, cwd: state.worktree, config: config.trusted, artifacts: paths.artifacts, events,
      prompt: `Select the best candidate for fidelity, feasibility, and minimalism. Return ONLY {"selected":INDEX}.\n${JSON.stringify(survivors.map((item) => item.value))}` });
    const selected = z.object({ selected: z.number().int().min(0).max(survivors.length - 1) }).parse(parseJsonResponse(selectedRaw));
    events.node(`${stage}_select`, "completed", survivors[selected.selected].id);
    return survivors[selected.selected].value;
    } catch (error) {
      events.node(`${stage}_filter`, "failed", `Attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${stage} produced no deterministically valid candidates`);
}

async function generateFiles(stage: string, instruction: string, state: PipelineState, config: NeolitConfig, events: RunEvents, paths: RunPaths, requireGaps = false): Promise<Record<string, string>> {
  for (let attempt = 1; attempt <= config.retries; attempt += 1) {
    events.node(`${stage}_generate`, attempt > 1 ? "retrying" : "active");
    try {
    const raw = await runAgent({ role: `${stage}_generate`, cwd: state.worktree, config: config.trusted, artifacts: paths.artifacts, events,
      prompt: `${instruction}\nReturn ONLY strictly valid JSON {"candidates":[{"files":{"relative/path":"complete contents"}}]} with exactly ${config.candidates} candidates. Never use absolute paths or Markdown fences; encode file newlines as \\n. Do not inspect files or use tools: all allowed context is below.\nTask: ${state.task}\nPlan: ${state.detail || state.plan}\nContext:\n${formatContext(state.context)}` });
    const parsed = filesCandidatesSchema.parse(parseJsonResponse(raw));
    events.node(`${stage}_generate`, "completed");
    events.node(`${stage}_filter`, "active");
    const survivors = parsed.candidates.filter(({ files }) => {
      try {
        if (!Object.keys(files).length) return false;
        for (const [file, content] of Object.entries(files)) {
          safeRelativePath(state.worktree, file);
        }
        if (requireGaps && !Object.values(files).some((content) => content.includes("/*<NEOLIT:GAP:"))) return false;
        return true;
      } catch { return false; }
    });
    events.node(`${stage}_filter`, survivors.length ? "completed" : "failed", `${survivors.length}/${parsed.candidates.length} survived`);
    if (!survivors.length) continue;
    events.node(`${stage}_select`, "active");
    const selectionRaw = await runAgent({ role: `${stage}_select`, cwd: state.worktree, config: config.trusted, artifacts: paths.artifacts, events,
      prompt: `Select the smallest complete feasible file set. Return ONLY {"selected":INDEX}.\n${JSON.stringify(survivors.map((value) => Object.keys(value.files)))}` });
    const selection = z.object({ selected: z.number().int().min(0).max(survivors.length - 1) }).parse(parseJsonResponse(selectionRaw));
    events.node(`${stage}_select`, "completed");
    return survivors[selection.selected].files;
    } catch (error) {
      events.node(`${stage}_filter`, "failed", `Attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${stage} produced no valid file candidates`);
}

function createPipeline(config: NeolitConfig, events: RunEvents, paths: RunPaths) {
  const wrap = <T extends Partial<PipelineState>>(name: string, fn: (state: PipelineState) => Promise<T> | T) => async (state: PipelineState) => {
    events.node(name, "active");
    try { const result = await fn(state); events.node(name, "completed"); return result; }
    catch (error) { events.node(name, "failed", error instanceof Error ? error.message : String(error)); throw error; }
  };

  const builder = new StateGraph(GraphState)
    .addNode("qualify", wrap("qualify", (state) => {
      const route = qualifyTask(state.task);
      events.record({ type: "log", node: "qualify", message: `Route: ${route}`, data: { route } });
      return { route, requirementIds: requirements(state.task) };
    }))
    .addNode("trivial", wrap("trivial", async (state) => {
      const match = state.task.match(/replace\s+(["'`])([\s\S]+?)\1\s+with\s+(["'`])([\s\S]+?)\3\s+in\s+([\w./-]+)/i);
      if (!match) throw new Error("Trivial route requires: replace \"old\" with \"new\" in path");
      const file = safeRelativePath(state.worktree, match[5]);
      const content = fs.readFileSync(file, "utf8");
      const occurrences = content.split(match[2]).length - 1;
      if (occurrences !== 1) throw new Error(`Expected exactly one occurrence, found ${occurrences}`);
      fs.writeFileSync(file, content.replace(match[2], match[4]));
      return {};
    }))
    .addNode("simple_tests", wrap("simple_tests", async (state) => {
      const context = accumulateContext(state.worktree, state.task, config);
      const next = { ...state, context };
      const files = await generateFiles("simple_tests", "Write specific runnable failing tests for the requested change. Do not implement production behavior.", next, config, events, paths);
      writeFiles(state.worktree, files);
      return { context };
    }))
    .addNode("simple_implement", wrap("simple_implement", async (state) => {
      const files = await generateFiles("simple_implement", "Implement the smallest production change that passes the tests. Preserve existing behavior.", state, config, events, paths);
      writeFiles(state.worktree, files);
      return {};
    }))
    .addNode("accumulate_context", wrap("accumulate_context", (state) => ({ context: accumulateContext(state.worktree, state.task, config) })))
    .addNode("rephrase", wrap("rephrase", async (state) => ({ rephrasing: await textEvolution("rephrase", "Rephrase the task using only repository context. Include every requirement ID verbatim and exact file paths in backticks.", state, config, events, paths) })))
    .addNode("high_level_plan", wrap("high_level_plan", async (state) => ({ plan: await textEvolution("plan", `Create a minimal high-level implementation plan for: ${state.rephrasing}. Include every requirement ID verbatim.`, state, config, events, paths) })))
    .addNode("detailed_plan", wrap("detailed_plan", async (state) => ({ detail: await textEvolution("detail", `Expand this plan with exact changes, edge cases, and deterministic verification: ${state.plan}. Include every requirement ID verbatim.`, state, config, events, paths) })))
    .addNode("skeleton", wrap("skeleton", async (state) => ({ skeletonFiles: await generateFiles("skeleton", "Generate near-complete files. Leave only narrow implementation expressions between unique paired markers /*<NEOLIT:GAP:id>*/ and /*</NEOLIT:GAP:id>*/. Markers must remain syntactically valid.", state, config, events, paths, true) })))
    .addNode("gap_fill", wrap("gap_fill", async (state) => {
      writeFiles(state.worktree, state.skeletonFiles);
      const allowed = new Set(Object.keys(state.skeletonFiles));
      for (let attempt = 1; attempt <= config.retries; attempt += 1) {
        const before = snapshotTree(state.worktree);
        try {
          await runAgent({ role: "gap_fill", cwd: state.worktree, config: config.hostile, artifacts: paths.artifacts, events,
            prompt: "Fill only text between existing NEOLIT:GAP markers in the current worktree. Do not add, delete, rename, or edit any other bytes or files. Preserve every marker. Do not explain; edit files directly." });
          assertOnlyFilesChanged(state.worktree, before, allowed);
          for (const [file, pristine] of Object.entries(state.skeletonFiles)) {
            const full = safeRelativePath(state.worktree, file);
            fs.writeFileSync(full, verifyAndMergeGaps(pristine, fs.readFileSync(full, "utf8")));
          }
          return { attempts: attempt };
        } catch (error) {
          events.node("gap_fill", attempt === config.retries ? "failed" : "retrying", error instanceof Error ? error.message : String(error));
          writeFiles(state.worktree, state.skeletonFiles);
        }
      }
      const fallback = filesSchema.parse(parseJsonResponse(await runAgent({ role: "gap_fill_fallback", cwd: state.worktree, config: config.trusted, artifacts: paths.artifacts, events,
        prompt: `Fill only the existing gaps and return complete marked files as JSON {"files":{...}}. Preserve all bytes outside gaps.\n${JSON.stringify(state.skeletonFiles)}` })));
      for (const [file, pristine] of Object.entries(state.skeletonFiles)) {
        if (!(file in fallback.files)) throw new Error(`Fallback omitted ${file}`);
        fs.writeFileSync(safeRelativePath(state.worktree, file), verifyAndMergeGaps(pristine, fallback.files[file]));
      }
      return { attempts: config.retries + 1 };
    }))
    .addNode("explore_generate", wrap("explore_generate", async (state) => {
      const report = await textEvolution("explore", "Produce a grounded analysis. Cite repository files in backticks and include every requirement ID verbatim. Do not propose code edits as completed work.", state, config, events, paths);
      fs.writeFileSync(path.join(paths.artifacts, "report.md"), report);
      return { report };
    }))
    .addNode("validate", wrap("validate", (state) => {
      if (state.route === "exploratory") return { validation: { ok: true, checks: [{ name: "no-code-output", ok: true }] } };
      const validation = runValidation(state.worktree, config);
      events.record({ type: "validation", node: "validate", status: validation.ok ? "completed" : "failed", data: validation });
      if (!validation.ok) throw new Error("Deterministic validation failed");
      return { validation };
    }))
    .addNode("finalize", wrap("finalize", (state) => ({ patch: state.route === "exploratory" ? "" : makePatch(state.worktree, paths.patch) })))
    .addEdge(START, "qualify")
    .addConditionalEdges("qualify", (state) => state.route, { trivial: "trivial", simple: "simple_tests", complex: "accumulate_context", exploratory: "accumulate_context" })
    .addEdge("trivial", "validate").addEdge("simple_tests", "simple_implement").addEdge("simple_implement", "validate")
    .addConditionalEdges("accumulate_context", (state) => state.route === "exploratory" ? "explore_generate" : "rephrase", { explore_generate: "explore_generate", rephrase: "rephrase" })
    .addEdge("rephrase", "high_level_plan").addEdge("high_level_plan", "detailed_plan").addEdge("detailed_plan", "skeleton").addEdge("skeleton", "gap_fill").addEdge("gap_fill", "validate")
    .addEdge("explore_generate", "validate").addEdge("validate", "finalize").addEdge("finalize", END);
  const checkpointer = SqliteSaver.fromConnString(paths.checkpoint);
  return { graph: builder.compile({ checkpointer }), builder };
}

export function createRuntime(repo: string, paths: RunPaths, events = new RunEvents(path.basename(paths.root), paths.audit)): PipelineRuntime {
  const config = loadConfig(repo);
  return { ...createPipeline(config, events, paths), events, config, paths };
}

export function initialState(runId: string, task: string, repo: string, worktree: string): PipelineState {
  return { runId, task, repo, worktree, route: "simple", context: [], requirementIds: [], rephrasing: "", plan: "", detail: "", skeletonFiles: {}, report: "", patch: "", attempts: 0, validation: emptyValidation, error: "" };
}
