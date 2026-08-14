# OpenCode LangGraph

`opencode-langgraph` is an explicit, generic connector between [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) and [OpenCode](https://opencode.ai/). OpenCode remains the chat, coding, model, permission, and child-session runtime. LangGraph owns orchestration state, routing, checkpoints, and interrupts.

Neolit is the optional built-in progressive-cooling preset. It is not required to use the connector.

## Install

```sh
npm install -g opencode-langgraph
opencode plugin opencode-langgraph
opencode
```

For local development:

```sh
npm pack
opencode plugin ./opencode-langgraph-0.4.0.tgz --force
```

The package exposes `opencode-langgraph/server` and `opencode-langgraph/tui`; OpenCode loads both automatically.

## Use

Each OpenCode session starts with `graph:off`. Click that indicator beside the prompt or run `/graph-toggle`. While `graph:on`, every root user message starts a fresh graph execution linked to that message.

- `/run-graph <task>` runs one task explicitly even while `graph:off`.
- `/graph`, `F8`, or **Open latest LangGraph execution** opens the current session's viewer.
- `langgraph_run` and `langgraph_resume` provide explicit model-tool control.

Every agent-backed graph node runs in an isolated OpenCode child session. Graph state is scoped to the execution, and the toggle and run history are scoped to the OpenCode session. No project initialization is required.

## Configure

Without configuration, the connector uses `preset: "neolit"`. Run `opencode-langgraph init` only when you want an optional `.opencode/langgraph.ts`:

```ts
import { defineOpenCodeLangGraph } from "opencode-langgraph"

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "neolit",
})
```

### Connect an arbitrary graph

Any compiled LangGraph can be connected by supplying models, agents, graphs, and a default graph:

```ts
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import {
  agentNode,
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
  .compile({ checkpointer: new MemorySaver() })

export default defineOpenCodeLangGraph({
  version: 1,
  models: { current: opencodeModel({ model: "inherit" }) },
  agents: {
    worker: {
      model: "current",
      opencodeAgent: "build",
      systemPrompt: "Complete the graph node accurately.",
      tools: { question: false },
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

`model: "inherit"` uses the parent OpenCode message's model. Explicit OpenCode models use `provider/model`. Command models are also supported through `commandModel(...)`.

### Graph design contract

Users design graphs directly in `.opencode/langgraph.ts`:

1. Define typed LangGraph state with `Annotation.Root(...)`.
2. Build normal deterministic nodes, branches, loops, fan-out, and joins with `StateGraph`.
3. Use `agentNode(...)` only where a node should execute an OpenCode agent. The referenced entry in `agents` selects its model, OpenCode agent, system prompt, and tools.
4. Compile with a checkpointer. This is required for interrupts and resume.
5. Wrap the compiled graph with `defineGraph({ graph, initial, result })`. `initial` maps an OpenCode message into graph state; `result` maps final state back into the root chat.
6. Register one or more named graphs and choose `defaultGraph`. `/run-graph` and `graph:on` use that default unless `langgraph_run` specifies another name.

Ordinary LangGraph nodes remain ordinary code. `agentNode(...)` is the connector boundary: it creates an OpenCode child session and writes the completed assistant text into the state field selected by `output`. Graph state is shared only within that execution; separate OpenCode messages create separate graph runs.

Use LangGraph `interrupt()` for human input instead of enabling OpenCode's `question` tool inside child agents. Custom graphs can provide any LangGraph-compatible persistent checkpointer when restart persistence is required.

Run `opencode-langgraph validate` after edits and `opencode-langgraph graph` to preview the compiled topology. Restart OpenCode after changing plugin code or configuration.

API keys and tokens remain owned by OpenCode or the selected external CLI and are never stored by the connector.
