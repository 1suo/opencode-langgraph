# OpenCode LangGraph

`opencode-langgraph` is an explicit, generic connector between [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) and [OpenCode](https://opencode.ai/). OpenCode remains the chat, coding, model, permission, and child-session runtime. LangGraph owns orchestration state, routing, checkpoints, and interrupts.

It includes a production `progressive-lod` workflow, while remaining a generic connector for arbitrary user-defined graphs.

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
- `/graph-resume <answer>` explicitly resumes this session's paused run; an ordinary next message does the same automatically.
- `/graph-cancel` cancels the active or queued graph run.
- `/graph`, `F8`, or **Open latest LangGraph execution** opens the current session's viewer.
- `/graph-help` or `F9` opens the in-TUI usage and graph-design guide.

Every agent-backed graph node runs in an OpenCode child session. The production graph continues scout context down a refinement chain, forks it at a split, uses a fresh tool-free decider for each decision, and isolates every implementation leaf. Graph state is scoped to the execution; graph selection, the toggle, and run history are scoped to the OpenCode session. A home-screen selection is transferred once to the session created by the first prompt. No project initialization is required.

## Configure

Without configuration, the connector uses `preset: "progressive-lod"`. It classifies each message as an answer, a bounded direct change, or a change that needs planning. Bounded changes go straight to one implementer and independent verification; only uncertain work pays for branch-scoped scouting and tool-free detail decisions. A blocked direct change reopens into planning with its blocker instead of guessing. The production role registry is the single source for every built-in prompt, model default, OpenCode agent, tool policy, and turn default. Classifier, scout, decider, and direct-answer roles use `deepseek/deepseek-v4-flash`; verifier, implementer, and repair inherit the parent OpenCode model. Planning levels are derived from the task—none are hardcoded. Run `opencode-langgraph init` only when you want an optional `.opencode/langgraph.ts`:

```ts
import { defineOpenCodeLangGraph } from "opencode-langgraph"

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "progressive-lod",
  options: {
    models: { scout: "deepseek/deepseek-v4-flash", verifier: "inherit" },
    roleLimits: { implementer: { maxTurns: 32, maxCost: 0.08 } },
  },
})
```

All overrides are optional. `models` accepts `inherit` or `provider/model` per role. `roleLimits` define internal scheduling quanta for turns, fresh input, cache reads, live context, or cost. If a role exhausts a quantum, the controller forks the aborted child session, expands every resource allowance together, and resumes automatically. Usage is telemetry; it never creates a human budget prompt. Human interrupts are reserved for indispensable engineering decisions.

Scout has repository read/search tools but no shell. Facts retain repository/inference provenance, constraints remain branch-scoped, and dependency contracts plus grounded facts flow into implementation. Aggregate verification runs tests in a connector-owned disposable copy of the current worktree; repairs change only the real implementation session, then a fresh isolated verifier checks the result again.

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

The F8 viewer opens on a live semantic plan matrix with colored status, LOD, dependency, evidence, confidence, and contributing-agent badges. Press `G` for the controller flow, `2` for the chronological execution trace, `3` for output, `4` for that execution's fully composed system/input/schema prompt, and `T` for raw state. While live, the selected execution follows new nodes until you navigate backward. Long traces collapse independently before and after the selection; navigation hints live in panel headers.

Graph-owned start, resume, result, and failure messages use a hidden one-step presenter with every tool disabled. The normal root build agent never executes those lifecycle messages.

Run `opencode-langgraph validate` after edits and `opencode-langgraph graph` to preview the compiled topology. Restart OpenCode after changing plugin code or configuration.

API keys and tokens remain owned by OpenCode or the selected external CLI and are never stored by the connector.
