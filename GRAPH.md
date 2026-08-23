# GRAPH.md — The `solution-lod` Graph

This document is a detailed technical description of the built-in `solution-lod` LangGraph workflow shipped with `opencode-langgraph`. The normative behavioral contract lives in [SPEC-graph.md](SPEC-graph.md); this file describes how that contract is realized in code: topology, state, nodes, edges, scheduling, and failure semantics.

Source of truth:

| Concern | File |
|---|---|
| Graph builder, nodes, edges, context projection | `src/core/solution-lod/graph.ts` |
| Solution network state machines (scheduling, propagation, merges) | `src/core/solution-lod/reducer.ts` |
| State and delta types, Zod schemas, role limits | `src/core/solution-lod/types.ts` |
| Role contracts (agents, prompts, tools, models) | `src/core/solution-lod/roles.ts` |
| Durable file checkpointer | `src/core/durable-checkpointer.ts` |

---

## 1. Purpose

The graph turns one OpenCode root message into a repository-grounded **answer** or a **verified mutation** by progressively resolving the solution at the level of detail (LOD — level of detail) actually required by the task:

- Small questions collapse quickly to an answer.
- Large changes decompose into a tree of regions, each resolved only as finely as needed. Refinement always splits; a region is implemented only once the controller *computes* it implementable (exactly one explicit success criterion, or the depth floor).

Two structures are deliberately orthogonal:

1. **The solution hierarchy** — a tree of *regions* representing the same problem at conditional levels of detail. Candidate domains are collapsed by WFC-style (Wave Function Collapse) constraint propagation.
2. **The agent activation network** — a sparse message-passing network of *activations*. Each activation is one agent task (`inspect`, `synthesize`, `refine`, `implement`, `verify`, or `present`) that observes a projected slice of state and proposes a typed delta.

Agent routing is not WFC, and hierarchy depth is not automatically a LOD.

---

## 2. Static topology

The compiled LangGraph is a small **engine loop**, not a pipeline of model calls. Only one node ever calls a model.

```text
                        ┌──────────────────────────────────────────┐
                        │                                          │
  START ──► schedule ───┤  result set?  ──► finish ──► END         │
              │         │                                          │
              │         │  singleton implement batch               │
              │         │  and worktree not leased yet? ──► acquire│
              │         │                                          │
              │         │  otherwise: fan out the batch            │
              └─── merge ◄──── activate  (1..width parallel tasks) │
                        ^   │                                      │
                        │   └── Send("activate", task) per entry   │
                        └──────────────────────────────────────────┘
```

Node and edge inventory (from `solutionLodGraph()` in `graph.ts`):

| Node | Kind | Calls a model? | Responsibility |
|---|---|---|---|
| `schedule` | pure controller | never | Propagate the network, create any missing controller-initiated work, pick the next activation batch, or terminate/blocked |
| `acquire` | controller side effect | never | Take the worktree lease before a mutating batch (`langgraphAcquireWorktree` from config) |
| `activate` | agent boundary | **yes — the only one** | Run one activation in an isolated OpenCode child session; produce one `ActivationTaskResult` |
| `merge` | pure controller | never | Deterministically apply the finished batch's records to the network (propagation, supersession, usage accounting) |
| `finish` | pure controller | never | Derive the final result string |

Edges:

```text
START                        → schedule
schedule  (conditional)      → finish | acquire | activate   (see §4)
acquire   (conditional)      → activate                     (always, after re-dispatch)
activate                     → merge
merge                        → schedule                      (unconditional loop back)
finish                       → END
```

The loop `schedule → activate → merge → schedule` repeats until `schedule` sets a terminal `result` (phase `completed` or `blocked`), at which point the next routing goes to `finish`.

---

## 3. State

### 3.1 `SolutionLodState` (graph state, `stateVersion: 7`)

| Field | Type / reducer | Meaning |
|---|---|---|
| `stateVersion` | literal `7` | Checkpoint schema version; runs recorded under older schemas are rejected |
| `runId` | string | Run identifier |
| `originalTask` | string | The immutable original user message |
| `conversationContext` | string | Compact frame of the preceding root conversation |
| `directory` / `worktree` | string | Project directory and (leased) worktree path |
| `phase` | string | Human/UI phase label, e.g. `inspect:r3`, `batch:3`, `propagating`, `activation-deferred`, `completed`, `blocked` |
| `activeActivationId` | string \| undefined | Set only when the dispatched batch is a singleton **implement** (used to gate `acquire`) |
| `activeBatch` | `ActiveBatchEntry[]` (replace reducer) | Manifest of the currently dispatched batch: `{activationId, regionId, capability, basisRevision}` per entry |
| `network` | `SolutionNetwork` | The whole solution state (see §3.2); mutated only through reducer functions |
| `results` | `ActivationTaskResult[]` (custom reducer) | Append-only per-task log of the current batch. A task write carries exactly one record keyed by `activationId`; `merge` writes an **empty array**, which atomically clears the log |
| `usage` | `AgentUsage` | Aggregated telemetry (turns, input/output/reasoning/cache tokens, cost) — telemetry and scheduling pressure, never a user-facing budget gate |
| `callsUsed` | number | Count of applied activation records |
| `startedAt` | number | Wall-clock start |
| `result` | string | Terminal result; non-empty `result` is what routes `schedule` to `finish` |

### 3.2 `SolutionNetwork`

A single append-mostly document holding both orthogonal structures plus bookkeeping:

```ts
{
  revision,                       // monotonic; bumped on every semantic change
  nextRegionId, nextEvidenceId, nextConstraintId,
  nextActivationId, nextArtifactId,
  regions:     SolutionRegion[],
  candidates:  SolutionCandidate[],
  constraints: SolutionConstraint[],
  evidence:    SolutionEvidence[],
  activations: Activation[],
  artifacts:   SolutionArtifact[],
}
```

- **Region** (`r1`, `r2`, …): `{key, parentId?, parentCandidateId?, edge: root|refines|partOf, lod, objective, delivery: answer|change, allowedVariables, acceptanceCriteria, status, candidateIds, selectedCandidateIds, constraintIds, evidenceIds, activationIds, artifactIds, answer?, contradiction?, coveredCriteria?}`. The root region `r1` is created by `initialNetwork(task)` with status `unformed` and one queued `inspect` activation `a1`.
- **Candidate** (`r3:switch-parser` style ids): one mutually exclusive solution family within a region; status `possible | eliminated | selected` (interchangeability is derived from `equivalent` constraints, never authored), with elimination reasons, evidence references, and `stances: [{variableId, relation: requires|excludes|prefers, valueLabel}]` positioning the move on shared choices.
- **Shared choice** (`v1`, … / DecisionVariable): `{id, name (globally unique slug), ownerRegionId, seedLabels[]}` — visible only in the owner's subtree; values exist as normalized labels inside stances/bindings, no registry. The primal variable graph (edges from co-occurrence within one move's stances or one constraint) must stay an acyclic forest — enforced at merge via union-find.
- **Constraint**: hard relationship `requires | excludes | equivalent` between candidate endpoints, evidence relationship `supports | refutes` with kind-checked endpoints (`refutes`/`excludes` may also target coordinates `choiceName:option` when backed by ≥1 cited fact), plus `sourceKind: user-task|repo-evidence|model-inference`. Acceptance criteria and permissions are region policy, not constraint edges.
- **Evidence**: normalized facts deduplicated by a sha256 fingerprint of `(text, source)`; kind `repository | tool | inference | user`. Stored once, passed around by id.
- **Activation** (`a1`, `a2`, …): `{capability, regionId, request, expectedDelta, contextRefs, senderActivationId?, status: queued|running|completed|failed|superseded, basisRevision, sessionId?, error?}`.
- **Artifact** (`x1`, …): observed outputs — `file` (with path), `check` (with pass/fail), `answer`.

### 3.3 Initial state

`initial()` in `graph.ts` builds the state from the run input; the network starts as exactly one root region and one queued inspection:

```text
r1 (root, lod 0, unformed, delivery: change)
└── a1: inspect, queued — "Find repository facts needed to distinguish
    the broad solution types…"
```

---

## 4. Node contracts and routing

### 4.1 `schedule` — the controller's decision point

1. **Propagate and create work.** Calls `ensureRunnableWork(network, width)` which first runs constraint propagation to a fixed point, then — if nothing is queued — creates the next controller-initiated activation by region lifecycle (see §6): `implement`/`present` for `actionable`, `verify` for `implemented`, `refine` for `unrefined`, `synthesize` for `contradiction`, and for the unresolved frontier (`unformed`/`superposed`) it queues up to `width` `inspect`/`synthesize` activations so read-only work can fan out across siblings.
2. **Terminal outcomes.** If all live regions are `verified` (or `collapsed` with children) → `phase: "completed"` with `finalResult(state)`. If no novel delta is possible → `phase: "blocked"` with a precise reason string. Both set `result`, which routes the conditional edge to `finish`.
3. **Select the batch.** `selectActivationBatch(network, width)` orders queued activations by `(basisRevision, numeric id)`:
   - if the head is a **mutating** capability (`implement`, `verify`) → a singleton batch (mutations never run in parallel);
   - otherwise → up to `width` read-only activations (`inspect`, `synthesize`, `refine`, `present`) on **pairwise distinct regions** (`width = 1` reproduces sequential execution; default `width = 3`).
4. **Mark and manifest.** Each selected activation becomes `running`; an `implement` activation also flips its region to `implementing`. The batch manifest is written to `activeBatch`; `activeActivationId` is set only for a singleton implement batch; `phase` becomes `capability:regionId` (singleton) or `batch:N`.

### 4.2 Routing after `schedule`

```ts
state.result ? "finish"
: state.activeActivationId ? "acquire"
: dispatchBatch(state)          // one Send("activate", task) per manifest entry
```

Parallelism uses LangGraph `Send`: each `activate` task receives an `ActivationTaskInput` — a frozen **snapshot** of the state (task, conversation, paths, network) plus the activation — so parallel tasks never race on shared state. Their outputs are reconciled only in `merge`.

### 4.3 `acquire` — worktree lease

Runs before every mutating implementation singleton, including after resume. It invokes the process-local `langgraphAcquireWorktree` hook and does not persist lease ownership in the checkpoint. Routing then proceeds to `activate` via the same dispatch.

### 4.4 `activate` — the only model-calling node

Given one activation task:

1. Rebuilds a task-local `SolutionLodState` from the snapshot.
2. For `implement`, snapshots the workspace first (`git status --porcelain -z` + per-file sha256 via `statusPaths`, or the injected `langgraphSnapshotWorkspace` hook).
3. Selects the output schema by capability:
   | Capability | Zod schema |
   |---|---|
   | `inspect`, `synthesize` | `SolutionDeltaSchema` |
   | `refine` | `RefinementOutputSchema` |
   | `implement` | `ImplementationOutputSchema` |
   | `verify` | `VerificationOutputSchema` |
   | `present` | `PresentationOutputSchema` |
4. Calls `runtime.call({agent, node: "capability:regionId", state, limits, schema, validateStructured, prompt})` — one isolated OpenCode child session per activation, with the capability's role limits as the scheduling quantum and `projectActivationContext` (§7) as the prompt. `validateStructured` additionally runs controller-side semantic validation (`validateSolutionDelta`, `validateRefinementOutput`) before the output is accepted.
5. Produces exactly one `ActivationTaskResult`:
   - structured success → `outcome: "applied"` with a `networkDelta` of kind `delta | refinement | implementation | verification | presentation` (implement also records the diff of actually changed files between the two workspace snapshots);
   - scheduling-quantum stop (`budgetStop`) → `outcome: "deferred"`; the region stays actionable and the activation can be rescheduled on a new revision;
   - throw (invalid JSON, schema error, timeout) → `outcome: "error"` with the message; **actual workspace changes are still captured** in `changedFiles`.

### 4.5 `merge` — deterministic reconciliation

`applyBatchRecords(network, records)`:

1. Orders the finished records by `(basisRevision, activationId)` regardless of completion order.
2. Applies each record with the capability-specific merge (`mergeSolutionDelta`, `mergeRefinementOutput`, `completeImplementation`, `completeVerification`, `completePresentation`), or marks it `failed`.
3. Handles **failed implement** specially: retained workspace mutations are reconciled as a blocked implementation with the changed files recorded; otherwise the region returns to `actionable`.
4. **Supersession:** a record whose region vanished, whose merge throws, or which was computed against an outdated `basisRevision` and whose application lands its region in `contradiction` is rolled back and marked `superseded` — superseded outcomes never consume the retry limit.
5. Runs **one** deferred `propagateNetwork` pass for the whole batch.
6. Accumulates `usage`, increments `callsUsed` by the record count, clears `results` and `activeBatch`, and sets `phase` to `activation-failed` / `activation-deferred` / `propagating`.

Then the unconditional edge returns to `schedule`.

### 4.6 `finish`

Returns `{result}` — `state.result` if already set, otherwise `finalResult(state)`: the joined verified answers for answer regions, or a summary of verified change regions with their changed files. → `END`.

---

## 5. Capabilities and role contracts

All role contracts (OpenCode agent, system prompt, tool policy, model default, max steps) live in `roles.ts`; per-run limits default from `DEFAULT_SOLUTION_ROLE_LIMITS`:

| Capability | OpenCode agent | Tools | Default quantum (turns / context) | Produces |
|---|---|---|---|---|
| `inspect` | `langgraph-inspector` | read/grep/glob/codesearch (no shell, no edit) | 32 / 160k | Facts; promotes `unformed → superposed` |
| `synthesize` | `langgraph-synthesizer` | none | 8 / 96k | Complete candidate alternatives, constraints, a selection (never declares work ready) |
| `refine` | `langgraph-refiner` | none | 8 / 96k | Covering next-step children, each with its own criterion (no terminal outcome) |
| `implement` | `build` | edit tools (no question/task) | 32 / 160k | One computed-implementable change region |
| `verify` | `langgraph-verifier` | read tools + bash (no edit) | 16 / 96k | `pass | repair | reopen | fail` verdict with findings mapped to regions |
| `present` | `plan` | none | 4 / 48k | The rendered answer for a read-only region |

Models default to `"inherit"` (the parent OpenCode message's model) and are per-session assignable via `/graph-models` or `.opencode/langgraph.ts`.

---

## 6. Region lifecycle and scheduling policy

`RegionStatus` transitions (driven by controller code in `propagateNetwork`, `ensureRunnableWork`, and the completion reducers — models never set status directly):

```text
                 inspect                synthesize (select)        refine (split)
  unformed ────────────────► superposed ────────────────► unrefined ────────────────► actionable
     │                          │    ▲                        │                        ││
     │                          │    │ contradiction          │ refine (split)         │implement (lease)
     │                          │    └──────────────┐         ▼                        ▼
     │                          ▼                   │    collapsed (has children)  implementing
     │                     contradiction ◄──────────┘         (children solved)      implemented
     │                          │ synthesize                                          │ verify
     └──────────────────────────┘                                                     ▼
                                                                                   verified
```

Controller scheduling in `ensureRunnableWork` follows this lifecycle with priority: queued work first, then — in order — an `actionable` region gets `implement`/`present`, an `implemented` region gets `verify`, an `unrefined` region gets `refine`, a `contradiction` gets `synthesize` to re-choose, and the unresolved frontier gets up to `width` `inspect`/`synthesize` activations. Admission guards in `addActivation` enforce: `implement` only on `actionable`, `verify` only on `implemented`, `present` only on an `actionable` answer region, `refine` only on `unrefined`.

---

## 7. Context projection

`projectActivationContext(state, activation)` builds the typed JSON payload each activation actually sees. Common part: `userRequest`, `conversation`, `yourAssignment`, the region's `goal` and `successCriteria`, referenced `facts`, `relationships`, and `outputs`, plus `earlierChoices` — the collapsed ancestry of selected propositions (`lineage()` walks parents via `selectedCandidateIds`). Capability-specific additions:

| Capability | Extra fields |
|---|---|
| `inspect` | `questionToAnswer`, `mustNotChooseSolution` (true when the region delivers a change) |
| `synthesize` | `choiceToMake`, `chooseOnly` (allowed variables), `alternativesAlreadyConsidered` with plain statuses, `ifFactIsMissing` guidance |
| `refine` | `chosenApproach`, `approachToSettle`, `successCriteriaPositions`, `decideOrSplit` contract |
| `implement` | `chosenApproach`, `ifBlocked` guidance (missing fact vs. wrong choice) |
| `verify` | `chosenApproach`, `changeToCheck` |
| `present` | `answerToWrite` |

Durable facts are stored once in `evidence` and passed by id. (Known measured behavior: the projection currently forwards a region's *entire* accumulated evidence/constraint/artifact sets rather than trimming to strict references, and child regions inherit the parent's evidence ids wholesale — documented in SPEC-graph.md as deliberate follow-up territory, not a correctness bug.)

---

## 8. Constraint propagation (WFC-style)

`propagateNetwork` is the fixed-point engine over the candidate domains:

- `refutes`/`excludes` eliminate the target when the subject is active/selected; `requires` selects the target when the subject is selected; `supports` attaches evidence to a candidate; `equivalent` selects both sides of an equivalence class (computed as connected components over `equivalent` constraints) when either is selected.
- A domain with every candidate eliminated → region `contradiction`.
- Exactly one viable candidate → forced collapse ("only viable candidate").
- Multiple non-equivalent selected candidates → `contradiction` ("multiple incompatible alternatives").
- Shared-choice facts: cited refutations of `choice:option` prune requiring moves everywhere visible; committed selections bind options and prune excluding/requiring-other moves; two live commitments demanding different options surface a contradiction instead of resolving silently. Kills derive on a pure overlay (dead binders release their bindings), then constraint rules evaluate as synchronous fact-stage → commitment-stage sweeps against frozen snapshots.
- After a consistent selection: non-equivalent siblings are eliminated, `selectedCandidateIds` stabilize, and the region status becomes `collapsed` (children exist), `actionable` (controller-computed: exactly one explicit criterion, or depth floor), or `unrefined` — **selection never implies actionability**.

`validateSolutionDelta` mirrors the merge so that a delta which would eliminate every candidate with none selected is rejected *at validation time* with guidance and retried; a truly dead region is recovered by reopening the parent, not by an empty domain.

---

## 9. Terminality, refinement, and reopening

The controller — never the model — validates terminality (`validateRefinementOutput`):

- `terminal: true` requires a bounded `implementationContract` whose `coveredCriteria` address every supplied success criterion position; the contract replaces/sharpens the region's acceptance criteria and certifies the region `actionable`.
- `terminal: false` requires `children` with unique keys where each child covers at least one criterion position and the children collectively cover all positions. Children are created `unformed`, inherit the parent's evidence, and carry `edge: refines` (a later choice) or `partOf` (an independent deliverable).

Invalidation is surgical: a new synthesis selection drops the previous refinement's subtree (`purgeDescendants`) and contract; reopening a region (`reopenRegion`, used by verifier verdicts `reopen`/`fail`) does the same, resets candidates to `possible`, and clears the contradiction — while unrelated collapsed regions, all evidence, and observed artifacts survive.

---

## 10. Failure semantics

| Situation | Effect |
|---|---|
| Invalid JSON / schema / semantic validation / timeout | Activation marked `failed`; only that activation is lost — solution state remains, another novel activation may run |
| Scheduling quantum stop (`maxTurns`, context, inactivity watchdog) | `deferred`; region stays actionable; the same capability/region/`expectedDelta` signature is re-creatable on a new revision |
| Duplicate proposal (same `capability + regionId + expectedDelta` at the same revision) | Suppressed in `addActivation` |
| Repeating failed work | Capped at `MAX_ACTIVATION_RETRIES = 3` failed attempts per signature |
| Out-of-basis or landing-in-contradiction record | Rolled back and marked `superseded` (does not consume retries) |
| No capability can produce a novel delta | Run ends `blocked` with a precise reason, never a silent loop |
| Implement fails after mutating files | Workspace diff still reconciled and recorded as artifacts; region returns to `actionable` under the same contract |

---

## 11. Checkpointing, inspect/prune/resume

- The graph compiles with `DurableFileSaver` (dependency-free, atomic per-thread file checkpoints under `$OPENCODE_LANGGRAPH_STATE_HOME` or `~/.local/state/opencode-langgraph/checkpoints`), so the run survives process restarts. Every intermediate `{network, phase, …}` write is a checkpoint.
- `langgraph_inspect` reads status/phase/network without mutation; a queued run before its first checkpoint reports `no-checkpoint-yet`.
- `langgraph_prune <regionId>` (with optional `objective`/`allowedVariables`/`acceptanceCriteria` overrides) reopens a region, drops its subtree, clears stale activations/retry counters, and writes the repaired network back as node `__start__`.
- `langgraph_resume` continues from the checkpoint (`Command.resume(answer)` for `interrupted`, `invoke(null)` for `pruned`), emitting fresh events.

---

## 12. Progress, display, and configuration

- `progress(state)` produces the F8 semantic snapshot (`solution-lod-v2`): regions with LOD/viable-domain counts, candidates with statuses, constraints, evidence, activations, artifacts, usage, and phase.
- `display` maps nodes to phases for the TUI: `schedule → collapse`, `acquire → lease`, `activate → activate`, `merge → propagate`, `finish → result`.
- Options (`SolutionLodOptions`): `agents` (model per capability), `roleLimits` (per-capability scheduling quantum), `maxParallelActivations` (default `3`), `checkpointer`. Example:

```ts
export default defineOpenCodeLangGraph({
  version: 1,
  preset: "solution-lod",
  options: {
    models: { inspect: "deepseek/deepseek-v4-flash", implement: "inherit" },
    roleLimits: { inspect: { maxTurns: 32, maxContextTokens: 160_000 } },
    maxParallelActivations: 3,
  },
})
```

---

## 13. End-to-end walkthrough (mutation path)

```text
1. START → schedule: propagate; root r1 unformed → queue a1 (inspect r1) … dispatch
2. activate (inspect): agent reads the repository → SolutionDelta (evidence)
   merge: facts recorded, r1 → superposed; schedule queues synthesis
3. activate (synthesize): candidates + constraints + select
   merge: propagation collapses the domain → r1 unrefined; schedule queues refine
4. activate (refine): terminal with an implementation contract (or covering children,
   repeating 2–4 one LOD deeper per child)
   merge: r1 → actionable; schedule routes through acquire → worktree leased
5. activate (implement): bounded change under the contract; workspace snapshot diff
   merge: file/check artifacts; r1 → implemented; schedule queues verify
6. activate (verify): pass → r1 verified (repair → actionable; reopen → targeted reopen)
7. schedule: every live region verified → result = summary + changed files → finish → END
```

The read-only path is shorter: either an evidenced `resolvedAnswer` in an inspect/synthesize delta (validated to cite at least one real fact) resolves the region directly to `implemented` with an answer artifact, or `refine` certifies a terminal contract with `delivery: "answer"` and `present` renders it from the recorded facts. Either way `verify` checks the answer and the run completes with the presented answer.
