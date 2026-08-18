# OpenCode LangGraph connector architecture

`opencode-langgraph` is an explicit LangGraph–OpenCode connector, not a standalone coding TUI. Its built-in production workflow is `solution-lod`.

## Ownership

- OpenCode owns chat, provider authentication, model selection, permissions, questions, child sessions, transcript rendering, diffs, and terminal interaction.
- LangGraph owns orchestration state, routing, retries, plan refinement, checkpoints, and interrupts.
- The connector maps between the two and adds graph validation and visualization.

## Connection

The connector starts a graph from `graph:on` messages or `/run-graph`; the root model has no orchestration tools. The solution hierarchy stores candidate domains at conditional levels of detail, while a separate sparse activation network invokes inspect, synthesize, implement, verify, and present capabilities. Typed state deltas—not replayed transcripts—are the cross-capability contract. WFC-style propagation collapses solution candidates and exposes only the selected family's finer variables. Implementation begins at actionable regions; verification failures reopen only the implicated region.

External CLIs use the command model backend: prompt on stdin, answer on stdout, logs on stderr, graph worktree as cwd, and abort propagation.

LangGraph `interrupt()` pauses the graph in an atomic per-thread durable checkpointer. The next root user message or `/graph-resume` resumes the same run through `Command.resume`. The connector resolves the session's current run internally; models never inspect persistence files or supply storage paths.

## Configuration

`.opencode/langgraph.ts` exports `defineOpenCodeLangGraph(...)`. It may select `{ preset: "solution-lod" }` or connect arbitrary compiled LangGraph instances with initial, result, and optional semantic-progress projections.

## Validation

LangGraph compilation remains authoritative for graph structure. The connector adds reference validation, command resolution, required checkpointer presence, and a reverse-reachability check proving every declared node has a possible path to `END`.

## Node contracts and recovery

The graph is an engine loop: `schedule` (pure) → `acquire` (lease, only before mutating work) → `activate` (the only model call) → `schedule`. Every node's output is a checkpointed state delta, so any intermediate point is a valid restart. Recovery is tool-driven and stateless-aware: `langgraph_inspect` reads the checkpoint, `langgraph_prune` reopens a region subtree (dropping only that subtree and stale retry counters), and `langgraph_resume` continues a pruned or interrupted run from the same durable thread. Prompts are projected per-activation from checkpointed state, so changing a role's `systemPrompt` or a region's scope affects only subsequent activations. Full contracts and the measured context behavior live in `SPEC-graph.md`.

## UI

The TUI plugin uses OpenCode's public slot, route, command-palette, theme, renderer, and scrollbox APIs. The sidebar shows current semantic state. `/graph` opens the solution LOD tree and selected region domain. `G` shows the separate activation network; node output, prompt, and raw state remain diagnostic.
