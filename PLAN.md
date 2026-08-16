# OpenCode LangGraph connector architecture

`opencode-langgraph` is an explicit LangGraph–OpenCode connector, not a standalone coding TUI. Its built-in production workflow is `progressive-lod`.

## Ownership

- OpenCode owns chat, provider authentication, model selection, permissions, questions, child sessions, transcript rendering, diffs, and terminal interaction.
- LangGraph owns orchestration state, routing, retries, plan refinement, checkpoints, and interrupts.
- The connector maps between the two and adds graph validation and visualization.

## Connection

The connector starts a graph from `graph:on` messages or `/run-graph`; the root model has no orchestration tools. An agent-backed node creates, continues, or forks an OpenCode child session as explicitly requested by the graph. Typed graph state—not a replayed transcript—is the cross-role contract. One production role registry owns role prompts, models, tools, and defaults; the graph supplies role-specific typed payloads only. Bounded changes skip planning, while uncertain work keeps scouting branch-local and makes each detail decision in a fresh tool-free session. Implementation leaves remain isolated, and repair continues only the failed leaf session.

External CLIs use the command model backend: prompt on stdin, answer on stdout, logs on stderr, graph worktree as cwd, and abort propagation.

LangGraph `interrupt()` pauses the graph in an atomic per-thread durable checkpointer. The next root user message or `/graph-resume` resumes the same run through `Command.resume`. The connector resolves the session's current run internally; models never inspect persistence files or supply storage paths.

## Configuration

`.opencode/langgraph.ts` exports `defineOpenCodeLangGraph(...)`. It may select `{ preset: "progressive-lod" }` or connect arbitrary compiled LangGraph instances with initial, result, and optional semantic-progress projections.

## Validation

LangGraph compilation remains authoritative for graph structure. The connector adds reference validation, command resolution, required checkpointer presence, and a reverse-reachability check proving every declared node has a possible path to `END`.

## UI

The TUI plugin uses OpenCode's public slot, route, command-palette, theme, renderer, and scrollbox APIs. The sidebar shows current semantic state. `/graph` opens the plan tree first, with topology, executions, output, and raw state available from header key hints.
