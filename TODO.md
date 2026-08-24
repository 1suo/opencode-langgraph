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
- [x] Detect stale `running` runs after owner crashes and provide an explicit
  recovery path.
- [x] Make stored-run writes atomic and validate run IDs before using them in
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
- [x] Resume failed graphs through an explicit prune/retry policy.

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
- [x] Require measured workspace-change artifacts for change delivery, with an
  explicit inspected-and-verified already-satisfied exception; reject answer-only
  completion while repository mutation criteria remain.
- [x] Require execution evidence for intended/measured files, focused tests, full
  checks, and TODO disposition where applicable; prose-only inventories fail.
- [x] Make completion evidence explicitly cover implementation, direct testing,
  correctness review, and release gating before checkbox completion.
- [x] Store typed review findings with severity, files, regression criterion, and
  evidence; high findings block completion and therefore commit/release.

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
- [x] Keep implementation batches scope-sized and sequential with typed,
  non-overlapping scope ownership; serialize shared mutation resources while
  allowing independent read-only work to overlap.
- [x] Test concurrency through observed overlap and barriers rather than
  incidental sibling event order; deterministic merge order remains a separate
  controller invariant.

## 6. Tests and release evidence

- [x] Test propagation order independence and idempotence with generated
  networks.
- [x] Test valid, cyclic, cross-region, and impossible requirements; symmetric
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
  provenance kinds, multi-level trees, and descendant-owned variables, with
  explicit coverage thresholds.
- [x] Coordinate excludes implemented end to end: authoritative-commitment
  trigger (declared selections only — derived singletons made the rule
  order-dependent), cross-region pruning of requiring moves, uncited rejection
  at validation, named active/inactive/prune tests, oracle enforcement added.
- [x] 500 seeds standard; soundness failures print seed + context and dump the
  full serializable input to `unsound-case.json`. Replay = rerun with the printed
  seed. A shrinking minimizer remains optional for this bounded deterministic suite.
- [x] All seven insertion dimensions permuted independently (including stance
  order within candidates); order-independence compares a canonical snapshot of
  revision, variables, candidate dispositions/reasons/evidence, region statuses,
  forced picks, and contradiction text — plus idempotence re-check per seed.
- [x] Full-state idempotence restored (`propagate²` deep-equals `propagate`,
  revision stable) across the 500-seed generated suite; named regressions cover
  singleton collapse, remote refutation, equivalent co-selection, stale and
  contested-binding locks, coordinate exclusion, and empty-domain contradiction.
- [x] Nonterminal variant landed: an actionable unverified configuration reaches
  the exploration-limit terminal through the real graph with a throwing runtime
  (blocked phase, frontier inspectable). Literal "complete work with zero model
  calls" remains impossible by design — implement/verify inherently route through
  model sessions; that boundary is now documented in the fixture titles.
- [x] Locality test scaled: 300 irrelevant facts + artifacts injected; asserts
  exact referenced content, absence of unrelated content, and serialized payload
  bounded under one-third of full-network size. Cousin variables/constraints
  remain covered by the pre-existing absence assertions.
- [x] Current named matrix completed: duplicate primal edge legal; transitive triangle
  rejected; same-delta declaration+stance works; purge removes descendant-owned
  variables; deterministic contradiction text verified; stale
  superseded work cannot block legal activations; `sourceKind` round-trips
  through trusted internal merge/storage, while model-authored `user-task`
  authority is rejected; semantic snapshots and the region pane expose
  provenance and evidence references. Structured contradiction objects remain
  the separate Step 3.6 task in the execution plan.
- [x] Titles aligned with evidence: graph fixture renamed to terminal-state
  replay of a fully verified checkpoint; soundness describe now states its
  declarative joint-enumeration method explicitly.
- [x] Step 5 proof harness complete for the current string-witness kernel: 131/131
  vitest + clean tsc with the 500-seed declarative
  oracle, seven-dimension permutation, canonical-snapshot order-independence,
  full idempotence + named cases, exhaustion and terminal-replay graph fixtures,
  scaled locality property, completed named matrix, and hardened kernel fixes
  (parallel-edge legality, dead-binder release, stage ordering, contested locks,
  coordinate-excludes semantics) all passing together.

### Step 5 completion record

Two-tier architecture: fast direct-construction oracle (500 seeds) tests
propagation semantics; merge-boundary suite (15 seeds) tests real schema
parse + mergeSolutionDelta acceptance. Named matrix covers clique cycles,
parallel edges, owner-variable invalidation, stale-coordinate cleanup,
exact structured witnesses, contested-binding locks, coordinate-excludes
semantics, sourceKind round-trips, and locality at scale. Kernel bugs found
and fixed include excludes-vs-refuted semantics, dead-binder stickiness,
mid-pass read/write skew (non-confluence), and structural release: both
structurally unsatisfiable commitments and commitments killed by coordinate
facts stop firing coordinate-excludes on their way out.

## 7. Refactor and polish

## 8. Findings from the 2026-08-23 long run (6030382c)

Live-run evidence from executing TODO-CSP-CEGAR-LOD.md's design through a
20+ region, 3-level solution tree (16→62 activations). Each item names the
observed failure and the fix direction.

- [ ] **Evidence restatement bloat.** The evidence merge matches exact
  text+fingerprint, so paraphrased facts accumulate: r1 recorded 34 evidence
  items for ~12 unique findings, and descendants re-inherited all of them
  (e88–e134 by revision 28). Every downstream prompt pays. Fix: normalized
  proposition-style signatures for evidence identity (same rule TODO-CSP
  section 1 mandates for candidates), plus ancestor-evidence projection that
  sends children only the deduplicated set.
- [ ] **Cross-subtree scope duplication.** Two siblings independently
  decomposed the same feature space: r5's children (r9–r13) and r8's children
  (r15–r18) each covered domain-control state+v8, the bounded synthesis loop,
  acceptance gates+tiers, recycling, and observability. Integration region
  r20 had to reconcile collisions reactively ("cross-piece conflicts resolved…
  as a unit"). Fix: assign explicit controller-owned scope IDs during
  decomposition and reuse or reject duplicate ownership by typed identity.
  Project only explicitly referenced cousin scopes; do not infer coupling from
  slug or proposition similarity.
- [x] **Constraint-kind validation hole.** A constraint with `kind:
  "acceptance"` entered state (c25) — not a member of `ConstraintKind`.
  Propagation silently ignores unknown kinds, so it was inert but polluted.
  Fix: enforce the enum at mergeSolutionDelta and reject unknown kinds with
  teaching text.
- [x] **Duplicate excludes survived dedup.** c1/c2 are identical
  subject/target/kind pairs differing only in a "(supplied relationship c1)"
  reason suffix. The pair-canonicalization dedup should have merged them;
  investigate why the second authoring path bypassed the existing-match scan
  (likely two records in one batch applied before any propagate).
- [ ] **No-progress re-authoring loop (run killer).** After the r4
  contradiction, four consecutive synthesize attempts re-authored the same
  six selections under renamed candidate keys (`a1-stored-verdict-record` →
  `verdict-record`), dodging slug-dedup and re-tripping the contested lock
  until the scheduler starved. `MAX_ACTIVATION_RETRIES` only counts failed
  activations; successful merges that produce no semantic change are
  uncapped. This is the strongest live argument for TODO-CSP's normalized
  candidate identity (section 1) and its two-identical-no-progress-cycles
  block (section 2); until those land, add a cheap guard: if N consecutive
  synthesize results for one region produce a network whose candidate-set
  signature is unchanged, block the region with the last contradiction.
- [ ] **OR-region modeling error needs prompt-side defense.** The synthesizer
  crammed six orthogonal design axes into one region as co-selectable
  candidates; the kernel correctly locked contradiction, but recovery needed
  a manual prune whose objective taught "one selection per result; orthogonal
  axes become refine children." Bake that lesson into the synthesize role
  contract and MINIMAL CONTRAST section so first attempts model axes as
  children instead of parallel selections.
- [ ] **Depth inflation on small tasks.** A TUI-badge task decomposed to LOD
  6–7; each level costs ~3 thinking-tier activations. The depth floor
  guarantees termination but not economy. Fix direction: teach the refiner to
  prefer atomic leaves when every remaining criterion is mechanically
  verifiable (check-command-expressible), independent of REFINEMENT_DEPTH_LIMIT.
- [ ] **Selection debt before any implementation.** The run formed ~11 OR-
  domains and committed none while burning half its activation budget;
  implement/verify never started. Consider a scheduler preference: once a
  region has sat superposed past K scheduling passes, force a
  select-or-request-fact decision instead of forming another frontier.
- [x] **Scratch files in repo root.** `dbg-bd.tmp.ts` / `dbg-buildDirect.tmp.ts`
  were left by offline debugging and even surfaced as cleanup work inside the
  run's own decomposition (r20). Delete and keep temp debug scripts outside
  the repository.


- [ ] Separate pure domain derivation, conditional-region reconciliation,
  workflow transitions, and scheduling policy inside the solution reducer.
- [ ] Unify initial execution and checkpoint-resume lifecycle handling in the
  server.
- [ ] Reuse one stored-run scanning/indexing implementation.
- [ ] Compile README API examples in CI (`defaultDurableCheckpointer` is now a
  real exported API).
- [x] Derive the CLI version from package metadata instead of reporting `0.7.0`.
- [x] Declare directly imported packages as direct dependencies.
- [x] Add and ship the MIT `LICENSE` file.
- [x] Suppress expected Git stderr in non-Git test workspaces.
- [x] Delete the ~30 packed `neolit-*.tgz` tarballs from the repository root.
- [x] Remove the empty leftover `src/core/progressive-lod/` directory.
- [ ] Render the exact agent invocation hierarchy and the LOD regions it
  produced.

## 8. Measure before adding solver complexity

- [ ] Record activations, retries, blocked reasons, reopen count, candidate and
  region counts, projected context size, elapsed time, and cost per run.
**Disposition: General CSP/SAT solver.** Consider one only if real runs show
many simultaneous domains, frequent precise cross-region hard constraints, and
reopen churn caused by local greedy choices before mutation. The constraint
kernel is tree-restricted by design (shared decision variables + acyclic primal
graph, union-find enforced); off-tree/cyclic constraints are rejected at
validation, which keeps propagation sound and bounds coupling. A general solver
is a non-goal unless that invariant is deliberately revisited.

**Disposition: Learned activation ranking.** Consider it only after
deterministic scheduling has a measured quality bottleneck; never delegate
leases, permissions, completion, or verification acceptance to learned control.

## 9. Operational feedback and GitHub issues

- [x] Persist failed child-session recovery context on the same activation and
  boundedly continue/fork it after API loss; fresh challenge sessions remain
  independent and transcripts never become workflow state.

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
- [ ] Capture a real current-schema mutation run confirming that a coding request
  reaches implement/verify rather than terminating as fact recording (#10).
- [ ] Add adversarial tests where a model tries to hide required work in omitted
  or falsely optional children, and where it returns estimates instead of work.

### Live scope enforcement — GitHub #5

- [ ] **Blocked: missing pre-side-effect tool hook.** Deterministic in-flight
  scope monitoring cannot compare and stop tool calls before mutation until the
  platform exposes a pre-side-effect hook with the active tool/path and scope.
- [ ] **Blocked: missing pre-side-effect tool hook.** Scope-monitor graph events
  (`on-track`, `steer`, or `abort`) cannot truthfully represent pre-tool decisions
  until that hook exists.

**Disposition: Optional LLM reviewer.** Evaluate one only after a concrete
deterministic anomaly; do not add unconditional per-step overseer calls that
multiply model degeneration, latency, and cost.

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

#### Multi-task runs

- [x] Treat every aligned requested deliverable as a required root `partOf`
  scope at run framing; permit only explicit conflicting, external, or speculative
  dispositions, never an OR choice over a subset of requested work.

- [ ] Frame a request containing independently verifiable deliverables as a root
  AND-container with one controller-assigned scope ID and `partOf` child per
  material task. Keep inseparable requirements together and preserve the normal
  single-root flow for one cohesive objective.
- [ ] Map every material root requirement and acceptance criterion to exactly one
  owned task scope before execution. Reject duplicate scope ownership by typed
  identity rather than objective, slug, or proposition similarity.
- [ ] Represent semantic dependencies, inherited shared decisions, and mutation
  conflicts separately. Cross-task relationships must cite stable scope,
  criterion, variable, artifact, or path references instead of inferred prose
  similarity.
- [ ] Run each task child through its own lifecycle: use focused
  `inspect -> implement -> verify` for a supplied or mechanically fixed
  correction, and the bounded domain/challenge/selection cycle only when the
  child contains a genuine solution choice.
- [ ] Schedule independent read-only work concurrently. Retain one fenced
  mutation lane by default, then serialize only certified overlapping mutation
  resources if disjoint-path parallel mutation is introduced.
- [ ] Add a final deterministic bundle-coverage audit: every required scope is
  represented, every dependency is satisfied, and every live task child is
  verified. Preserve completed independent children when another child blocks,
  and report a partial result with the exact unresolved scopes and criteria.

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

**External disposition: GitHub #3.** Close as superseded, explaining that the
built-in graph now runs autonomously from inspection through verification and no
longer has the old mandatory plan-confirmation interrupt. This repository audit
did not perform the external GitHub operation.

**External disposition: GitHub #10.** Keep open until the recorded real mutation
run above succeeds; no external GitHub operation was performed.

**External disposition: GitHub #11 and #13.** Keep open until their runtime and
convergence tests pass; no external GitHub operation was performed.

**External disposition: GitHub #6.** Keep open until root coverage and certified
terminality land; no external GitHub operation was performed.

**External disposition: GitHub #5.** Revise toward deterministic
anomaly-triggered enforcement rather than unconditional LLM supervision; no
external GitHub operation was performed.

**External disposition: GitHub #4.** Keep open until active/archive filtering
ships; no external GitHub operation was performed.
- [x] Keep the closed GitHub #2 long-prompt graph-view scenario covered by TUI
  layout, navigation, and prompt rendering regression tests.

### Typed prompt compilation and inter-agent meaning

- [x] Replace the raw `JSON.stringify(projectActivationContext(...))` node prompt
  with a small deterministic compiler: typed graph state -> dependency-scoped
  projection -> role-native prompt sections. Keep the structured object available
  for diagnostics, but do not require an agent to infer operational meaning from
  controller field names.
- [x] Introduce an explicit lifecycle for claims (`hypothesis`, `confirmed`,
  `rejected`) together with authority and validation proof references. A hypothesis must have
  no pruning or selection effect; confirmation must satisfy the evidence policy
  for that claim type; rejection must prevent the claim from silently returning
  as an established fact.
- [x] Compile claim state into consequences appropriate to the receiving role.
  Inspectors receive the exact validation question, admissible evidence, and
  `confirmed|rejected|unresolved` response contract; synthesizers are told that an
  unresolved claim cannot eliminate an alternative; implementers receive only
  relevant confirmed requirements and explicitly necessary unresolved risks.
- [x] Preserve stable references through every prompt and response. Existing
  candidates, constraints, claims, evidence, lineage choices, and reopen targets
  carry stable IDs; new alternatives use local stable keys that the validator
  resolves before merge. Reject missing, invisible, stale, or type-ineligible
  references before merging output.
- [x] Project provenance completely. Every supplied relationship must carry its
  `sourceKind` and supporting evidence references, and every supplied fact must
  retain its authority/status, so agents can distinguish user requirements,
  repository facts, model inference, preference, and unresolved hypothesis.
- [x] Stop presenting inferred evidence as an undifferentiated fact. Rename the
  projected section or split it into confirmed facts, fixed user decisions,
  preferences, and unresolved claims, with operational permissions stated once
  for each non-empty category.
- [x] Make the kernel, not synthesis prose, own derived dispositions. Agents
  should propose alternatives, stances, facts, and constraints; selection or
  elimination must either be an explicitly authorized decision or be derived by
  the constraint kernel from a valid referenced proof.
- [x] Replace the synthesizer's unconditional "commit to one survivor" rule with
  a guarded rule: commit only when authority or current constraints justify the
  choice; otherwise preserve the domain and request exactly one decision-relevant
  missing fact. Test that uncertainty and preference alone never force collapse.
- [x] Resolve the global "earlier choices are immutable" wording conflict. Render
  earlier choices as fixed by default, while exposing the single legal exception:
  request reopening when new eligible evidence directly refutes a referenced
  premise. The requesting role must not reopen or replace the choice itself.
- [x] Compile exact per-role capabilities and preconditions rather than broad
  prose boundaries: which operation is requested, which variables may change,
  which state is immutable, what evidence permits each action, and what terminal
  response is valid. Reject impossible state/role combinations before an LLM call.
- [x] Add at most one generated minimal contrast where the current operation is
  semantically easy to misuse (for example, cited conflict permits elimination;
  dislike or cost preference does not). Generate it from the operation contract,
  never ask an agent to write three paraphrases of the same instruction.
- [x] Keep prompts locally exhaustive but globally small: include the complete
  contract for the node's permitted operation and only the transitive dependency
  closure of relevant ancestry, choices, constraints, evidence, outputs, and
  criteria. Add hard assertions that unrelated graph growth does not grow the
  compiled prompt.
- [x] Return precise repair prompts after validation failure. State the rejected
  operation, the failed precondition, and the admissible correction without
  repeating the whole prompt or allowing the model to reinterpret established
  semantics.
- [x] Propagate after every activation attempt, including failure/supersession,
  and regression-test that a failed final batch cannot preserve a stale
  commitment-conflict lock.
- [x] Serialize non-`Error` failures as JSON throughout runtime, graph, server,
  validation, tool trace, and TUI paths; never teach a retry with
  `[object Object]`.
- [x] Give synthesis three total structured-output attempts and teach the exact
  `outcome=eliminated` + evidenced `refutes` form in the schema and local prompt.
- [x] Deduplicate constraints by operative `{kind, endpoints}` identity rather
  than free-form reason wording; merge proof references/provenance so repeated
  paraphrases do not inflate prompts or stored networks.
- [x] Replace the fixed depth-2 fuzz add-on with randomized LOD trees up to depth
  4 (within the five-region oracle bound), descendant-owned variables, and
  explicit depth-3/depth-4 coverage gates. The new coverage found and fixed a
  deep dead-binder coordinate-exclusion bug.
- [ ] Add prompt-contract fixtures for every role covering ambiguous terminology,
  unresolved versus confirmed claims, preference versus defeater, stale IDs,
  missing citations, forbidden scope, evidence-driven reopen, and adversarial
  repository text that resembles instructions. Assert structured decisions and
  kernel effects, not exact prose.
- [ ] Add paraphrase and irrelevant-context robustness tests: vary only the user
  wording while holding semantic state constant and require equivalent structured
  proposals; inject large unrelated state and require identical decisions and a
  bounded prompt size.
- [ ] Instrument prompt size, validation-rejection and repair attempts,
  unsupported disposition attempts, unresolved-claim misuse, and semantic
  consistency across equivalent inputs. Use these measurements to justify each
  template addition and remove wording that adds cost without improving behavior.

## Completed

- [x] Collapse from both sides where needed when code chunks already act as
  constraints.
- [x] Render a readable solution plan with distinctive LOD and status elements.
- [x] Render semantic graph state instead of the raw static LangGraph topology.
- [x] Event for graph finish/fail for agent to act on
