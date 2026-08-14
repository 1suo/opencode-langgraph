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

Legacy `/neolit`, `/neolit-graph`, `/neolit-graph-toggle`, `neolit_run`, and `neolit_resume` aliases remain available.

## Configure

Without configuration, the connector uses `preset: "neolit"`. Run `opencode-langgraph init` only when you want an optional `.opencode/langgraph.ts`:

```ts
import { defineOpenCodeLangGraph } from "opencode-langgraph"

export default defineOpenCodeLangGraph({
  version: 1,
  preset: "neolit",
})
```

The legacy `.neolit/neolit.config.ts` path remains readable when the primary config does not exist.

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

Run `opencode-langgraph validate` after edits and `opencode-langgraph graph` to preview the compiled topology. Restart OpenCode after changing plugin code or configuration.

## Compatibility

The old `neolit` CLI binary and TypeScript names (`defineNeolit`, `NeolitDefinition`, and `NeolitGraph`) remain deprecated aliases. Existing state under `~/.local/state/neolit/opencode` is readable; new state is written under `~/.local/state/opencode-langgraph`.

API keys and tokens remain owned by OpenCode or the selected external CLI and are never stored by the connector.
