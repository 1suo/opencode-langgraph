# Neolit improvement roadmap

Target architecture: a durable explicit workflow state machine with small,
deterministic CSP-style domain propagation inside each solution region.

Do not pursue fuller WFC, cellular-automata orchestration, or learned control
until telemetry demonstrates a problem they would solve. Keep useful WFC/CSP
techniques such as singleton collapse and minimum-remaining-values scheduling.

## 1. Execution safety

- [ ] Run every OpenCode activation in the exact worktree that is locked,
  snapshotted, checkpointed, and reported.
- [ ] Integrate disposable verifier workspaces end to end; verify that Bash in a
  verifier cannot mutate the source worktree.
- [ ] Remove durable `worktreeAcquired` state. Reacquire a process-local lease on
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

- [ ] Separate hard domain constraints (`requires`, `excludes`, `equivalent`),
  evidence links (`supports`, `refutes`), and workflow policy (acceptance and
  permission).
- [ ] Replace permanently mutated candidate status with authored declarations
  plus recomputed viable domain, assignment, contradiction, and explanations.
- [ ] Define precise, endpoint-typed semantics for every retained constraint;
  reject unknown or invalid references instead of silently dropping them.
- [ ] Make exclusion symmetric and make an impossible requirement eliminate its
  source or produce a contradiction instead of silently doing nothing.
- [ ] Remove inert `acceptance` and `permission` constraint kinds unless their
  controller semantics are implemented.
- [ ] Reconcile conditional subtrees after every domain change: remove children
  of abandoned candidates, update changed definitions, and clean stale
  activations and references while retaining historical artifacts.
- [ ] Validate that every completed assignment satisfies all active hard
  constraints.
- [ ] Schedule unresolved regions by viable-domain size rather than total
  candidate count.

## 3. Workflow state machine

- [ ] Centralize legal region transitions and their preconditions instead of
  assigning statuses across propagation, implementation, verification, and
  reopening code paths.
- [ ] Give each activation an idempotency key, explicit read references, and
  per-reference revisions or fingerprints.
- [ ] Recheck admission before dispatch; cancel, rebase, or dead-letter stale
  activations rather than prioritizing the oldest basis revision.
- [ ] Make wake conditions depend on the referenced entity changing, or replace
  them with an honestly named global revision condition.
- [ ] Define one authoritative same-revision retry policy and align the spec,
  reducer, and tests.
- [ ] Add run-level limits for activations, elapsed time, cost, retries, and
  reopen cycles; report a semantic blocked result before LangGraph's recursion
  limit is reached.
- [ ] Resume failed graphs through an explicit prune/retry policy.

## 4. Role and verification contracts

- [ ] Use capability-specific deltas so inspectors and synthesizers cannot
  weaken the root objective, delivery type, or acceptance criteria.
- [ ] Validate every verifier finding against a live region and one of its
  acceptance criteria.
- [ ] Handle all verifier findings and give `repair`, `reopen`, and `fail`
  distinct controller semantics.
- [ ] Treat measured workspace changes as authoritative; keep model-reported
  changed files only as discrepancy telemetry.
- [ ] Show agents the supported capability pool and admission rules, or remove
  that claim from the specification.
- [ ] Preserve usage and child-session diagnostics when an activation throws.

## 5. Context and scheduling

- [ ] Make activation context genuinely sparse instead of unconditionally
  projecting every region fact, constraint, and artifact.
- [ ] Project selected lineage with region IDs, candidate IDs, evidence, and
  decision revisions rather than proposition strings alone.
- [ ] Stop copying all parent evidence into every conditional child; inherit
  only explicit references or a compact lineage summary.
- [ ] Resolve every accepted context-reference type into actual projected data.
- [ ] After safety and stale-message handling are complete, allow independent
  read-only activations to run concurrently while retaining one fenced mutation
  lane per worktree.

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
  caused by local greedy choices before mutation.
- [ ] Consider learned activation ranking only after deterministic scheduling
  has a measured quality bottleneck; never delegate leases, permissions,
  completion, or verification acceptance to learned control.

## Completed

- [x] Collapse from both sides where needed when code chunks already act as
  constraints.
- [x] Render a readable solution plan with distinctive LOD and status elements.
- [x] Render semantic graph state instead of the raw static LangGraph topology.
- [ ] Event for graph finish/fail for agent to act on

