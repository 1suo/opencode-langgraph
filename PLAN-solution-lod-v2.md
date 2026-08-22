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
2. **Acyclicity is defined and enforced on the primal variable graph**, never inferred from region ancestry: nodes = decision variables; an edge joins two variables whenever one candidate's stance set or one constraint mentions both. Invariant: G stays acyclic (forest), enforced incrementally at merge via union-find — an edge joining two already-connected components is rejected with a teaching error. On forests, the two directional sweeps are complete; the dense/random regime shown hopeless by Chan/Ng/Peng STOC 2024 stays out by construction and by checked invariant.
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

### Step 1 — Rails hygiene (~½d)
Wake conditions deleted entirely (field, waiting status, wake logic, schema knob, test); admission via TRANSITIONS allowlist; authored `"equivalent"` outcome rejected; `MAX_LOD` → configurable `refinementDepthLimit` + floor-usage counter in run result; hardcoded 256-cap → `options.maxActivations`; git-rm ~30 tarballs.

### Step 2 — Schema v7 (~½d)
Types from Part B; validator extensions; pre-v7 checkpoints rejected (established pattern).

### Step 3 — Kernel (~1.5–2d)
Pipeline D2 + TRANSITIONS consolidation in reducer.ts. Pure functions throughout.

### Step 4 — Scheduler & projection (~1d)
`ensureRunnableWork`: propagate → mechanical resolve → queue model activations only for undecidable regions; MRV by viable count then depth. `projectActivationContext` gains `variableStates`. Prompt rewrite: nearest-neighbor directions wording. sourceKind plumbed into schemas/TUI badges inside existing region pane — no new panes.

### Step 5 — Proof harness (~1.5d)
(a) Brute-force oracle: seeded generator builds random trees (≤5 regions × ≤4 directions), random stances/constraints along tree adjacency; enumerate all assignments; projected consistent sets ≡ propagated domains, N≥500 seeds.
(b) Zero-model fixtures: end-to-end completion with `runtime.call` throwing (kernel-correctness proof).
(c) Order-independence under shuffled insertion; idempotence (double-propagate ≡ one, revision stable).
(d) Locality test: projection size bounded by refs.
(e) Named units: requires-dies-on-remote-refute, binding-prunes-descendants, prefers-never-eliminates, cousin-reference-rejected, shadowed-name-rejected, reopen-resets-owned-variables, sourceKind round-trip.

### Step 6 — Docs & evidence (~½d)
GRAPH/SPEC rewritten to match reality; TODO items closed; real-run captured (TODO.md:108).

Total ~5.5–7.5 days.

## Part F — Anti-assumption process

1. Traceability: every added type/function cites its clause in the commit body; uncited code = revert.
2. Assumption register maintained in PR description; each entry resolved before merge — none silently encoded.
3. No silent coercions: every model-input rejection returns teaching text.
4. Cut-list is binding: evaluate/select/certify, entropy, wake conditions, value registry, TUI panes — reopening any requires a demonstrated failure.

## Non-goals

SAT libraries, off-tree constraints, stochastic restarts, learned heuristics, solver-replaces-model. Boundary stays honest: the kernel guarantees internal consistency of authored constraints, not their truth.
