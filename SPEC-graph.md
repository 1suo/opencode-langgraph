# Progressive LOD graph — production specification

Status: normative for `opencode-langgraph` 0.6.x.

## Purpose and ownership

The default graph turns one OpenCode user message into a repository-grounded, verified result. OpenCode owns chat, models, tools, permissions, and child sessions. LangGraph owns typed orchestration state, deterministic routing, checkpoints, budgets, and interrupts.

The graph is a controller, not another general agent. It gives each role one task type and transfers only the typed context that role needs.

## Invariants

1. `originalTask` is immutable and every new root message creates a separate run.
2. Model output crosses a Zod-validated JSON Schema boundary before deterministic reducers can change plan state.
3. Repository claims have cited evidence; inference is labeled and confidence-bounded.
4. Planning levels are derived from the task. Depth is structural metadata, not a hardcoded LOD taxonomy.
5. `split` creates unresolved concerns only. It cannot manufacture implementation-ready leaves.
6. `ready` applies to exactly one active concern and requires targets, acceptance criteria, and verification commands.
7. Stable IDs, dependency resolution, node selection, cycle checks, and status transitions are controller code—not model judgment.
8. A bounded change may enter one cohesive implementation leaf directly. Otherwise implementation starts only after every live planning concern is resolved and runs leaves in dependency order.
9. Verification is one independent aggregate pass after all leaves. Repair continues only the failed leaf session; an omitted prerequisite or architectural mismatch reopens planning.
10. Only indispensable engineering decisions use LangGraph `interrupt()`. Resource allowances are internal scheduling quanta and never require user babysitting.
11. Read-only requests do not acquire a worktree lease. Change runs serialize per canonical worktree.
12. Checkpoint schema 2 is a clean 0.6 boundary. Pre-0.6 interrupted progressive runs fail with an explicit restart message; they are not guessed or migrated.

## Role separation and context

| Role | Default model | Tools | Session rule | Output |
|---|---|---|---|---|
| classifier | DeepSeek V4 Flash | none | fresh | route and task profile |
| scout | DeepSeek V4 Flash | read/search, no shell | fresh root; continue refinement; fork split | cited facts only |
| decider | DeepSeek V4 Flash | none | fresh per decision; fork automatically after an exhausted scheduling quantum | one disposition |
| implementer | inherited | build tools, no subagents | fresh per leaf | files and focused checks |
| verifier | inherited | read/search/test shell in disposable mirror | fresh aggregate pass; fork automatically after an exhausted scheduling quantum | leaf-specific verdicts |
| repair | inherited | build tools, no subagents | continue failed leaf | bounded repair artifacts |

All built-in agent and root-system contracts live together in the production role registry. Graph nodes supply typed JSON payloads only; the runtime supplies a portable JSON Schema text contract and retries malformed, truncated, or schema-invalid output in the same scoped session before state mutation. This deliberately avoids provider-specific structured-output tool modes. Each call records the system, input, and output-contract layers for F8 inspection.

The scout receives explicit unanswered questions, ancestry titles, lineage-scoped constraints, relevant compact facts with provenance, replan issues, sibling status, and dependency contracts/results. It never receives unrelated descriptions or controller bookkeeping. The decider receives that same distilled projection once; research is not duplicated beside it.

OpenCode transcripts remain in their child sessions. Durable graph state keeps normalized facts, scoped constraints, contracts, replan issues, summaries, IDs, usage totals, and child-session references. Evidence is fingerprint-deduplicated and repository grounding is derived from completed read/search traces; unsupported claims remain labeled inference. Tool transcripts and candidate trees are not copied between roles.

## Plan state

```ts
interface PlanNode {
  id: string
  parentId?: string
  title: string
  description: string
  level: string
  depth: number
  status: "pending" | "active" | "expanded" | "ready" |
          "implementing" | "implemented" | "verified" |
          "failed" | "removed"
  dependencies: string[]
  evidenceIds: string[]
  confidence: number
  contextCycles: number
  reopenCount: number
  leaf?: {
    objective: string
    targets: string[]
    acceptanceCriteria: string[]
    verification: string[]
  }
  scoutSessionId?: string
  scoutSessionMode?: "fresh" | "continue" | "fork"
}
```

The full state is versioned and JSON-serializable. It also stores task profile, budgets, evidence, constraints, concise decisions, per-role usage, implementation session IDs and results, aggregate verification, repair/reopen counters, pending interrupt data, and final result.

## Planning reducer

The tool-free decider returns a discriminated outcome containing only fields relevant to that disposition:

- `ready`: one bounded leaf and no children;
- `refine`: exactly one pending child, continuing scout context;
- `split`: at least two pending children, each forking scout context;
- `remove`: invalidate the concern;
- `reopen_parent`: discard stale descendants and revisit their parent;
- `interrupt`: ask one consequential question repository inspection cannot settle.

The reducer assigns IDs, resolves sibling dependency keys, attaches evidence, enforces capacity atomically, rejects cycles, and activates the shallowest dependency-ready pending node. Implementers receive only the request, self-contained leaf contract, relevant grounded facts and constraints, replan issues, and dependency contracts/artifacts. Reopening preserves the triggering issue while invalidating stale descendant contracts, sessions, and results. Verification receives current live contracts and artifacts; repair receives only findings for its continued leaf session. Controller code derives lifecycle summaries.

## Execution flow

```text
classify
  ├─ answer → END
  ├─ bounded change → acquire lease → implement → verify → END
  └─ planned change → acquire lease → initialize root
       → deterministic guard
       → scout active branch
       → tool-free decision
       → deterministic merge
          ├─ next concern → scout
          ├─ indispensable human decision → resume
          └─ all concerns resolved
               → implement one leaf at a time
               → one aggregate verifier
                  ├─ pass → END
                  ├─ bounded leaf repair → verify
                  ├─ wrong contract/blocker → reopen planning
                  └─ exhausted/non-repairable → failed END
```

One implementation leaf contains tightly coupled production code, focused tests, owner documentation, and required bookkeeping. Creating separate orchestration leaves for those parts is invalid unless they are genuinely independent deliverables.

## Budgets

| Scope | Calls | Nodes | Context cycles/node | Reopens | Repairs | Turns | Fresh input | Cache reads | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| local | 12 | 6 | 2 | 1 | 1 | 24 | 100k | 1m | $0.03 |
| subsystem | 24 | 12 | 3 | 2 | 2 | 48 | 250k | 3m | $0.08 |
| architectural/unknown | 40 | 16 | 3 | 2 | 2 | 80 | 500k | 6m | $0.15 |

Every role has a scheduling quantum for turns, fresh input, cache reads, and live context. The default implementer quantum is 32 turns; scout 16 with 96,000 live-context tokens; verifier and repair 12; classifier and decider 2. An idle completed answer wins over a quantum reached on its final turn. A quantum reached while still busy aborts that child call; the controller then expands all allowances for that role concern together and automatically forks the child session. Usage remains visible as telemetry and never pauses the user workflow.

The verifier's shell and tests run in a connector-owned copy of the complete visible worktree with live Git metadata excluded. The copy survives an internal verifier reschedule and is removed after a verdict, failure, or cancellation. Post-repair verification starts a fresh session and fresh copy.

The 0.5 failure baseline for the same corrective task was about 86 model turns, 200k fresh input, 10.18m cache-read tokens, and $0.209 without a verified completion. The 0.6 controller must stop or request approval before reaching that envelope. Optimization is accepted only when task quality and core flow remain intact; token reduction alone is not success.

## Configuration

```ts
export default defineOpenCodeLangGraph({
  version: 1,
  preset: "progressive-lod",
  options: {
    models: {
      scout: "deepseek/deepseek-v4-flash",
      implementer: "inherit",
    },
    roleLimits: {
      implementer: { maxTurns: 32, maxContextTokens: 96_000 },
    },
    budgets: {
      subsystem: { calls: 24, maxCost: 0.08 },
    },
  },
})
```

All options are optional. Model values are `inherit` or `provider/model`. Role limits support turns, fresh input, cache reads, live context, and cost. Scope budgets support calls, nodes, context cycles, reopen/repair counts, time, aggregate turns/tokens/cache, and cost. Arbitrary user-defined LangGraphs remain first-class.

## Persistence and UI

Checkpoints live below `$OPENCODE_LANGGRAPH_STATE_HOME/opencode-langgraph/checkpoints/`, or `~/.local/state` by default. Run metadata links every execution to its root session and originating user message. This storage is private to the connector: the connector resolves the current session's run internally, and no model receives a state-file path or needs filesystem permission. The next root message resumes only an interrupted run; otherwise it creates a new run. Root lifecycle/result rendering uses a dedicated tool-free presenter, never the normal build agent.

The prompt legend is `[F7] graph:off|{actual graph name} · [F8] view · [F9] help`. F8 opens the live semantic plan matrix; every item carries role-colored contributing-agent badges, while the execution trace remains a separate chronological view. The selected execution exposes output, effective prompt, and raw state. Status glyphs distinguish expanded (`◇`), ready (`◆`), active (`▶`), implemented (`■`), verified (`✓`), failed (`×`), and removed (`·`). Navigation hints remain in panel headers.

## Release acceptance

A production release requires typecheck and tests; reducer tests for dispositions, dependencies, projections, reopen, and budgets; an end-to-end graph test proving one leaf per implementer and one aggregate verifier; package build/pack; a clean npm install; and a live OpenCode request linked to visible TUI progress. Live usage is compared with the 0.5 baseline and reported without claiming savings that were not measured.
