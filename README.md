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
npm pack
opencode plugin ./opencode-langgraph-0.5.9.tgz --force
```

The package exposes `opencode-langgraph/server` and `opencode-langgraph/tui`; OpenCode loads both automatically.

## Use

Each OpenCode session starts with `graph:off`. Click that indicator beside the prompt or run `/graph-toggle`; this also works on the home prompt before the first session exists. While `graph:on`, every root user message starts a fresh graph execution linked to that message.

- `/graph-select` opens a searchable TUI selector for the graph used by the current session.
- `F7` toggles graph execution on or off for the current or next session.
- `/run-graph <task>` runs one task explicitly even while `graph:off`.
- `/graph-cancel` cancels the active or queued graph run.
- `/graph`, `F8`, or **Open latest LangGraph execution** opens the current session's viewer.
- `/graph-help` or `F9` opens the in-TUI usage and graph-design guide.
- `langgraph_run` and `langgraph_resume` provide explicit model-tool control.

Every agent-backed graph node runs in an isolated OpenCode child session. Graph state is scoped to the execution; graph selection, the toggle, and run history are scoped to the OpenCode session. A home-screen selection is transferred once to the session created by the first prompt. No project initialization is required.

## Configure

Without configuration, the connector uses `preset: "progressive-lod"`. It classifies read-only requests, derives a task-specific planning hierarchy for change requests, implements grounded leaves in dependency order, and verifies or repairs the result. The four-level hierarchy in `SPEC-graph.md` is only an example; it is neither hardcoded nor configuration. Run `opencode-langgraph init` only when you want an optional `.opencode/langgraph.ts`:

```ts
import { defineOpenCodeLangGraph } from "opencode-langgraph"

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "progressive-lod",
})
```

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

Agent calls time out after five minutes without message, reasoning, or tool progress, with a separate 30-minute absolute ceiling. Optional `maxSteps` bounds completed model turns. The built-in preset uses a tool-free two-step classifier and generous role-specific ceilings; custom agents remain step-unlimited unless configured. Override these values per agent when needed.

The F8 plan header and execution view report model turns, uncached input, and cache-read tokens in addition to graph calls. Graph calls count orchestration nodes, not the model turns inside an OpenCode child session.

`model: "inherit"` uses the parent OpenCode message's model. Explicit OpenCode models use `provider/model`. Command models are also supported through `commandModel(...)`.

### Graph design contract

Users design graphs directly in `.opencode/langgraph.ts`:

1. Define typed LangGraph state with `Annotation.Root(...)`.
2. Build normal deterministic nodes, branches, loops, fan-out, and joins with `StateGraph`.
3. Use `agentNode(...)` for text output or `structuredAgentNode(...)` with a Zod schema for decisions that mutate graph state. The referenced entry in `agents` selects its model, OpenCode agent, system prompt, and tools.
4. Compile with a checkpointer. This is required for interrupts and resume.
5. Wrap the compiled graph with `defineGraph({ graph, initial, result })`. `initial` maps an OpenCode message into graph state; `result` maps final state back into the root chat.
6. Register one or more named graphs and choose `defaultGraph`. Use `/graph-select` to choose a graph per OpenCode session. `/run-graph` and `graph:on` use that selection, falling back to `defaultGraph`; `langgraph_run` can also specify a graph explicitly.

Ordinary LangGraph nodes remain ordinary code. Agent nodes are connector boundaries: each creates an isolated OpenCode child session. Structured nodes give OpenCode and command models a JSON Schema output contract, parse native structured values or JSON text, and validate with Zod before state mutation. Graph state is shared only within that execution; separate OpenCode messages create separate graph runs.

For optional anti-overengineering guidance, add `@dietrichgebert/ponytail` once to the global OpenCode plugin list and start with its `lite` mode. Do not also add the checkout-relative Ponytail path unless running from that checkout.

Use LangGraph `interrupt()` for human input instead of enabling OpenCode's `question` tool inside child agents. The next root user message automatically resumes the paused run. The built-in graph stores dependency-free, atomic per-thread checkpoints on disk; custom graphs can provide any persistent LangGraph checkpointer.

The F8 viewer opens on the semantic plan tree. Press `G` for compiled topology, `2` for node executions, `3` for output, and `T` for raw state. Navigation hints live in panel headers.

Run `opencode-langgraph validate` after edits and `opencode-langgraph graph` to preview the compiled topology. Restart OpenCode after changing plugin code or configuration.

API keys and tokens remain owned by OpenCode or the selected external CLI and are never stored by the connector.
