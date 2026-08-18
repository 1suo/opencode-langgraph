# Solution LOD graph — production specification

Status: normative for the built-in `solution-lod` graph.

## Purpose

The package is a generic OpenCode/LangGraph connector. Its built-in graph turns one message into a repository-grounded answer or verified mutation by progressively resolving the solution at the resolution actually required by the task.

Two structures are orthogonal:

1. The solution hierarchy represents the same problem at conditional levels of detail. WFC-style constraint propagation collapses its candidate domains.
2. The agent activation network is sparse message passing. Agents inspect, synthesize, implement, verify, or present exact state deltas.

Agent routing is not WFC, and hierarchy depth is not automatically a LOD.

## LOD invariants

1. A region declares the variables permitted at its current LOD.
2. A region's candidates are mutually distinguishable solution families at that resolution.
3. Finer variables exist only as conditional definitions attached to candidates.
4. Conditional regions materialize only after their parent candidate collapses.
5. `refines` means the same solution at finer resolution; `partOf` means an independent deliverable region.
6. Different regions may remain at different LODs simultaneously.
7. Implementation begins when a required region is actionable, not at a configured depth.
8. Equivalent surviving candidates may be delegated as an implementer-local choice when no unresolved external constraint distinguishes them.
9. A contradiction reopens only the nearest implicated region. Unrelated collapsed regions and all observed artifacts survive.

## Solution state

Checkpoint schema 3 contains regions, candidates, typed constraints, normalized evidence, activations, and observed artifacts. `originalTask` is immutable and the conversation frame is linked to the originating OpenCode message.

Constraint kinds are `requires`, `excludes`, `supports`, `refutes`, `equivalent`, `acceptance`, and `permission`. Controller code propagates them to a fixed point, detects empty domains, performs forced collapse, and exposes conditional children. Models propose deltas; they do not mutate controller bookkeeping.

## Activation network

The static LangGraph is an engine loop:

```text
schedule → acquire-if-mutating → activate → merge/propagate → schedule
```

Each activation specifies a capability, region, exact request, expected delta, stable context references, optional wake condition, sender, state revision, and status. Agents may propose downstream activations. Controller code validates region and context references and suppresses the same capability/region/delta at the same state revision.

Every activation sees the complete capability catalog with each capability's admission condition and output contract. It can request a capability but cannot create sessions, choose models, invent roles, or bypass the controller. This gives agents awareness of their possible downstream connections without uncontrolled recursive spawning.

The built-in capabilities are:

- `inspect`: gather only facts needed to distinguish the current domain;
- `synthesize`: form candidates, constraints, selection, and conditional next-LOD definitions without tools;
- `implement`: execute one collapsed actionable change region;
- `verify`: check artifacts against exact criteria and target failures to regions;
- `present`: render a collapsed read-only answer.

All capability contracts live in `src/core/solution-lod/roles.ts`. The shared invariant prompt forbids finer variables before collapse. Graph nodes supply typed projected payloads; configuration chooses models and scheduling quanta.

## Context and failure semantics

An activation receives the original message, compact preceding conversation, collapsed ancestry, current domain, and only referenced evidence, constraints, and artifacts. Durable facts are stored once and passed by IDs.

Structured schemas enforce shape without small arbitrary prose limits. Invalid JSON, schema errors, timeouts, or a scheduling quantum stop fail the activation locally. The solution state remains available and another novel capability may run. Repeating failed work against an unchanged revision is forbidden. If no capability can produce a novel delta, the run returns a precise blocked result rather than looping.

### Verified context behavior (measured on real runs)

These are confirmed properties of the current projection code, not aspirational:

- An activation's projected payload includes the region's **entire** accumulated evidence, constraint, and artifact sets. `projectActivationContext` builds `refs` as a union that unconditionally contains `region.evidenceIds`, `region.constraintIds`, and `region.artifactIds`, so the "only referenced facts" filter never actually trims.
- `decisionsAlreadyMade` and `selectedApproach` were the same `lineage()` array emitted twice in the implement payload; the duplication is removed — implement now receives only `selectedApproach`, other capabilities receive `decisionsAlreadyMade`.
- Child regions copy their parent's `evidenceIds` wholesale, so depth-2 implement payloads inherit the root fact base on top of their own.
- Facts are stored once and deduplicated by fingerprint; the accumulation is by reference, not by byte-for-byte duplication.
- The implement quantum is a step-count cap (`maxTurns`) plus an inactivity watchdog, not a token cap. `inactive for 300000ms` means the child session's message fingerprint did not change for five minutes — it does not by itself prove context overflow; it can equally mean a stalled or silently waiting session.

Remaining full-region projection and parent-evidence inheritance are the current measured cost of the simple projection. Trimming facts by reference is a deliberate follow-up, not a correctness fix.

Workspace status and file content hashes are captured around mutating activations. Actual changes are recorded even when an agent's final output is malformed or interrupted. Pre-existing dirty files remain distinct from files changed during the activation.

Turns, tokens, cache reads, and cost are telemetry and per-call scheduling quanta. They do not cause human budget interruptions or discard solution state. Human input is reserved for genuine decisions or authority that repository inspection cannot supply.

## Completion

A change region moves through actionable, implementing, implemented, and verified. A verifier pass completes it. A bounded defect returns it to actionable; a contradicted solution choice reopens the targeted region. A read-only region completes after presentation. The run completes only when all required live regions are verified or have a verified answer.

## Node contracts

The static graph is an engine loop, not a pipeline of model calls. Each node has a fixed output contract:

- `schedule` (pure controller): returns `{ network, activeActivationId, phase }` for the next activation, or `{ network, activeActivationId: undefined, phase: "completed"|"blocked", result }` when no runnable work remains. It never calls a model.
- `acquire` (only when the next activation is a mutating `implement`): returns `{ worktreeAcquired: true }` after taking the worktree lease, or waits. It never calls a model.
- `activate` (the only model-calling node): given one activation, calls `runtime.call({ agent, node, state, schema, prompt })` and returns a reduced state delta:
  - a structured success delta (or `answer` for `present`) → `{ network, usage, callsUsed, activeActivationId: undefined, phase: "propagating" }`;
  - a scheduling-quantum stop (budget) → the region stays actionable, `{ network, usage, callsUsed, activeActivationId: undefined, phase: "activation-deferred" }`;
  - a throw (schema/validation/timeout) → the activation is marked failed, `{ network, callsUsed, activeActivationId: undefined, phase: "activation-failed" }`.
- `finish` (pure controller): returns `{ result }` from the final state. It never calls a model.

`mergeSolutionDelta` and the WFC propagation run inside `activate`/`schedule` respectively; models never mutate controller bookkeeping directly. Every intermediate `{ network, phase, ... }` is checkpointed, so any of these outputs is a valid restart point for the inspect/prune/resume workflow below.

## Inspect and relaunch workflow

The run is never a black box: at any checkpoint the presenter agent (and `/graph`) can read exactly what happened, and an operator can relaunch from a specific point.

- **Inspect.** `langgraph_inspect` returns stored status, phase, and the checkpointed network (regions, candidates, activations, usage, result) without mutation. A queued or running run that has not reached its first checkpoint reports `no-checkpoint-yet` instead of failing. `/graph` shows the same semantic state in the TUI. All intermediate `schedule`/`activate` checkpoints are reachable this way.
- **Prune.** `langgraph_prune <regionId>` reopens that region and drops its subtree, clears stale activations and retry counters, writes the new network back to the checkpoint via `updateState(asNode "__start__")`, and marks the run `pruned`. Active (`queued`/`running`) runs are rejected. Optional `objective`, `allowedVariables`, and `acceptanceCriteria` overrides replace the reopened region's scope before the write, so the resynthesized region follows a corrected prompt. This is the escape hatch when a region is stuck, contradicted, or scheduled under a bad quantum: it forgets only that subtree, keeps all other collapsed regions, evidence, and artifacts.
- **Resume.** `langgraph_resume` continues from the checkpoint. An `interrupted` run resumes with `Command.resume(answer)`; a `pruned` run re-enters `schedule` with `invoke(null)` and drives forward. Other statuses are rejected with a message telling the operator to prune first. Every relaunch emits fresh events and updates the stored run, so the TUI and the model see the new attempt, not a replayed transcript.
- **Prompt override.** Two mechanisms. (1) Because `activate` builds each prompt from the checkpointed state via `projectActivationContext`, changing a role's `systemPrompt` in `.opencode/langgraph.ts` (or the region's objective/`allowedVariables`) changes only subsequent activations; nothing about a prior decision is rewritten in place. (2) `langgraph_prune` accepts `objective`/`allowedVariables`/`acceptanceCriteria` overrides that rewrite the reopened region before resynthesis. Combined with resume this gives a clean "change the rule, drop the subtree, replay" cycle.

All of inspect/prune/resume operate on the same durable per-thread checkpoint the run uses, so they work across process restarts.

## TUI

F8 opens the semantic run view:

- the primary pane is the solution LOD tree with relation, LOD, status, viable-domain count, contributing capabilities, and selection;
- the region pane shows candidates, elimination reasons, conditional children, constraints, evidence, activations, and artifacts;
- `G` shows the distinct activation/message network;
- output, effective prompt, and raw state remain diagnostic views.

All panes derive from the same latest state-bearing event. Navigation legends are in panel headers and registered keymaps are the source of truth.

## Configuration

```ts
export default defineOpenCodeLangGraph({
  version: 1,
  preset: "solution-lod",
  options: {
    models: {
      inspect: "deepseek/deepseek-v4-flash",
      synthesize: "deepseek/deepseek-v4-flash",
      implement: "inherit",
    },
    roleLimits: {
      inspect: { maxTurns: 32, maxContextTokens: 160_000 },
    },
  },
})
```

Configuration is optional. Arbitrary user-defined compiled LangGraphs remain first-class.

## Release acceptance

A release requires reducer tests for conditional exposure, mixed LODs, propagation, equivalence, convergence, and selective reopening; graph tests for answer and mutation paths, local malformed-output failure, artifact reconciliation, and verifier feedback; TUI view/navigation tests; typecheck/build/pack; clean npm installation; and a real OpenCode mutation with visible F8 state.
