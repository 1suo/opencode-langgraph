# Neolit improvement roadmap

Target architecture: a durable explicit workflow state machine with small,
deterministic CSP-style domain propagation inside each solution region.

Do not pursue fuller WFC, cellular-automata orchestration, or learned control
until telemetry demonstrates a problem they would solve. Keep useful WFC/CSP
techniques such as singleton collapse and minimum-remaining-values scheduling.

## 1. Execution safety

- [x] Run every OpenCode activation in the exact worktree that is locked,
  snapshotted, checkpointed, and reported.
- [x] Integrate disposable verifier workspaces end to end; verify that Bash in a
  verifier cannot mutate the source worktree.
- [x] Remove durable `worktreeAcquired` state. Reacquire a process-local lease on
  every execution and resume, with fencing if multiple processes can run.
- [ ] Record mutation phases and workspace fingerprints so a crash after edits
  but before checkpoint commit is detectable and safely recoverable.
- [ ] Detect stale `running` runs after owner crashes and provide an explicit
  recovery path.
- [ ] Make stored-run writes atomic and validate run IDs before using them in
  filesystem paths.
- [ ] Add concurrency protection or compare-and-swap semantics to checkpoint
  updates for the same run.

## 2. Constraint and LOD correctness

- [x] Separate hard domain constraints (`requires`, `excludes`, `equivalent`),
  evidence links (`supports`, `refutes`), and workflow policy (acceptance and
  permission).
- [x] Replace permanently mutated candidate status with authored declarations
  plus recomputed viable domain, assignment, contradiction, and explanations.
- [x] Define precise, endpoint-typed semantics for every retained constraint;
  reject unknown or invalid references instead of silently dropping them.
- [x] Make exclusion symmetric and make an impossible requirement eliminate its
  source or produce a contradiction instead of silently doing nothing.
- [x] Remove inert `acceptance` and `permission` constraint kinds unless their
  controller semantics are implemented.
- [ ] Reconcile conditional subtrees after every domain change: remove children
  of abandoned candidates, update changed definitions, and clean stale
  activations and references while retaining historical artifacts.
- [ ] Validate that every completed assignment satisfies all active hard
  constraints.
- [x] Schedule unresolved regions by viable-domain size rather than total
  candidate count.

## 3. Workflow state machine

- [ ] Centralize legal region transitions and their preconditions instead of
  assigning statuses across propagation, implementation, verification, and
  reopening code paths.
- [ ] Give each activation an idempotency key, explicit read references, and
  per-reference revisions or fingerprints.
- [ ] Recheck admission before dispatch; cancel, rebase, or dead-letter stale
  activations rather than prioritizing the oldest basis revision.
- [x] Replace wake conditions: they were removed entirely — their per-entity
  semantics never existed and nothing used them honestly.
- [ ] Define one authoritative same-revision retry policy and align the spec,
  reducer, and tests.
- [ ] Add run-level limits for activations, elapsed time, cost, retries, and
  reopen cycles; report a semantic blocked result before LangGraph's recursion
  limit is reached.
- [ ] Resume failed graphs through an explicit prune/retry policy.

## 4. Role and verification contracts

- [x] Use capability-specific semantic validation so inspectors and synthesizers cannot
  weaken the root objective, delivery type, or acceptance criteria.
- [x] Validate every verifier finding against a live region and one of its
  acceptance criteria.
- [x] Handle all verifier findings and give `repair`, `reopen`, and `fail`
  distinct controller semantics.
- [x] Treat measured workspace changes as authoritative; keep model-reported
  changed files only as discrepancy telemetry.
- [x] Project only currently legal downstream request forms and document that
  bounded catalog in the specification.
- [ ] Preserve usage and child-session diagnostics when an activation throws.

## 5. Context and scheduling

- [x] Make activation context genuinely sparse instead of unconditionally
  projecting every region fact, constraint, and artifact.
- [ ] Project selected lineage with region IDs, candidate IDs, evidence, and
  decision revisions rather than proposition strings alone.
- [x] Stop copying all parent evidence into every conditional child; inherit
  only explicit references or a compact lineage summary.
- [ ] Resolve every accepted context-reference type into actual projected data.
- [x] Allow independent read-only activations to run concurrently while
  retaining one fenced mutation lane per worktree.

## 6. Tests and release evidence

- [ ] Test propagation order independence and idempotence with small generated
  networks.
- [ ] Test valid, cyclic, cross-region, and impossible requirements; symmetric
  exclusion; equivalence; and every retained constraint kind.
- [ ] Test conditional-child retraction and updates, plus referential integrity
  after reopening.
- [ ] Test multiple and invalid verifier findings.
- [ ] Test pause/resume and prune/resume lease reacquisition.
- [ ] Test verifier isolation and exact OpenCode worktree selection end to end.
- [ ] Test a crash between workspace mutation and result checkpoint commit.
- [ ] Test model-reported files against measured changes and behavior outside a
  Git worktree.
- [ ] Split the monolithic adapter test by reducer, graph, runtime, persistence,
  server, TUI, and package concerns.
- [ ] Capture a reproducible current solution-LOD real run as release evidence,
  including collapse, implementation, corrective feedback, verification, and
  inspectable state.

### Step 5 proof-harness corrections

- [x] Declarative oracle landed: joint enumeration over region picks × option
  labels per shared choice, evaluated as pure predicates on authored facts
  (stance satisfaction, pairwise constraints, coordinate-excludes from active
  commitments, revocable commitments). No propagation helpers mirrored.
- [x] Both sides asserted: every eliminated candidate is absent from all valid
  joint assignments; every elimination carries a non-empty authored witness
  (coordinate kills must name the shared choice). Completeness is nowhere claimed.
- [x] Generated networks are validated through the exported public invariant
  boundary (`assertAcyclicPrimalGraph`) before propagation; the generator covers
  authored selections, conflicting commitments, equivalence classes, pairwise
  requires/excludes, cited coordinate refutes/excludes, supports, and all three
  provenance kinds. Multi-level trees and descendant-owned variables remain a
  documented follow-up.
- [x] Coordinate excludes implemented end to end: authoritative-commitment
  trigger (declared selections only — derived singletons made the rule
  order-dependent), cross-region pruning of requiring moves, uncited rejection
  at validation, named active/inactive/prune tests, oracle enforcement added.
- [x] 500 seeds standard; every failure prints seed + context and auto-dumps the
  full serializable input (`unsound-case.json` / `novalid-case.json` /
  `oif-case.json`). Replay = rerun with the printed seed. A shrinking minimizer
  was declined as YAGNI for a seeded deterministic suite at this instance size.
- [x] All seven insertion dimensions permuted independently (including stance
  order within candidates); order-independence compares a canonical snapshot of
  revision, variables, candidate dispositions/reasons/evidence, region statuses,
  forced picks, and contradiction text — plus idempotence re-check per seed.
- [x] Full-state idempotence restored (`propagate²` deep-equals `propagate`,
  revision stable) plus six named cases: singleton collapse, remote refutation,
  equivalent co-selection, contested-binding lock, coordinate exclusion from an
  authored commitment, and empty-domain contradiction.
- [x] Nonterminal variant landed: an actionable unverified configuration reaches
  the exploration-limit terminal through the real graph with a throwing runtime
  (blocked phase, frontier inspectable). Literal "complete work with zero model
  calls" remains impossible by design — implement/verify inherently route through
  model sessions; that boundary is now documented in the fixture titles.
- [x] Locality test scaled: 300 irrelevant facts + artifacts injected; asserts
  exact referenced content, absence of unrelated content, and serialized payload
  bounded under one-third of full-network size. Cousin variables/constraints
  remain covered by the pre-existing absence assertions.
- [x] Named matrix completed: duplicate primal edge legal; transitive triangle
  rejected; same-delta declaration+stance works; purge removes descendant-owned
  variables; empty-domain and contested-commitment witnesses verified; stale
  superseded work cannot block legal activations; `sourceKind` round-trips
  merge → storage → validation; semantic snapshot exposes it (TUI badge render
  remains follow-up).
- [x] Titles aligned with evidence: graph fixture renamed to terminal-state
  replay of a fully verified checkpoint; soundness describe now states its
  declarative joint-enumeration method explicitly.
- [x] Step 5 complete: 120/120 vitest + clean tsc with the 500-seed declarative
  oracle, seven-dimension permutation, canonical-snapshot order-independence,
  full idempotence + named cases, exhaustion and terminal-replay graph fixtures,
  scaled locality property, completed named matrix, and hardened kernel fixes
  (parallel-edge legality, dead-binder release, stage ordering, contested locks,
  coordinate-excludes semantics) all passing together.

### Step 5 completion record

Two-tier architecture: fast direct-construction oracle (100 seeds) tests
propagation semantics; merge-boundary suite (15 seeds) tests real schema
parse + mergeSolutionDelta acceptance. Named matrix covers clique cycles,
parallel edges, owner-variable invalidation, stale-coordinate cleanup,
exact structured witnesses, contested-binding locks, coordinate-excludes
semantics, sourceKind round-trips, and locality at scale. Three genuine
kernel bugs found and fixed: excludes-vs-refuted semantics, dead-binder
stickiness, mid-pass read/write skew (non-confluence). Structural-release
gap also fixed: structurally unsatisfiable commitments no longer fire
coordinate-excludes on their way out.

## 7. Refactor and polish

- [ ] Separate pure domain derivation, conditional-region reconciliation,
  workflow transitions, and scheduling policy inside the solution reducer.
- [ ] Unify initial execution and checkpoint-resume lifecycle handling in the
  server.
- [ ] Reuse one stored-run scanning/indexing implementation.
- [ ] Fix the README's nonexistent `defaultDurableCheckpointer` API example and
  compile documentation examples in CI.
- [ ] Derive the CLI version from package metadata instead of reporting `0.7.0`.
- [ ] Declare directly imported packages as direct dependencies.
- [ ] Add and ship the MIT `LICENSE` file.
- [ ] Suppress expected Git stderr in non-Git test workspaces.
- [ ] Delete the ~30 packed `neolit-*.tgz` tarballs from the repository root.
- [ ] Remove the empty leftover `src/core/progressive-lod/` directory.
- [ ] Render the exact agent invocation hierarchy and the LOD regions it
  produced.

## 8. Measure before adding solver complexity

- [ ] Record activations, retries, blocked reasons, reopen count, candidate and
  region counts, projected context size, elapsed time, and cost per run.
- [ ] Consider a general CSP/SAT solver only if real runs show many simultaneous
  domains, frequent precise cross-region hard constraints, and reopen churn
  caused by local greedy choices before mutation. Note: the constraint kernel is
  now tree-restricted by design (shared decision variables + acyclic primal graph,
  union-find enforced); off-tree/cyclic constraints are rejected at validation,
  which keeps propagation sound and bounds coupling. A general solver stays a
  non-goal unless that invariant is deliberately revisited.
- [ ] Consider learned activation ranking only after deterministic scheduling
  has a measured quality bottleneck; never delegate leases, permissions,
  completion, or verification acceptance to learned control.

## 9. Operational feedback and GitHub issues

### Runtime reliability — feedback item 1 / GitHub #11

- [ ] Distinguish a child session that never started from a legitimately long,
  silent tool call; do not classify both as five minutes of inactivity.
- [ ] Expose per-role inactivity and maximum-runtime settings through the
  built-in preset, with a longer implementation default suitable for builds and
  dependency downloads.
- [ ] Preserve or fork useful child-session context after retryable transport or
  inactivity failures instead of always restarting the activation from scratch.
- [ ] Classify transport, startup, inactivity, schema, and semantic failures and
  apply bounded failure-specific retry/backoff policies. Stop repeated identical
  startup failures before consuming all three attempts.
- [ ] Preserve partial usage, tool traces, progress text, and session IDs on all
  failure paths so inactivity incidents can be diagnosed from stored runs.
- [ ] Add integration tests for a silent long-running command, a session that
  never starts, transient API disconnection, and retry with retained context.

### Convergence and recovery — feedback item 3 / GitHub #13

- [ ] Add per-region presentation, repair, verification, and reopen-cycle limits
  keyed by semantic input/output fingerprints; block on repeated no-progress
  cycles well before the 256-activation run ceiling.
- [ ] Prevent an answer-region `repair` from producing unbounded
  `present -> verify -> repair` cycles without changed evidence or output.
- [ ] Record the repeated fingerprints and exact unresolved criteria in the
  blocked result so prune/recovery targets the right region.
- [x] Deduplicate evidence by normalized source/text fingerprint.
- [x] Restore prune -> resume by writing a resumable checkpoint and cover it with
  an end-to-end integration test.
- [ ] Add the equivalent end-to-end pause-during-activation -> resume test,
  including lease reacquisition and explicit handling of replayable side
  effects; until this passes, document that operators should not pause merely
  slow runs.

### Completeness and task framing — GitHub #6 and #10

- [ ] Add a final root-coverage audit that checks the original request against
  the complete verified region tree before reporting success.
- [ ] Validate that root acceptance criteria cover every material requirement in
  the original request; an inspector may clarify criteria but may not silently
  omit scope.
- [ ] Explicitly reject time/effort estimates and deferred-work language in
  synthesis/refinement output unless the user requested estimates.
- [ ] Replace the `MAX_LOD` actionability fallback with a certified bounded leaf
  contract; depth is telemetry, not proof that work is implementable.
- [ ] Capture a real schema-v6 mutation run confirming that a coding request
  reaches implement/verify rather than terminating as fact recording (#10).
- [ ] Add adversarial tests where a model tries to hide required work in omitted
  or falsely optional children, and where it returns estimates instead of work.

### Live scope enforcement — GitHub #5

- [ ] Implement deterministic in-flight scope monitoring before adding another
  LLM role: compare tool calls and changed paths with the active region, flag
  unrelated reads/edits, and abort mutations outside the permitted worktree or
  certified scope.
- [ ] Emit scope-monitor events in the graph view with the triggering tool/path
  and decision (`on-track`, `steer`, or `abort`).
- [ ] Evaluate an optional cheap LLM reviewer only after a concrete deterministic
  anomaly; do not add unconditional per-step overseer calls that multiply model
  degeneration, latency, and cost.

### Scheduling and ceremony — feedback items 2 and 5

- [ ] Add a fast path for a small, repository-grounded correction whose supplied
  verdict already fixes objective, criteria, and approach: focused inspect,
  implement, and verify without a redundant broad synthesis call.
- [ ] Support grouping independent small corrections into one run while keeping
  separate regions and verification criteria.
- [ ] Detect shared-file mutation dependencies during decomposition and serialize
  only the conflicting regions; retain parallel inspection/evaluation elsewhere.
- [ ] Record time spent in queueing, ceremony roles, retries, implementation, and
  verification so batching/fast-path decisions are evidence-driven.

### Repository and UI operations — feedback items 4 and 6 / GitHub #4

- [ ] Add active/archive filtering to the runs view: show
  `queued|running|paused|interrupted` first and keep completed, failed, cancelled,
  and pruned runs available behind an archive toggle.
- [ ] Decide and document dirty-worktree policy before mutation. Continue
  preserving user changes, but warn early when a planned region overlaps an
  already dirty file instead of discovering merge friction after implementation.
- [ ] Do not automatically commit or stash user work; offer only explicit,
  recoverable operator actions.
- [ ] Prevent execution-mechanism changes from silently abandoning an active
  run. Require cancellation/confirmation and provide a handoff summary with the
  current choices, evidence, artifacts, and unfinished frontier when switching
  from graph execution to a headless/manual mechanism.

### Issue disposition and regressions

- [ ] Close GitHub #3 as superseded, explaining that the built-in graph now runs
  autonomously from inspection through verification and no longer has the old
  mandatory plan-confirmation interrupt.
- [ ] Close GitHub #10 only after the recorded real mutation run above succeeds.
- [ ] Keep GitHub #11 and #13 open until their runtime and convergence tests pass.
- [ ] Keep GitHub #6 open until root coverage and certified terminality land.
- [ ] Revise GitHub #5 toward deterministic anomaly-triggered enforcement rather
  than unconditional LLM supervision.
- [ ] Keep GitHub #4 open until active/archive filtering ships.
- [x] Keep the closed GitHub #2 long-prompt graph-view scenario covered by TUI
  layout, navigation, and prompt rendering regression tests.

### Typed prompt compilation and inter-agent meaning

- [ ] Replace the raw `JSON.stringify(projectActivationContext(...))` node prompt
  with a small deterministic compiler: typed graph state -> dependency-scoped
  projection -> role-native prompt sections. Keep the structured object available
  for diagnostics, but do not require an agent to infer operational meaning from
  controller field names.
- [ ] Introduce an explicit lifecycle for claims (`hypothesis`, `confirmed`,
  `rejected`) together with authority and validation kind. A hypothesis must have
  no pruning or selection effect; confirmation must satisfy the evidence policy
  for that claim type; rejection must prevent the claim from silently returning
  as an established fact.
- [ ] Compile claim state into consequences appropriate to the receiving role.
  Inspectors receive the exact validation question, admissible evidence, and
  `confirmed|refuted|unresolved` response contract; synthesizers are told that an
  unresolved claim cannot eliminate an alternative; implementers receive only
  relevant confirmed requirements and explicitly necessary unresolved risks.
- [ ] Preserve stable IDs through every prompt and response. Require proposed
  eliminations, selections, validations, and reopen requests to reference the
  candidate, constraint/claim, and evidence IDs they depend on; reject missing,
  invisible, stale, or type-ineligible references before merging output.
- [ ] Project provenance completely. Every supplied relationship must carry its
  `sourceKind` and supporting evidence references, and every supplied fact must
  retain its authority/status, so agents can distinguish user requirements,
  repository facts, model inference, preference, and unresolved hypothesis.
- [ ] Stop presenting inferred evidence as an undifferentiated fact. Rename the
  projected section or split it into confirmed facts, fixed user decisions,
  preferences, and unresolved claims, with operational permissions stated once
  for each non-empty category.
- [ ] Make the kernel, not synthesis prose, own derived dispositions. Agents
  should propose alternatives, stances, facts, and constraints; selection or
  elimination must either be an explicitly authorized decision or be derived by
  the constraint kernel from a valid referenced proof.
- [ ] Replace the synthesizer's unconditional "commit to one survivor" rule with
  a guarded rule: commit only when authority or current constraints justify the
  choice; otherwise preserve the domain and request exactly one decision-relevant
  missing fact. Test that uncertainty and preference alone never force collapse.
- [ ] Resolve the global "earlier choices are immutable" wording conflict. Render
  earlier choices as fixed by default, while exposing the single legal exception:
  request reopening when new eligible evidence directly refutes a referenced
  premise. The requesting role must not reopen or replace the choice itself.
- [ ] Compile exact per-role capabilities and preconditions rather than broad
  prose boundaries: which operation is requested, which variables may change,
  which state is immutable, what evidence permits each action, and what terminal
  response is valid. Reject impossible state/role combinations before an LLM call.
- [ ] Add at most one generated minimal contrast where the current operation is
  semantically easy to misuse (for example, cited conflict permits elimination;
  dislike or cost preference does not). Generate it from the operation contract,
  never ask an agent to write three paraphrases of the same instruction.
- [ ] Keep prompts locally exhaustive but globally small: include the complete
  contract for the node's permitted operation and only the transitive dependency
  closure of relevant ancestry, choices, constraints, evidence, outputs, and
  criteria. Add hard assertions that unrelated graph growth does not grow the
  compiled prompt.
- [ ] Return precise repair prompts after validation failure. State the rejected
  operation, the failed precondition, and the admissible correction without
  repeating the whole prompt or allowing the model to reinterpret established
  semantics.
- [ ] Add prompt-contract fixtures for every role covering ambiguous terminology,
  unresolved versus confirmed claims, preference versus defeater, stale IDs,
  missing citations, forbidden scope, evidence-driven reopen, and adversarial
  repository text that resembles instructions. Assert structured decisions and
  kernel effects, not exact prose.
- [ ] Add paraphrase and irrelevant-context robustness tests: vary only the user
  wording while holding semantic state constant and require equivalent structured
  proposals; inject large unrelated state and require identical decisions and a
  bounded prompt size.
- [ ] Instrument prompt tokens, validation-rejection rate, repair attempts,
  unsupported disposition attempts, unresolved-claim misuse, and semantic
  consistency across equivalent inputs. Use these measurements to justify each
  template addition and remove wording that adds cost without improving behavior.

## Completed

- [x] Collapse from both sides where needed when code chunks already act as
  constraints.
- [x] Render a readable solution plan with distinctive LOD and status elements.
- [x] Render semantic graph state instead of the raw static LangGraph topology.
- [ ] Event for graph finish/fail for agent to act on
