# OpenCode LangGraph connector architecture

`opencode-langgraph` is an explicit LangGraph–OpenCode connector, not a standalone coding TUI. Neolit is its optional progressive-cooling preset.

## Ownership

- OpenCode owns chat, provider authentication, model selection, permissions, questions, child sessions, transcript rendering, diffs, and terminal interaction.
- LangGraph owns orchestration state, routing, retries, fan-out, cooling/collapse, checkpoints, and interrupts.
- The connector maps between the two and adds graph validation and visualization.

## Connection

The OpenCode root agent calls `langgraph_run` only when graph orchestration adds value. Each agent-backed LangGraph node creates a fresh OpenCode child session linked to the root session. The node supplies the configured OpenCode agent, inherited or explicit provider/model, system prompt, tools, and task prompt. The child session's completed assistant text is written into LangGraph state. State is the only cross-node memory, keeping retries and parallel branches reproducible.

External CLIs use the command model backend: prompt on stdin, answer on stdout, logs on stderr, graph worktree as cwd, and abort propagation.

LangGraph `interrupt()` pauses the graph at a checkpointer. The shipped Bun-compatible preset resumes within the current OpenCode process; custom graphs may provide persistent storage. `langgraph_run` returns the input request to normal OpenCode chat; `langgraph_resume` continues the same thread with `Command.resume`.

## Configuration

`.opencode/langgraph.ts` exports `defineOpenCodeLangGraph(...)`. It may select `{ preset: "neolit" }` or connect arbitrary compiled LangGraph instances with an initial-state function and result projection. `.neolit/neolit.config.ts` remains a compatibility fallback.

## Validation

LangGraph compilation remains authoritative for graph structure. The connector adds reference validation, command resolution, required checkpointer presence, and a reverse-reachability check proving every declared node has a possible path to `END`.

## UI

The TUI plugin uses OpenCode's public slot, route, command-palette, theme, renderer, and scrollbox APIs. The sidebar shows current graph state. `/graph` opens the full two-axis topology and node details. Agent output stays in OpenCode child sessions and is previewed in graph nodes.
