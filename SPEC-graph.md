# Solution LOD graph — production specification

Status: normative for the built-in `solution-lod` graph.

## Purpose

The package is a generic OpenCode/LangGraph connector. Its built-in graph turns one message into a repository-grounded answer or verified mutation by progressively resolving the solution at the resolution actually required by the task.

Two structures are orthogonal:

1. The solution hierarchy represents the same problem at conditional levels of detail. WFC-style constraint propagation collapses its candidate domains.
2. The agent activation network is sparse message passing. Agents inspect, synthesize, refine, implement, verify, or present exact state deltas.

Agent routing is not WFC, and hierarchy depth is not automatically a LOD.

## LOD invariants

1. A region declares the variables permitted at its current LOD.
2. A region's candidates are mutually distinguishable solution families at that resolution.
3. Finer structure is created only by refinement after a candidate collapses; candidates never carry pre-committed child definitions.
4. Child regions materialize only from a successful refinement of a selected approach.
5. `refines` means the same solution at finer resolution; `partOf` means an independent deliverable region.
6. Different regions may remain at different LODs simultaneously.
7. Implementation begins when a required region is computed implementable, not at a configured depth.
8. Equivalent surviving candidates may be delegated as an implementer-local choice when no unresolved external constraint distinguishes them.
9. A contradiction reopens only the nearest implicated region. Unrelated collapsed regions and all observed artifacts survive.
10. Selection never implies actionability. Only successful refinement can create implementable leaves.
11. A genuine decision domain contains two to seven materially distinct candidates and must pass a fresh, fingerprint-bound challenge before selection or singleton collapse.
12. Challenge acceptance is bounded evidence that no concrete material omission was found, not a proof of semantic exhaustiveness.

## Terminality and refinement

Actionability is computed by the controller, never set directly by a model. Refinement returns exactly one certified leaf contract or one or more children, never both or neither. Children have unique names, exclusive criterion ownership, and collectively cover every parent criterion. A certified leaf carries every stable criterion ID, a bounded implementation scope that is neither an estimate nor deferred work, and only confirmed evidence references. Implementation additionally requires one selected candidate and acceptance of the exact current domain fingerprint; criterion count and LOD depth are not actionability rules. A new synthesis choice drops the previous refinement's subtree. Reopening does the same and returns an underspecified region to inspection.

## Solution state

Checkpoints are versioned. Schema 8 retains shared decision variables, candidate stances, constraint provenance, authored/derived separation, and process-local leases, and adds activation-local synthesis operations plus each region's domain phase and fingerprint, accepted fingerprint, CEGAR repair round, and challenge verdict. `originalTask` is immutable and the conversation frame is linked to the originating OpenCode message. Active checkpoints under older schemas are rejected with a precise start-fresh message.

Hard constraint kinds are `requires`, `excludes`, and `equivalent`; evidence relations are `supports` and `refutes`. Acceptance criteria and permissions are policy fields rather than inert edges. Endpoints are validated by kind. Controller code recomputes derived domains to a fixed point, makes exclusion symmetric, and detects impossible requirements and empty domains. Forced selection and singleton collapse remain disabled until the current domain fingerprint is accepted.

## Activation network

The static LangGraph is an engine loop:

```text
schedule → acquire-if-mutating → activate → merge/propagate → schedule
```

Each activation specifies a capability, region, exact request, expected delta, stable context references, sender, basis revision, and status. Agents may propose downstream activations. Controller code validates region and context references and suppresses the same capability/region/delta at the same state revision.

Each activation sees only the downstream request forms currently legal for that role. It cannot create sessions, choose models, invent roles, or bypass the controller. Keeping the prompt local avoids presenting a degenerative model with irrelevant workflow choices.

The built-in capabilities are:

- `inspect`: gather only facts needed to form or distinguish the current alternatives;
- `synthesize`: perform exactly one of `generate-domain`, `challenge-domain`, or `select-candidate` without tools; it never generates and approves its own domain or declares work ready;
- `refine`: split the chosen approach into covering next-step children, each with its own criterion;
- `implement`: execute one computed-implementable change region;
- `verify`: check artifacts against exact criteria and target failures to regions;
- `present`: render a collapsed read-only answer.

Controller scheduling follows the region lifecycle:

```text
unformed → inspect
superposed → generate domain → challenge domain → select candidate
selected/unrefined → refine
refined with children → solve children
certified leaf + accepted selection (actionable) → implement
```

All capability contracts live in `src/core/solution-lod/roles.ts`. Graph nodes compile dependency-scoped semantic projections into role-native prompt sections; configuration chooses models and scheduling quanta.

After inspection, generation returns two to seven mutually exclusive material families and cannot select or eliminate. A fresh challenge returns exactly one fingerprint-bound acceptance, one concrete missing family, or one decision-relevant fact request. At most one counterexample is merged per challenge and the enlarged domain is challenged again; `needs-fact` schedules focused inspection, then recomputes and rechallenges the domain. At most two counterexample repairs and seven total candidates are allowed. Selection compares every viable candidate only after acceptance, using user preference, confirmed repository compatibility, smaller scope/novelty, then lower irreversible risk as lexicographic soft tiers. A newly discovered hard constraint invalidates acceptance and returns to challenge instead of landing with selection. Preferences never become hard constraints. Bounds and repeated no-progress ties terminate as explicit blocks.

## Multi-task AND roots

One cohesive objective uses the normal root region. A request containing independently verifiable deliverables uses a root AND-container with one controller-assigned scope identity and one `partOf` child per material task. Each root requirement and acceptance criterion has exactly one typed owner; dependencies, inherited choices, and mutation conflicts use stable scope, criterion, variable, artifact, or path references rather than prose similarity.

Each child has its own lifecycle and currently follows normal inspection plus the bounded domain/challenge/selection cycle whenever a decision domain is required. Independent reads may run concurrently, while mutation remains fenced. Terminality requires a deterministic bundle-coverage audit. Verified children survive when another child blocks, and the result identifies every unresolved scope and criterion. A focused inspect/implement/verify fast path for already-fixed corrections is not implemented yet.

## Context and failure semantics

An activation receives the original message, compact preceding conversation, stable-ID selected lineage, the current candidate slice, visible shared-variable states with every binding/unavailability witness, and explicitly referenced evidence, constraints, and artifacts. Children do not copy the parent's evidence set. Durable facts are stored once and passed by IDs.

Structured schemas enforce shape without small arbitrary prose limits. Invalid JSON, schema errors, timeouts, or a scheduling quantum stop fail the activation locally. The solution state remains available and another novel capability may run. Repeating failed work against an unchanged revision is forbidden. If no capability can produce a novel delta, the run returns a precise blocked result rather than looping.

### Verified context behavior (measured on real runs)

These are confirmed properties of the current projection code, not aspirational:

- Activation payloads resolve `contextRefs` rather than unconditionally unioning the region's accumulated evidence and artifacts.
- Selected lineage is emitted once as `{regionId,candidateId,choice}` records so downstream agents can cite or request reopening of the exact premise.
- Child regions begin with an empty evidence-reference set and receive facts through explicit activation references.
- Facts are stored once and deduplicated by fingerprint; the accumulation is by reference, not by byte-for-byte duplication.
- The implement quantum is a step-count cap (`maxTurns`) plus an inactivity watchdog, not a token cap. `inactive for 300000ms` means the child session's message fingerprint did not change for five minutes — it does not by itself prove context overflow; it can equally mean a stalled or silently waiting session.

Candidate-domain relationships remain local to the current region; evidence and artifacts are sparse by explicit reference.

Workspace status and file content hashes are captured around mutating activations. Actual changes are recorded even when an agent's final output is malformed or interrupted. Pre-existing dirty files remain distinct from files changed during the activation.

The locked worktree is authoritative. The connector preserves pre-existing changes and never automatically stashes, commits, resets, or discards them. A planned mutation that overlaps a dirty path must be reported before implementation and resolved only through an explicit recoverable operator action.

Changing to a headless or manual execution mechanism is not a graph checkpoint handoff. An active run must be inspected and explicitly paused or cancelled; its current choices, evidence, artifacts, and unfinished frontier must be summarized for the receiving mechanism. The connector cannot currently transfer scheduler ownership or synthesize this handoff automatically, so a mechanism switch must not imply graph completion.

Turns, tokens, cache reads, and cost are telemetry and per-call scheduling quanta. They do not cause human budget interruptions or discard solution state. Human input is reserved for genuine decisions or authority that repository inspection cannot supply.

## Completion

A change region moves through unrefined (selected), collapsed (split), actionable (computed implementable), implementing, implemented, and verified. A verifier pass completes it. A bounded defect returns it to actionable; a contradicted solution choice reopens the targeted region and drops its refinement. A read-only region completes after presentation. The run completes only when all required live regions are verified or have a verified answer.

## Node contracts

The static graph is an engine loop, not a pipeline of model calls. Each node has a fixed output contract:

- `schedule` (pure controller): returns `{ network, activeActivationId, phase }` for the next activation, or `{ network, activeActivationId: undefined, phase: "completed"|"blocked", result }` when no runnable work remains. It never calls a model.
- `acquire` (before every mutating `implement`, including after resume): takes a process-local worktree lease without persisting lease ownership in checkpoint state. It never calls a model.
- `activate` (the only model-calling node): given one activation, calls `runtime.call({ agent, node, state, schema, prompt })` and returns one `ActivationTaskResult` record containing a validated delta, a deferred budget stop, or a serialized local error.
- `merge` (pure controller): deterministically orders the batch records, applies each record, and propagates after every attempt so failed output cannot leave stale derived locks. It then clears the result log and returns to scheduling.
- `finish` (pure controller): returns `{ result }` from the final state. It never calls a model.

`mergeSolutionDelta`, `mergeRefinementOutput`, and propagation run only in controller code; models never mutate bookkeeping directly. Inference always enters as a hypothesis, model-authored evidence status is ignored, claim validation requires independent proof, and model deltas cannot assert `user-task` provenance. A proposed eliminated outcome is stored as possible and becomes eliminated only if the accepted refutation rules derive it. Invalid structured output is retried in the same child session with only the failed precondition, admissible correction, and prior invalid output; synthesis receives up to three total attempts. Every intermediate state is checkpointed for inspect/prune/resume.

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
- the region pane shows candidates, stances, elimination reasons, constraint provenance/evidence references, evidence status/proof, activations, and artifacts;
- `G` shows the exact activation invocation hierarchy derived from `senderActivationId`, mapped to each activation's solution region and LOD;
- `R` shows active runs first and `V` toggles the terminal archive;
- activation details render input and output by schema semantics — outcome badges (`[CHOSEN]`, `[REJECTED]`), constraint-kind badges (`[REFUTES]`, `requires`, …), refinement contracts with criterion coverage, verification verdicts, check pass/fail, file lists — each tone-mapped to theme colors; unparseable payloads fall back to raw text;
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

A release requires reducer tests for refinement certification, coverage rejection, mixed LODs, propagation, equivalence, convergence, and selective reopening; graph tests for answer and mutation paths, local malformed-output failure, artifact reconciliation, and verifier feedback; TUI view/navigation tests; typecheck/build/pack; clean npm installation; and a real OpenCode mutation with visible F8 state.
