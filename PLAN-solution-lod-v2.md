# solution-lod v2 — Detailed Design & Build Plan

Status: execution plan. Every mechanism traces to a stated requirement, an observed failure, or existing behavior being preserved. Speculative machinery is banned; the cut list in Part F is binding.

## Part A — Formal model: local-first state machine

**State piece** (one region) =
`{scope: objective, delivery, allowedVariables, acceptanceCriteria}` ∪
`{domain: candidates[status, stances]}` ∪
`{variableView: inherited bindings + own declarations}` ∪
`{evidenceIds, artifactIds}` ∪ `status`.

**Configuration** = region tree + shared variable table + evidence store. Every node transition already checkpoints a configuration (existing LangGraph persistence — reused as-is).

**Two transition classes, strictly separated:**

- **Model transitions** (proposals): author variables/candidates/stances/constraints, select, split, implement, verify-verdict. Always validated, never trusted.
- **Kernel transitions** (commitments): propagate, bind, force-collapse singletons, detect contradictions, recompute statuses, invalidate stale subtrees. Only ever apply *entailments* of authored facts — never invent, never block authorship.

**Locality invariant**: an activation reads exactly `{own region slice, inherited variable bindings, contextRefs-resolved facts/artifacts, collapsed ancestry}` — nothing else. Enforced and tested (E5-d), not prose.

## Part B — Space representation (schema v7)

```ts
DecisionVariable { id: "v<n>", name: slug, ownerRegionId }
// Values have NO registry: a value exists as a normalized label inside stances/bindings.

Stance { variableId, relation: "requires" | "excludes" | "prefers", valueLabel }

// SolutionCandidate gains:  stances: Stance[]
// SolutionConstraint gains: sourceKind: "user-task" | "repo-evidence" | "model-inference"
// First-class composite refs: `${variableId}:${valueLabel}` — legal targets of refutes/excludes.
```

Deliberate cuts: no value-registry object, no typed domains, no weights, no entropy fields, no binary cross-candidate edges beyond today's intra-region kinds.

Scope rules (validator-enforced; error text teaches format via the existing retry-with-guidance loop):

1. Variable visible only in the owner's subtree; names globally unique (duplicate slug → rejection). Ancestry governs *visibility* only.
2. **Acyclicity is defined and enforced on the primal variable graph**, never inferred from region ancestry: nodes = decision variables; an edge joins two variables whenever one candidate's stance set or one constraint mentions both. Invariant: G stays acyclic (forest), enforced incrementally at merge via union-find — an edge joining two already-connected components is rejected with a teaching error. The forest restriction makes propagation bounded and inspectable; it does not by itself make the limited rules in D2 globally complete. The dense/random regime shown hopeless by Chan/Ng/Peng STOC 2024 stays out by construction and by checked invariant.
3. Stances may only reference visible variables. `prefers` never prunes — informational, projected to models.
4. **Canonical labels**: value labels slug-normalize (`normalize()` + slug, same as candidate keys). A newly authored raw label whose slug collides with an existing label of the same variable is rejected unless byte-identical after normalization — the model must reuse the canonical spelling. Variable declarations may carry optional seed labels (informational; they do not close the domain — previously unseen slugs remain legal).

## Part C — Space discovery protocol

| Capability | Discovers | Kernel treatment |
|---|---|---|
| inspect | evidence facts only (may not propose choices) | facts land, fingerprinted |
| synthesize | new variable (only for a genuinely new choice dimension); nearest-neighbor direction candidates + stances; level-local constraints | validates scope/names; propagates |
| refine | subcells; passes current bindings down as boundary conditions (children start unformed with variableView) | purge-on-reselect already exists |
| implement / verify | ground truth: failures become refuting evidence targeting coordinates (`v:label`) | witness-bearing eliminations |

Closed loop: an evidence-cited refutation of a coordinate (`v:label`) found anywhere prunes every stance-holding direction everywhere the variable is visible. Automatic pruning requires (a) a coordinate-targeted refutes/excludes and (b) ≥1 cited `evidenceRef` — validator-enforced, matching the answer-citation precedent. Visibility defines reach; *applicability* beyond it (platform-, module-, branch-conditional facts) remains an explicit model judgment surfaced through provenance in projection, never silently universalized (see non-goals).

## Part D — Rules

**D1. `TRANSITIONS` table** (exported const in reducer.ts): declarative `{fromStatus × capability × guard → toStatus}`, replacing logic duplicated across `activationAdmitted`, `ensureRunnableWork`, and `propagateNetwork` status writes. Unknown capability ⇒ no entry ⇒ unroutable.

**D2. Propagation pipeline order** (inside `propagateNetwork`):
1. Rebuild derived dispositions from authored ones (kept from WIP)
2. Intra-region pairwise rules — unchanged five kinds
3. Upward sweep (leaves→root): coordinate refutations kill requiring candidates; new refutations enqueue upward
4. Downward sweep (root→leaves): selections emit bindings `v:=L`; visible candidates holding `excludes(v,L)` eliminated; `requires(v,L′≠L)` eliminated — witness cites `v=L` and origin region
5. Forced collapse only on singleton viable domains (rails, never decider)
6. Empty domain → contradiction with witness naming killing arc/value

**D3. Stance semantics**: `requires(v,L)` dies iff `L` refuted or `≠L` bound; `excludes(v,L)` dies iff `L` bound; `prefers` never eliminates. Label matching = normalized-string equality. Guarantee is soundness (every elimination entailed by authored facts), not completeness — deciding is the models' job.

**D4. Invalidation**: re-selection/reopen purges subtree AND resets variable domains owned by purged regions; unrelated regions survive.

## Part E — Build steps (one delivery, ordered; gate = full suite green per step)

### Step 0 — Strip WIP (~½d)
Delete: `evaluate/select/certify` from Capability/roles/config; `CandidateCoverage`, `ImplementationContract`, statuses `proposed/evaluated/leaf-proposed`; unused Synthesis/Evaluation/Certification schemas; mandatory `outcome`/`leaf` from `RefinementOutputSchema`.
Keep: declared-vs-derived dispositions, symmetric excludes, requires-unavailable elimination, endpoint validation, role-overreach checks, repair/reopen/fail verdict split, sparse child evidence (`evidenceIds: []`), admission gating, verifier workspace hooks.
Gate: suite green incl. restored parallel fan-out (`maxOpen=2`) and role-vocabulary tests; typecheck.

#### Step 0 correction plan — prove the WIP is actually gone

1. Search source, configuration, schemas, prompts, tests, docs, and serialized fixtures for every deleted capability, status, and contract. Remove executable references; retain a name only in migration notes or tests explicitly asserting rejection.
2. Keep authored/derived candidate fields mandatory in v7-created state. Compatibility fallbacks may exist only at the v7 decode boundary; propagation must not reinterpret an old derived status as authored input.
3. Preserve verifier isolation, sparse child references, mutation measurement, repair/reopen/fail semantics, endpoint validation, and symmetric candidate exclusion with focused regression tests.
4. Restore the two-sibling read-only fan-out test and assert `maxOpen === 2`; add a role-vocabulary test proving the runtime capability catalog contains exactly the six retained roles.

Gate: repository search finds no live deleted role/status/schema, all retained-rail regressions pass, full suite and typecheck are green, and Step 0 changes contain no new architecture.

### Step 1 — Rails hygiene (~½d)
Wake conditions deleted entirely (field, waiting status, wake logic, schema knob, test); admission via TRANSITIONS allowlist; authored `"equivalent"` outcome rejected; `MAX_LOD` → configurable `refinementDepthLimit` + floor-usage counter in run result; hardcoded 256-cap → `options.maxActivations`; git-rm ~30 tarballs.

#### Step 1 correction plan — finish lifecycle and termination rails

1. Remove `wakeCondition`, `waiting`, and wake/requeue claims from types, reducers, schemas, fixtures, GRAPH, SPEC, and TUI icons. A repository-wide search must find none outside historical migration text.
2. Introduce the single exported `TRANSITIONS` allowlist used by activation creation, admission, scheduling, and result application. Supersede stale queued work that no longer matches its region transition before checking for runnable work.
3. Keep `equivalent` solely as a constraint kind/derived relationship; reject it as an authored candidate outcome at schema validation and semantic validation.
4. Add `refinementDepthLimit` to public preset options and `SolutionLodOptions`, validate it as a non-negative integer, pass it into mechanical actionability, and remove the module constant. Record every region made actionable by the floor and expose the count and ids in the terminal run result.
5. Keep `maxActivations` configurable, validate it as a positive integer, and stop with an inspectable frontier without mutating unresolved state when reached.
6. Confirm tracked tarball count is zero. Delete only tracked generated archives identified by the plan; do not touch unrelated untracked user files.

Gate: exhaustive transition-table test, stale-queued regression, configured depth tests at two different limits, exploration-limit test, floor-use reporting test, zero tracked archives, full suite and typecheck green.

### Step 2 — Schema v7 (~½d)
Types from Part B; validator extensions; pre-v7 checkpoints rejected (established pattern).

#### Step 2 correction plan — make v7 one atomic, enforceable contract

1. Set graph state, activation snapshots, stored-run metadata, resume guards, fixtures, and documentation to version `7`. Reject missing and `<7` solution-lod versions with a message that instructs starting a fresh run; never label v7 state as checkpoint version 6.
2. Define `DecisionVariable`, `CandidateStance`, canonical coordinate syntax, `sourceKind`, and `evidenceRefs` once in types. Store seed labels as canonical informational labels without closing the domain.
3. Build one preview network for semantic validation: merge proposed evidence aliases, variable declarations, candidate ids, stances, and coordinate names into the preview before validating any constraint or selection. Merge must consume exactly what validation accepted; it may not silently skip an unknown endpoint.
4. Enforce global normalized variable-name uniqueness, owner-subtree visibility, canonical option spelling, candidate-key collision rejection, and legal endpoint matrices. Every rejection includes the accepted spelling/form.
5. Validate provenance: every `evidenceRef` resolves to existing or same-delta evidence; coordinate eliminations require evidence; `repo-evidence` must cite repository/tool/user evidence rather than a free-floating model inference. Preserve `sourceKind` and resolved evidence ids through storage.
6. Decode v7 strictly enough that missing required variable/stance/provenance arrays cannot be mistaken for a valid new checkpoint. Defaults belong at model-output parsing where intended, not at durable-state trust boundaries.

Gate: v6 rejection/v7 resume tests; same-delta variable + stance + coordinate-constraint round trip; duplicate/shadow/cousin/canonical-label tests; invalid endpoint and unresolved-provenance tests; serialize/deserialize equality for every v7 field.

### Step 3 — Kernel (~1.5–2d)
Pipeline D2 + TRANSITIONS consolidation in reducer.ts. Pure functions throughout.

#### Step 3 correction plan — close the audited kernel gaps

**3.0 Entry preconditions.** Do not build propagation around a half-migrated state. First make the persisted/checkpoint version `7` everywhere and reject every earlier version; validate coordinate endpoints against the same preview network used for newly declared variables and stances, so one synthesis delta may declare `v`, stance candidates on `v:L`, and cite `v:L` in a constraint. Gate: a v6 resume is rejected, a v7 resume succeeds, and a same-delta declaration + coordinate constraint round-trips without coercion.

**3.1 One canonical primal graph.** Replace the current incremental “union every occurrence” check with two pure phases:

1. Derive a set of unique undirected variable-pair edges. A coordinate-to-coordinate constraint contributes its variable pair. A candidate touching variables `{v1…vn}` contributes every unordered pair (the clique required by Part B), after removing repeated stances on the same variable.
2. Run union-find once over those unique edges. Repeated occurrences of the same pair are one graph edge and are legal; only an edge whose distinct endpoints are already connected through other edges closes a cycle. Self-pairs are ignored as graph edges but still undergo ordinary stance/constraint validation.

Reject the entire authored delta atomically with a teaching error that names the cycle-closing pair. Gate: duplicate `A—B` coupling is accepted; `A—B, B—C, A—C` is rejected independent of insertion order; one candidate touching `A,B,C` is rejected because its primal clique is cyclic; shuffled candidates and constraints yield the same verdict.

**3.2 Make coordinate constraints total or illegal—never inert.** Retain the planned coordinate forms and give them one explicit derivation path:

- `refutes(evidence|task|selected-candidate, v:L)` marks `v:L` unavailable only with at least one resolved evidence reference.
- `excludes(selected-candidate, v:L)` marks `v:L` unavailable only while its subject candidate is selected and with at least one resolved evidence reference.
- Any other coordinate endpoint/kind combination is rejected before merge.

Both forms feed the same derived unavailable-coordinate set; neither tries to eliminate the coordinate as if it were a candidate id. A candidate with `requires(v,L)` is eliminated when `v:L` is unavailable; `prefers` never is. Gate: cited coordinate `refutes` and active cited coordinate `excludes` prune, inactive/uncited forms do not land, and every schema-accepted coordinate constraint has an observable kernel effect.

**3.3 Separate authored state from one deterministic propagation pass.** Refactor `propagateNetwork` into named pure stages with no hidden scheduling writes:

1. Restore candidate disposition/evidence/reasons from authored fields.
2. Validate and index variables, coordinates, candidates, constraints, ancestry, and the primal forest.
3. Apply the unchanged intra-region candidate rules to a fixed point.
4. Sweep leaves→root to collect evidence-backed unavailable coordinates and eliminate requiring candidates, retaining the originating constraint/evidence witness.
5. Sweep root→leaves to derive bindings from selected candidates and eliminate visible `excludes(v,L)` and `requires(v,L′≠L)` stances.
6. Force only singleton viable candidate domains; repeat stages 3–5 until disposition/binding state stabilizes.
7. Derive region statuses and contradictions once from the stable state.

The pass must never copy a derived elimination or selection into authored fields. `prefers` is projected only and cannot affect viability or forced collapse. Gate: double propagation is byte-equivalent in derived state and does not bump revision; shuffled authored insertion order produces the same canonical disposition, bindings, witnesses, and statuses.

**3.4 Detect binding contradictions explicitly.** A variable may have zero or one derived bound label. Two active selected candidates requiring different labels for the same variable are a contradiction with both candidate ids and both labels as witnesses; do not rely on incidental self-elimination or map overwrite. A selected candidate whose own requirements are impossible is eliminated only if that follows from authored constraints, after which selection/domain status is recomputed. Gate: conflicting binders produce the same witnessed contradiction in either insertion order and projection never silently displays only the last binding.

**3.5 Make invalidation remove the whole conditional slice.** On re-selection or reopen, calculate the descendant region set first, then atomically:

- remove descendant regions and their candidates;
- remove variables whose `ownerRegionId` is in that set;
- remove every constraint whose endpoint is a removed region/candidate/variable coordinate or whose author activation belongs to a removed region;
- supersede live activations for removed regions and remove their non-live activations;
- retain global evidence and observed artifacts for audit, but remove their references from deleted structures;
- recompute all bindings, unavailable coordinates, domains, statuses, and witnesses from surviving authored state.

Reopening the owner region itself keeps variables owned by that region only when their declarations remain part of the surviving authored region state; reopening with an underspecified/cleared domain removes those declarations as well. State this choice in the reducer API rather than inferring it from whether acceptance criteria happen to be empty. Gate: `reopen-resets-owned-variables`, descendant-variable removal, stale-coordinate-constraint removal, and unrelated-sibling survival.

**3.6 Produce stable contradiction witnesses.** Replace generic “every candidate was eliminated” results with a deterministic witness containing region id, eliminated candidate ids, and for each final elimination the responsible constraint id or binding `{variableId, valueLabel, originCandidateId}`. Human text is rendered from this data; it is not the only stored proof. Sort ids before storage/rendering so insertion order cannot alter checkpoints or tests. Gate: empty-domain and conflicting-binding tests assert exact structured witnesses, and every derived elimination has at least one live witness.

**3.7 Consolidate lifecycle legality.** Implement the exported `TRANSITIONS` table promised by D1 and route `addActivation`, admission, scheduler choice, and post-result status derivation through it. On every scheduling pass, supersede queued activations that are no longer admitted before deciding whether runnable work exists; an inadmissible stale activation must never block a legal one. Keep model capabilities absent from the table unroutable. Gate: exhaustive `{status × capability}` table test plus a stale-queued-activation regression.

**Step 3 completion gate.** Step 3 is complete only when all 3.0–3.7 tests pass, the Step 5 soundness oracle passes at least 500 deterministic seeds, propagation/order/idempotence tests are green, and no schema-accepted constraint or transition is ignored by the kernel. Existing happy-path tests and typecheck remain green throughout.

### Step 4 — Scheduler & projection (~1d)
`ensureRunnableWork`: propagate → mechanical resolve → queue model activations only for undecidable regions; MRV by viable count then depth. `projectActivationContext` gains `variableStates`. Prompt rewrite: nearest-neighbor directions wording. sourceKind plumbed into schemas/TUI badges inside existing region pane — no new panes.

#### Step 4 correction plan — expose only the state a degenerative node can use correctly

1. Make scheduling order explicit: propagate to stability; supersede inadmissible queued work; mechanically resolve singleton/contradiction/status transitions; then queue models only for regions the kernel cannot advance. Rank unresolved regions by viable count, then greater depth, then stable region id.
2. Replace ad-hoc shared-choice projection with `variableStates` entries containing `{id, name, declaredAt, knownLabels, binding?, bindingWitnesses[], unavailableLabels[], unavailabilityWitnesses[]}` for variables visible at the activation. Never overwrite conflicting binders in a map; project the contradiction and all witnesses.
3. Project current-region candidates with their stances, status, and elimination witnesses. Project only collapsed ancestry, visible inherited bindings, own region slice, and explicitly referenced facts/artifacts. Do not leak cousin-private variables or unrelated evidence.
4. Preserve constraint provenance in projections and semantic snapshots: include `sourceKind` and resolved `evidenceRefs`. Add compact provenance badges to the existing region pane; do not add a new pane.
5. Rewrite each node prompt around one operation and one output grammar. For synthesis, explicitly request nearest-neighbor directions at the current decision boundary, require stances on already visible variables, permit a new variable only for a genuinely missing dimension, and prohibit finer-detail decomposition. Give teaching errors/examples for the most common malformed outputs.
6. Add semantic snapshot fields for visible variables, bindings, unavailable coordinates, stances, and witnesses so the user can inspect what the kernel told each LLM. Keep raw hidden controller bookkeeping out of prompts.

Gate: MRV/depth/id ordering test; stale-queue test; conflicting-binding projection test; cousin/privacy and large-unrelated-context locality tests; sourceKind schema→projection→snapshot→TUI round trip; prompt vocabulary/length tests; full graph fixture demonstrates that a child receives inherited bindings without receiving unrelated root evidence.

### Step 5 — Proof harness (~1.5d)
(a) Brute-force soundness oracle: seeded generator builds random forests (≤5 regions × ≤4 directions), random stances/constraints along forest edges, and enumerates all assignments. For every propagated elimination, the eliminated coordinate occurs in no valid assignment under the authored facts; equivalently, every coordinate occurring in a valid assignment remains viable. N≥500 seeds. Equality between propagated and globally consistent domains is neither required nor claimed unless a later, separately specified arc-consistency algorithm earns that stronger contract.
(b) Zero-model mechanical fixtures: begin from a pre-authored configuration whose remaining transitions are entirely kernel-determined, set `runtime.call` to throw, and verify completion without another model decision. This proves the tested mechanical path does not depend on a hidden LLM call; it is an integration check, not a general proof of kernel correctness.
(c) Order-independence under shuffled insertion; idempotence (double-propagate ≡ one, revision stable).
(d) Locality test: projection size bounded by refs.
(e) Named units: requires-dies-on-remote-refute, binding-prunes-descendants, prefers-never-eliminates, cousin-reference-rejected, shadowed-name-rejected, reopen-resets-owned-variables, sourceKind round-trip.

#### Step 5 correction plan — test the contract rather than the vocabulary

1. Build a deterministic seeded generator for valid forest configurations. Generate region trees, owner-visible variables, canonical labels, candidates, stances, bindings, and evidence-backed constraints within the accepted endpoint language. Log the seed and minimized configuration on failure.
2. Implement an independent brute-force interpreter that does not call reducer helpers. Enumerate assignments and candidate selections, evaluate authored `requires`/`excludes`/`refutes` semantics, and compare them with propagated eliminations. Assert soundness only: the kernel never eliminates a coordinate/candidate occurring in a valid assignment.
3. Run at least 500 fixed seeds in the normal suite. Add a larger optional stress count behind an environment flag; deterministic normal tests must remain fast enough for every step gate.
4. Add permutation tests that shuffle regions, candidates, stances, constraints, and evidence insertion independently. Compare canonical derived snapshots, structured witnesses, terminal statuses, and revisions.
5. Add full idempotence tests: `propagate(propagate(x))` equals `propagate(x)` in all derived data and revision. Include singleton collapse, remote refutation, conflicting bindings, equivalent candidates, and empty domains.
6. Add zero-model fixtures starting from explicitly pre-authored mechanically decidable configurations. Set `runtime.call` to throw immediately and assert no call occurs, the expected kernel transitions finish, and the fixture does not smuggle in a precomputed terminal result.
7. Add locality/property tests with hundreds of irrelevant cousin facts, artifacts, variables, and constraints. Assert projected content and serialized size change only for allowed own-slice, ancestry-binding, and explicit-reference additions.
8. Complete the named regression matrix: duplicate-edge-is-legal, three-variable-clique-cycle, same-delta coordinate, coordinate-excludes, remote-refute, descendant-binding prune, prefers survival, cousin rejection, normalized-name collision, owner-variable invalidation, stale coordinate cleanup, structured contradiction witnesses, stale queued activation, and full `sourceKind` round trip.

Gate: 500-seed oracle green, all permutation/idempotence/zero-model/locality/named tests green, failures print reproducible seeds, full suite/typecheck green, and no test asserts a stronger completeness property than the kernel promises.

### Step 6 — Docs & evidence (~½d)
GRAPH/SPEC rewritten to match reality; TODO items closed; real-run captured (TODO.md:108).

#### Step 6 correction plan — make claims follow evidence

1. Update GRAPH and SPEC only after Steps 0–5 gates pass. Remove wake/wait, old checkpoint versions, fixed-depth wording, and any claim not represented in code and tests.
2. Document the exact authored-versus-derived boundary, coordinate endpoint matrix, visibility rule, forest definition, propagation soundness limit, invalidation semantics, transition table, scheduler ordering, and terminal limits.
3. Update TODO checkboxes one assertion at a time with a test/code reference. Reopen any currently checked item whose end-to-end behavior is absent.
4. Capture one real non-mocked run that declares a variable, propagates evidence across LOD, prunes a direction, decomposes the survivor, implements, verifies in isolation, and exposes witnesses/provenance in progress output. Preserve the run id, commands, relevant event excerpt, and changed-file/check evidence.
5. Run a final docs-to-code vocabulary search and full verification suite; report known non-goals without presenting them as defects.

Gate: no stale schema/wake/role terminology, every completion claim links to passing evidence, the real-run record is reproducible, TODO reflects reality, and the final diff contains no generated archives or unrelated user files.

Rough implementation estimate: ~5.5–7.5 engineering days. This is planning input only, not a delivery guarantee or acceptance gate; the per-step green gates determine progress.

## Part F — Anti-assumption process

1. Traceability: every added type/function cites its clause in the commit body; uncited code = revert.
2. Assumption register maintained in PR description; each entry resolved before merge — none silently encoded.
3. No silent coercions: every model-input rejection returns teaching text.
4. Cut-list is binding: evaluate/select/certify, entropy, wake conditions, value registry, TUI panes — reopening any requires a demonstrated failure.

## Non-goals

SAT libraries, off-tree constraints, stochastic restarts, learned heuristics, solver-replaces-model. Boundary stays honest: the kernel guarantees internal consistency of authored constraints, not their truth.
