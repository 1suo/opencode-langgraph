# Progressive LOD graph — production specification

Status: normative for `opencode-langgraph` 0.5.x.

## 1. Purpose

The default graph turns an OpenCode user message into a repository-grounded result. It spends inference according to task scope, progressively refines only the active plan branch, makes state mutations deterministic, implements bounded leaves in dependency order, and verifies the actual result.

The graph is not a general autonomous manager. OpenCode owns chat, models, tools, permissions, and child sessions. LangGraph owns orchestration, checkpoints, interrupts, and resume. The connector maps between them.

## 2. Invariants

1. `originalTask` is immutable.
2. Model output never mutates plan state directly. It crosses a JSON Schema boundary and is validated with Zod; deterministic code applies it.
3. Repository claims cite evidence. Inferences are labeled and carry confidence.
4. Only the active branch is projected into an analysis prompt. Global constraints and relevant dependencies remain visible.
5. Stable plan IDs are assigned by the merge reducer, never by a model.
6. Dependency and hierarchy cycles are rejected.
7. A node is implementable only when it describes a bounded file/symbol-sized change and a verification target.
8. Human input uses LangGraph `interrupt()`, not a child agent's question tool.
9. Read-only requests do not acquire a worktree lease. Change workflows are serialized per canonical worktree.
10. Every loop is bounded by calls, nodes, context cycles, reopen attempts, repairs, and elapsed time.

## 3. Levels of detail

| LOD | Name | Required decision |
|---:|---|---|
| 0 | intent | Outcome, scope, direction, and definition of done |
| 1 | architecture | Ownership boundaries and system contracts |
| 2 | components | Components, interfaces, dependencies, and test surfaces |
| 3 | changes | File/symbol-sized edits with verification |

A small local task may descend quickly, but it still must produce grounded, implementable leaves. An architectural task should not jump from intent to an unbounded implementation prompt.

## 4. State contract

The checkpointed state remains compact and JSON-serializable:

```ts
interface ProgressiveLodState {
  runId: string
  originalTask: string
  directory: string
  worktree: string
  phase: string
  profile?: TaskProfile
  lods: LodDefinition[]
  budget: Budget
  plan: PlanNode[]
  activeNodeId?: string
  evidence: Evidence[]
  constraints: Constraint[]
  analysis?: AnalysisOutput
  discoveries: string[]
  callsUsed: number
  nextId: number
  startedAt: number
  repairAttempts: number
  humanQuestion: string
  humanAnswer: string
  implementation: string
  verification?: VerificationOutput
  result: string
}
```

`PlanNode` is a flat durable representation of a tree:

```ts
interface PlanNode {
  id: string
  parentId?: string
  title: string
  description: string
  lod: 0 | 1 | 2 | 3
  status: "pending" | "active" | "ready" | "implementing" |
          "verified" | "failed" | "removed"
  dependencies: string[]
  files: string[]
  evidenceIds: string[]
  confidence: number
  contextCycles: number
  reopenCount: number
}
```

Evidence has a stable ID, claim, source, kind, and confidence. Constraints have a stable ID, text, and source. Large tool transcripts stay in OpenCode child sessions or artifacts; state keeps citations and summaries.

## 5. Structured inference boundary

Three decisions are schema-constrained:

- classification: route, scope, summary, read-only flag, risks;
- analysis: evidence, constraints, candidate refinements, and evaluation;
- verification: pass/fail, checks, failed leaves, repairability, and architectural mismatch.

OpenCode-backed and command-backed agents receive the JSON Schema as a portable prompt contract and must return JSON. When a runtime provides a native structured value the connector consumes it directly; otherwise it parses assistant text. Both paths are validated with Zod. Invalid output fails the node visibly; it is never partially merged.

Completed tool traces may record tool, status, title, input, output, error, and metadata. These traces support observability but do not become plan truth without explicit evidence entries.

## 6. Candidate evaluation and merge

Analysis returns one candidate when the next step is mechanical and multiple candidates when a material choice exists. Candidate count is capped by scope.

The evaluator reports a selected candidate, confidence, missing-context state, and any irreducible human question. The reducer then:

1. accepts refinements common to all candidates when present;
2. otherwise accepts the selected candidate;
3. assigns sequential stable IDs;
4. filters unknown dependency IDs;
5. attaches newly collected evidence;
6. enforces the node budget and cycle checks;
7. selects the next dependency-ready, lowest-LOD pending node.

Supported dispositions are:

- `refine`: replace the active abstraction with a more detailed child;
- `split`: create multiple children for independent or dependent work;
- `remove`: invalidate work no longer needed;
- `reopen_parent`: return to a higher-level decision after contradictory evidence.

More-context requests may repeat analysis only up to the per-node limit. A human interrupt is reserved for consequential ambiguity that repository inspection cannot settle.

## 7. Execution flow

```text
START
  → classify
    ├─ answer → read-only agent → END
    └─ change → acquire worktree lease
         → initialize root plan
         → analyze active projection
         → deterministic merge/evaluate
           ├─ more context → analyze
           ├─ human decision → interrupt → release lease
           │                    next user message → reacquire → analyze
           ├─ next branch → analyze
           └─ implementable leaves
                → implement in topological order
                → verify actual diff/checks
                  ├─ pass → END
                  ├─ bounded repair → verify
                  ├─ architectural mismatch → reopen → analyze
                  └─ exhausted/non-repairable → failed result → END
```

Implementation receives the immutable task, constraints, and all ready leaves in dependency order. Verification uses a separate read-only agent role by default, inspects the actual worktree, and records check evidence. A report without corresponding worktree evidence is not success.

## 8. Adaptive budgets

| Scope | Calls | Plan nodes | Candidates | Context/node | Reopens | Repairs | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| local | 12 | 8 | 2 | 2 | 1 | 1 | 15 min |
| subsystem | 24 | 16 | 2 | 3 | 2 | 2 | 30 min |
| architectural / unknown | 40 | 24 | 3 | 3 | 2 | 2 | 60 min |

Two or three calls are reserved for implementation, verification, and repair. Planning stops before consuming that reserve. Hitting a budget yields the best grounded implementable plan if one exists; otherwise the run ends explicitly without claiming completion.

## 9. Persistence, concurrency, and resume

The built-in graph uses an atomic, dependency-free, per-thread file checkpointer under:

```text
$OPENCODE_LANGGRAPH_STATE_HOME/opencode-langgraph/checkpoints/
```

When the environment variable is absent, the base is `~/.local/state`. Run metadata and semantic event history live beside the database.

Change workflows use a filesystem FIFO queue keyed by the canonical worktree path. The owner file has a heartbeat; stale owners and tickets are recovered. A lease is released on completion, failure, cancellation, or human interruption. Resumed work reacquires the lease before it can modify the worktree.

Each user message normally creates a new run and is linked by `userMessageId`. If the latest run in that root OpenCode session is interrupted, the next user message is treated as its answer and resumes its checkpoint instead. `/graph-cancel` aborts an active or queued run.

## 10. Public connector API

The production surface is:

```ts
progressiveLodGraph(options)
structuredAgentNode(options)
defaultDurableCheckpointer()
defineGraph({ graph, initial, result, progress? })
```

The zero-config definition and generated config use:

```ts
{ version: 1, preset: "progressive-lod" }
```

The removed cooling preset and factory have no compatibility alias. Loading the removed preset produces a migration error.

Custom graphs remain first-class. They may use inherited OpenCode models, explicit `provider/model` selections, or command models such as Codex CLI. Authentication belongs to OpenCode or the command, not this connector.

## 11. TUI contract

The prompt legend is exactly:

```text
[F7] graph:off|{actual graph name} · [F8] view · [F9] help
```

F8 opens the semantic plan tree when progress is available. The viewer exposes:

- `1`: plan tree;
- `G`: compiled graph topology;
- `2`: node executions;
- `3`: selected execution output;
- `T`: selected execution state;
- arrows or configured navigation keys: select, pan, or scroll;
- `Tab`: cycle panes; `Esc`/`Q`: return.

Key hints belong in panel headers. There is no detached legend consuming content space. The sidebar shows the current phase, scope, inference budget, active plan node, and recent executions.

## 12. Acceptance criteria

A release is production-ready when:

1. zero-config read-only and change requests both complete with inherited OpenCode models;
2. schema-invalid decisions fail without mutating plan state;
3. deterministic merge, common-refinement acceptance, stable IDs, selection, cycles, and budget exits are unit tested;
4. durable checkpoints resume after process reconstruction;
5. concurrent change runs serialize while read-only runs do not wait;
6. interrupt releases the lease and the next user message resumes the same run;
7. verification can pass, repair, reopen, or terminate explicitly within budget;
8. F8 renders plan-first state linked to the originating OpenCode message;
9. package build, typecheck, tests, npm pack/publish, clean npm install, and a live OpenCode load all succeed.
