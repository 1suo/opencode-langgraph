# GRAPH.md — how the graph works, end to end

This document describes exactly one thing: what happens between a user message and a finished LangGraph run inside `opencode-langgraph` — entry points, static topology, state, transitions, interrupts, error handling, and lifecycle. The production graph is `solution-lod`; arbitrary user-defined graphs ride the same connector contract (see README).

## 1. Purpose

The built-in `solution-lod` graph turns one OpenCode message into either a repository-grounded answer or a verified mutation by progressively resolving a solution tree at the level of detail the task actually requires. Two orthogonal structures cooperate:

1. **The solution hierarchy** (`network`) represents the same problem at conditional levels of detail. WFC-style constraint propagation collapses candidate domains.
2. **The activation network** is sparse message passing: agents inspect, synthesize, implement, verify, or present small referenced state deltas.

The static LangGraph itself is not a pipeline of model calls — it is an engine loop that schedules those activations one at a time.

## 2. Entry points

A run can start three ways:

- **`graph:on`** — every root user message starts a fresh run linked to that message.
- **`/run-graph <task>`** — one explicit run even while `graph:off`.
- **`langgraph_start <task>`** — the agent-facing tool; returns a `runId` immediately while execution continues in the background.

Graph selection comes from the session (`/graph-select`) and falls back to `defaultGraph`; a home-screen selection is transferred once to the session created by the first prompt. Before invoking the compiled graph, the connector snapshots model assignments for resume, stores a `StoredRun` with status `running`, and enqueues on the FIFO **worktree lease** (`acquireWorktree`) so concurrent sessions mutate at most one checkout at a time; queued runs emit `__queue__` events with their position. A new run from a session with an active (`queued`/`running`/`pausing`/`paused`/`interrupted`) run is rejected until it finishes, fails, or is cancelled.

## 3. Static topology

```text
START → schedule ─┬→ acquire → activate ─→ schedule   (engine loop)
                  ├→ activate            ─→ schedule
                  └→ finish → END
```

Conditional edges out of `schedule`:

- `"finish"` when the state carries a `result` (completed or blocked);
- `"acquire"` when the next activation is a mutating `implement` and the worktree lease is not held yet;
- `"activate"` otherwise.

Every step is checkpointed under `thread_id = runId` by the durable checkpointer (`DurableFileSaver`, `$OPENCODE_LANGGRAPH_STATE_HOME` or `~/.local/state/opencode-langgraph/checkpoints`), with `recursionLimit: 512`. Display names for viewers: `schedule` = collapse, `acquire` = lease, `activate` = activate, `finish` = result.

### Node contracts

| Node | Calls a model? | Contract |
|---|---|---|
| `schedule` | never | Pure controller: propagate constraints to fixed point, ensure runnable work, pick the next queued activation, mark it `running` (and its region `implementing` for implement). Emits `{ network, activeActivationId, phase }`, or `{ phase: "completed", result }` / `{ phase: "blocked", result }`. |
| `acquire` | never | Takes the worktree lease via injected `langgraphAcquireWorktree`; returns `{ worktreeAcquired: true }`. |
| `activate` | **only node that calls a model** | Projects the activation context into a prompt, opens one isolated OpenCode child session through `runtime.call(...)`, validates structured output against the capability's Zod schema, reduces it into a network delta. Snapshots workspace status + SHA-256 hashes before/after mutating activations. |
| `finish` | never | Returns `{ result }` from final state. |

## 4. Graph state

`SolutionState` (checkpoint schema version 3):

- identity/lifecycle: `stateVersion`, `runId`, `phase`, `activeActivationId`, `startedAt`, `result`;
- environment: `originalTask` (immutable), `conversationContext`, `directory`, `worktree`, `worktreeAcquired`;
- accounting: `usage` (turns/tokens/cost telemetry and scheduling quanta — never budget gates), `callsUsed` (orchestration nodes, not child-session model turns);
- the entire solution `network`.

Initial state is produced by the graph's `initial` mapper with phase `forming-root-domain` and `initialNetwork(task)` (root region `r1`, no candidates yet).

## 5. The solution network

The `network` holds everything durable:

- **Regions** — a solution at some LOD, each declaring `objective`, `allowedVariables`, `acceptanceCriteria`, delivery kind (`change` / `answer` / mixed), status (`actionable → implementing → implemented → verified`, or `blocked`), parent link and edge kind: `refines` (same solution, finer resolution) vs `partOf` (independent deliverable). Conditional children materialize only after their parent candidate collapses.
- **Candidates** — mutually distinguishable solution families per region with statuses `possible / selected / equivalent / eliminated` (+ elimination reasons) and conditional `nextLod` definitions revealed by choosing them.
- **Constraints** — typed relations (`requires`, `excludes`, `supports`, `refutes`, `equivalent`, `acceptance`, `permission`) propagated by controller code to a fixed point (`propagateNetwork`): empty domains are detected, forced collapses performed, conditional children exposed.
- **Evidence** — facts stored once, deduplicated by fingerprint, passed by ID.
- **Activations** — capability + region + exact request + expected delta + stable context refs + sender + state revision + status; duplicates of the same capability/region/delta at the same revision are suppressed.
- **Artifacts** — observed outputs (files with pass/fail, checks) reconciled against real workspace changes.

Models propose deltas; they never mutate controller bookkeeping directly — `mergeSolutionDelta` and propagation run in `schedule`/`activate`. A synthesis delta that would leave a region with zero viable candidates and nothing selected is rejected by `validateSolutionDelta` and retried with guidance; dead regions are recovered by reopening the parent, never by empty domains.

## 6. Capabilities (agent roles)

Each activation selects one built-in capability; contracts live in `src/core/solution-lod/roles.ts` and every activation sees the full catalog with admission conditions, but cannot create sessions, choose models, invent roles, or bypass the controller:

- `inspect` — repository read/search only, no shell; returns facts that distinguish the current domain;
- `synthesize` — tool-free; proposes candidates, constraints, selections, and conditional next-LOD regions;
- `implement` — executes one collapsed actionable change region in the leased worktree;
- `verify` — checks artifacts against exact criteria and maps failures back to precise regions;
- `present` — renders the collapsed read-only answer.

Agents may queue downstream activations (e.g. inspect requests). Recovery deltas (`synthesis:*`, `contradiction:*`, `implement:*`, `verification:*`) carry the network revision, so changed bases reschedule while unchanged ones dedupe.

## 7. Transitions and phases

Each `activate` return sets the loop's next phase:

- structured success (or `answer` for present) → `propagating` → back to `schedule`;
- scheduling-quantum stop (`budgetStop`: max turns/context/inactivity reached) → `activation-deferred`: region stays actionable, work is deferred, not failed;
- throw (schema/validation/timeout) → `activation-failed`: that activation is marked `failed`;
- `schedule` emits `capability:regionId` phases while working and terminal `completed` / `blocked` phases when no runnable work remains.

Region completion: implement success records reconciled artifacts and moves `implemented`; a verifier pass completes the region as `verified`; a bounded defect returns it to `actionable`; a contradicted choice reopens only the nearest implicated region via `reopenRegion` — unrelated collapsed regions and all artifacts survive. Read-only regions complete after presentation. The run ends when every required live region is verified or has a verified answer (`finalResult` joins answers or reports implemented regions plus changed files); if no capability can produce a novel delta, the run returns a precise `blocked` result instead of looping.

## 8. Interrupts and error handling

- **Human interrupts**: graphs call LangGraph `interrupt()`; the connector stores status `interrupted`, posts the question, and the next root user message (or `/graph-resume`, or `langgraph_resume <answer>`) resumes with `Command.resume(answer)` automatically.
- **Cooperative pause**: `/graph-pause` / `langgraph_pause` sets `pausing`; the abort signal is checked between steps and the run settles at its latest durable checkpoint as `paused`. A node interrupted after external side effects may replay on resume.
- **Cancel**: `/graph-cancel` / `langgraph_cancel` marks `cancelled` (from `queued`/`running`/`pausing`/`paused`/`interrupted`); the run stays inspectable but resumable only after pruning.
- **Local failures**: invalid JSON, schema errors, timeouts, or a quantum stop fail only that activation. For implement, actual workspace mutations are reconciled and retained even when output is malformed (hash diff before/after); pre-existing dirty files stay distinct. Repeating failed work against an unchanged revision is forbidden.
- **Prune**: `langgraph_prune <regionId>` reopens the region, drops its subtree, clears stale activations and retry counters, optionally overrides objective/allowed variables/acceptance criteria, writes the network back via `updateState(..., "__start__")`, and marks the run `pruned`. Active runs are rejected.

All of inspect (`langgraph_inspect`, including `no-checkpoint-yet` before the first checkpoint), prune, and resume operate on the same durable per-thread checkpoint and survive process restarts.

## 9. Run lifecycle (stored status)

```text
queued → running → completed
                ├→ failed
                ├→ interrupted → (answer) → running …
                ├→ pausing → paused → (resume) → running …
                ├→ cancelled
                └→ (after finish/fail) pruned → (resume) → running …
```

Lifecycle messages (start/resume/result/failure) are posted by a hidden one-step presenter with every tool disabled, so the normal root build agent never executes them. `/graph` (F8) shows live semantic state: the solution LOD tree, region details, the activation/message network (`G`), and diagnostic raw views — all derived from the same latest state-bearing event.

## 10. Arbitrary user graphs

Any compiled LangGraph connects through `defineOpenCodeLangGraph({ agents, graphs, defaultGraph })` with `defineGraph({ graph, initial, result })`: `initial` maps the OpenCode message (plus optional bounded `conversationContext`) into state, `result` maps final state back into chat. `agentNode` / `structuredAgentNode` create the same isolated child-session boundaries; compiling without the built-in preset requires your own persistent checkpointer for interrupt/resume. Everything above about checkpoints, pause/cancel/resume, and lifecycle applies unchanged.
