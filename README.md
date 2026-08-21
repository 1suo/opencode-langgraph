# OpenCode LangGraph

[![npm version](https://img.shields.io/npm/v/opencode-langgraph.svg)](https://www.npmjs.com/package/opencode-langgraph)

`opencode-langgraph` is an explicit, generic connector between [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) and [OpenCode](https://opencode.ai/). OpenCode remains the chat, coding, model, permission, and child-session runtime. LangGraph owns orchestration state, routing, checkpoints, and interrupts.

It includes a production `solution-lod` workflow, while remaining a generic connector for arbitrary user-defined graphs.

## Install

```sh
npm install -g opencode-langgraph
opencode plugin opencode-langgraph
opencode
```

For local development:

```sh
npm run build
opencode plugin . --force
```

The package exposes `opencode-langgraph/server` and `opencode-langgraph/tui`; OpenCode loads both automatically.

## Use

Each OpenCode session starts with `graph:off`. Click that indicator beside the prompt or run `/graph-toggle`; this also works on the home prompt before the first session exists. While `graph:on`, every root user message starts a fresh graph execution linked to that message.

- `/graph-select` opens a searchable TUI selector for the graph used by the current session.
- `F7` toggles graph execution on or off for the current or next session.
- `/run-graph <task>` runs one task explicitly even while `graph:off`.
- `/graph-pause` cooperatively stops a running graph at its latest durable checkpoint. A node interrupted after external side effects may be replayed on resume.
- `/graph-resume <answer>` explicitly resumes this session's paused run; an ordinary next message does the same automatically.
- `/graph-cancel` cancels the active or queued graph run.
- `/graph`, `F8`, or **Open latest LangGraph execution** opens the current session's viewer.
- `/graph-help` or `F9` opens the in-TUI usage and graph-design guide.

The graph viewer also provides `[N]` new run, `[Space]` pause, `[U]` resume, `[E]` repair selected region, and `[X]` cancel controls.

Agents manage runs through `langgraph_start`, `langgraph_inspect`, `langgraph_pause`, `langgraph_cancel`, `langgraph_prune`, and `langgraph_resume`. `langgraph_start` returns a `runId` immediately while execution continues in the background. Keep that ID, inspect it before acting, prune a wrong solution region before resuming, and do not invoke a nested OpenCode CLI process.

Every agent activation runs in an OpenCode child session. The production graph stores a multi-resolution solution tree separately from its activation network. Constraints collapse candidate domains; only a selected solution family exposes its conditional next-LOD regions. Inspectors, synthesizers, implementers, verifiers, and presenters exchange small referenced state deltas instead of replaying transcripts. Graph state is scoped to the execution; graph selection, the toggle, and run history are scoped to the OpenCode session. A home-screen selection is transferred once to the session created by the first prompt. No project initialization is required.

## Configure

Without configuration, the connector uses `preset: "solution-lod"`. Its solution regions carry candidate domains, constraints, evidence, acceptance criteria, and conditional next-LOD definitions. Regions can be resolved at different depths; implementation starts when a required region is actionable. The production role registry is the single source for every built-in prompt, model default, OpenCode agent, tool policy, and scheduling quantum. Every built-in role inherits the model selected for the current OpenCode chat by default—no provider is hardcoded. Run `/graph-models` to assign a different enabled OpenCode model to any role for this session (or before the first session on the home prompt). If `codex` is on `PATH`, that picker also offers Codex CLI. Assignments are stored in connector state, not in the repository, and a running graph snapshots them for resume. Run `opencode-langgraph init` only when you want an optional `.opencode/langgraph.ts`:

```ts
import { defineOpenCodeLangGraph } from "opencode-langgraph"

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "solution-lod",
  options: {
    models: { inspect: "deepseek/deepseek-v4-flash", verify: "inherit" },
    roleLimits: { implement: { maxTurns: 32, maxContextTokens: 160_000 } },
  },
})
```

All overrides are optional. `models` accepts `inherit`, `provider/model`, or a full model definition such as `commandModel({ command: "codex", args: ["exec", "--skip-git-repo-check"] })` per capability. `roleLimits` define one activation's scheduling quantum. Usage is telemetry and scheduling pressure, not a user-facing budget gate or a reason to discard state. Human interrupts are reserved for indispensable engineering decisions.

Inspect has repository read/search tools but no shell. Synthesize is tool-free. Implementation receives the collapsed ancestry, actionable region, relevant constraints/evidence, and artifacts. Verification maps failures to exact regions. Malformed output fails only its activation; actual workspace changes are reconciled and retained.

### Connect an arbitrary graph

Any compiled LangGraph can be connected by supplying models, agents, graphs, and a default graph:

```ts
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import {
  agentNode,
  defaultDurableCheckpointer,
  defineGraph,
  defineOpenCodeLangGraph,
  opencodeModel,
} from "opencode-langgraph"

const State = Annotation.Root({
  task: Annotation<string>,
  answer: Annotation<string>,
})
type State = typeof State.State

const graph = new StateGraph(State)
  .addNode("answer", agentNode<State>({
    agent: "worker",
    prompt: (state) => state.task,
    output: "answer",
  }))
  .addEdge(START, "answer")
  .addEdge("answer", END)
  .compile({ checkpointer: defaultDurableCheckpointer() })

export default defineOpenCodeLangGraph({
  version: 1,
  models: { current: opencodeModel({ model: "inherit" }) },
  agents: {
    worker: {
      model: "current",
      opencodeAgent: "build",
      systemPrompt: "Complete the graph node accurately.",
      tools: { question: false },
      inactivityTimeoutMs: 5 * 60_000,
      maxRuntimeMs: 30 * 60_000,
    },
  },
  graphs: {
    default: defineGraph({
      graph,
      initial: ({ task }) => ({ task, answer: "" }),
      result: (state) => state.answer,
    }),
  },
  defaultGraph: "default",
})
```

`initial` also receives an optional `conversationContext`: a bounded text frame of recent user and assistant turns from the root OpenCode session. Keep the current `task` authoritative; use the frame only to resolve references to earlier discussion.

Agent calls time out after five minutes without message, reasoning, or tool progress, with a separate 30-minute absolute ceiling. Optional `maxSteps` bounds completed model turns. The built-in controller treats token, context, cache-read, and cost allowances as automatically expanded scheduling quanta rather than user-facing workflow gates. Custom agents remain step-unlimited unless configured.

The F8 plan header and execution view report model turns, uncached input, and cache-read tokens in addition to graph calls. Graph calls count orchestration nodes, not the model turns inside an OpenCode child session.

`model: "inherit"` uses the parent OpenCode message's model. Explicit OpenCode models use `provider/model`. Command models are also supported through `commandModel(...)`.

### Graph design contract

Users design graphs directly in `.opencode/langgraph.ts`:

1. Define typed LangGraph state with `Annotation.Root(...)`.
2. Build normal deterministic nodes, branches, loops, fan-out, and joins with `StateGraph`.
3. Use `agentNode(...)` for text output or `structuredAgentNode(...)` with a Zod schema for decisions that mutate graph state. The referenced entry in `agents` selects its model, OpenCode agent, system prompt, and tools.
4. Compile with a checkpointer. This is required for interrupts and resume.
5. Wrap the compiled graph with `defineGraph({ graph, initial, result })`. `initial` maps an OpenCode message into graph state; `result` maps final state back into the root chat.
6. Register one or more named graphs and choose `defaultGraph`. Use `/graph-select` to choose a graph per OpenCode session. `/run-graph` and `graph:on` use that selection, falling back to `defaultGraph`.

Ordinary LangGraph nodes remain ordinary code. Agent nodes are connector boundaries: each creates an isolated OpenCode child session. Structured nodes receive a portable JSON Schema text contract; malformed, truncated, or schema-invalid output is retried in that same scoped session before state mutation. This avoids provider-specific structured-output tool modes. Graph state is shared only within that execution; separate OpenCode messages create separate graph runs.

For optional anti-overengineering guidance, add `@dietrichgebert/ponytail` once to the global OpenCode plugin list and start with its `lite` mode. Do not also add the checkout-relative Ponytail path unless running from that checkout.

Use LangGraph `interrupt()` for human input instead of enabling OpenCode's `question` tool inside child agents. The next root user message automatically resumes the paused run. The built-in graph stores dependency-free, atomic per-thread checkpoints on disk; custom graphs can provide any persistent LangGraph checkpointer. Checkpoints and run metadata are plugin-private persistence: the connector resolves the current session's run internally, and agents must never read those files.

The F8 viewer opens on the live solution LOD tree. The region pane shows its candidate domain, elimination reasons, conditional children, constraints, evidence, activations, and artifacts. Press `G` for the distinct activation/message network; output, effective prompt, and raw state remain diagnostic. Navigation hints live in panel headers.

Graph-owned start, resume, result, and failure messages use a hidden one-step presenter with every tool disabled. The normal root build agent never executes those lifecycle messages.

Run `opencode-langgraph validate` after edits and `opencode-langgraph graph` to preview the compiled topology. Restart OpenCode after changing plugin code or configuration.

API keys and tokens remain owned by OpenCode or the selected external CLI and are never stored by the connector.
