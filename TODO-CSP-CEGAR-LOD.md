# CSP + CEGAR + AND/OR LOD redesign

Implement the solution graph as a bounded semantic-domain solver built from
established patterns:

`inspect -> generate CSP domain -> CEGAR challenge -> propagate constraints -> select -> AND/OR decompose`

Every unresolved child region repeats the same cycle. CEGAR acceptance is a
bounded operational check for omitted material solution families; it is not a
claim of mathematical exhaustiveness.

## 1. Domain generation and CEGAR review

- [x] Add a required synthesis operation to each synthesis activation:
  `generate-domain`, `challenge-domain`, or `select-candidate`. Keep the
  existing `synthesize` capability and agent role.
- [x] Add the minimum persistent domain-control state to each region: phase,
  domain revision/fingerprint, CEGAR repair round, and accepted fingerprint.
- [x] Make `generate-domain` return between two and seven mutually exclusive,
  materially distinct solution families at the current LOD. (Later relaxed to
  one-to-seven: exactly one family is accepted only when the boundary genuinely
  admits no materially different alternative, because forced diversity on narrow
  boundaries manufactured duplicate paraphrases; the fresh challenge still
  polices omission.)
- [x] Reject generation output that selects or directly eliminates a candidate.
  Models may propose possible candidates, stances, and evidence-backed
  constraints; the kernel remains responsible for derived dispositions.
- [x] Run `challenge-domain` as a fresh, narrowly prompted activation. Require
  exactly one result:
  - `accept`: no concrete material solution family is missing from the bounded
    local domain.
  - `counterexample`: one concrete missing candidate.
  - `needs-fact`: one precise decision-relevant inspection request.
- [x] Require an acceptance result to reference the exact domain fingerprint
  and every currently viable candidate.
- [x] Merge at most one counterexample candidate per challenge, invalidate the
  previous acceptance, and challenge the enlarged domain again.
- [x] Permit at most two counterexample-repair rounds and seven total candidates.
  If either bound is exceeded, block the region with the exact unresolved
  counterexample instead of silently proceeding.
- [x] Reject normalized duplicate candidates. Use stable candidate identity plus
  normalized proposition and stance signatures; do not rely on prose wording
  alone to claim distinctness.

## 2. CSP/WFC kernel gates

- [x] Prevent authored selection, constraint-derived selection, and singleton
  collapse until the region's accepted fingerprint matches its current domain.
- [x] Include the local decision boundary, candidate identities, propositions,
  stances, derived viability, and operative local constraints/evidence
  references in the domain fingerprint.
- [x] Invalidate acceptance whenever any fingerprint input changes. Unrelated
  graph growth must not invalidate the local domain or enlarge its prompt.
- [x] Propagate hard constraints immediately with the existing kernel, before
  and after acceptance. Preserve its elimination authority, fixed-point
  behavior, idempotence, and order independence; gate only selection and
  singleton-collapse consequences on the accepted fingerprint.
- [x] Route a one-survivor domain through `select-candidate` with basis
  `only-viable`; do not silently collapse it before the coverage gate.
- [x] When several valid candidates remain, apply deterministic lexicographic
  preference tiers in this order (never numerical semantic scores):
  1. Explicit user preference.
  2. Confirmed repository compatibility.
  3. Smaller change scope or novelty.
  4. Lower irreversible risk.
- [x] Keep preferences separate from hard constraints. A preference may justify
  choosing among viable candidates but must never be stored as a refutation or
  elimination proof.
- [x] Require `select-candidate` to compare every viable candidate and cite the
  accepted domain fingerprint. Repository and user preference claims must cite
  their corresponding references.
- [x] If the earliest applicable preference tier has no unique winner, request
  one grounding fact. Block after two semantically identical no-progress
  selection/inspection cycles and report the unresolved comparison.
- [x] If selection discovers a new evidence-backed hard constraint, merge the
  constraint without selecting, invalidate acceptance, propagate, and rerun the
  challenge on the changed domain.

## 3. AND/OR LOD decomposition

- [x] Treat candidates in one region as OR alternatives: exactly one
  non-equivalent solution family is selected.
- [x] Continue representing independently required work as `partOf` AND-children
  and later conditional choices as `refines` children.
- [x] Initialize every new child with an ungenerated local domain so it repeats
  inspection, generation, challenge, propagation, and selection independently.
- [x] Preserve inherited choices and shared variables through the existing
  ancestry rules; a child may choose only within its declared boundary.
- [x] On parent reopen or reselection, purge stale descendants and invalidate
  every affected domain acceptance and queued synthesis activation.
- [x] Keep direct, evidence-backed factual answers as a fast path when the task
  contains no genuine solution choice.

## 4. Schemas, prompts, state, and observability

- [x] Add strict, separate structured-output schemas for domain generation,
  counterexample review, and candidate selection. Do not expose one broad schema
  that permits a node to generate, approve, and select its own domain.
- [x] Compile one short operation-specific prompt for each synthesis activation.
  Define ambiguous terms locally and include only the current boundary,
  criteria, viable candidates, confirmed facts, applicable constraints, and
  required ancestry.
- [x] Explicitly forbid self-approval, vague residual candidates such as
  "something else", invented evidence, direct model eliminations, stale
  references, and unrequested implementation detail.
- [x] Keep the existing six capabilities and role topology. Do not add a global
  possibility ontology, Cartesian coverage axes, numerical semantic scores,
  new LLM roles, or a generic SAT dependency.
- [x] Increment the persisted solution state to version 8. Detect older active
  checkpoints and return a precise incompatibility/start-fresh message rather
  than interpreting them under the new lifecycle.
- [x] Expose each region's current synthesis operation, domain phase, fingerprint,
  CEGAR round, challenge verdict, viable count, and selected candidate in graph
  progress and diagnostics.
- [x] Record prompt characters, generation/challenge/selection calls, validation
  failures, counterexample repairs, domain sizes, no-progress fingerprints, and
  blocked reasons.
- [x] Update the architecture documentation and the main roadmap to describe
  this bounded CSP + CEGAR + AND/OR design. Remove wording that incorrectly
  prohibits the now-approved bounded domain-review behavior while retaining the
  warning against global or Cartesian search.

## 5. Tests and acceptance gates

- [x] Test that generation cannot select, eliminate, emit fewer than two
  candidates, exceed seven candidates, or emit normalized duplicates.
- [x] Test that challenge acceptance must cover the exact current fingerprint
  and all viable candidate IDs.
- [x] Test that a counterexample adds exactly one candidate, invalidates
  acceptance, and schedules another challenge.
- [x] Test that candidate, stance, operative constraint, relevant evidence,
  boundary, and viability changes invalidate acceptance, while unrelated graph
  changes do not.
- [x] Test that authored selection, constraint-derived selection, and singleton
  collapse are rejected before acceptance and work after acceptance.
- [x] Test that soft preferences can choose a candidate without becoming hard
  elimination reasons.
- [x] Test unresolved ties, repeated counterexamples, seven-candidate overflow,
  and repeated no-progress inspection cycles terminate as explicit blocks.
- [x] Test that a new selection-time hard constraint causes propagation and
  rechallenge rather than landing together with a stale selection.
- [x] Extend the declarative CSP oracle with the pre-selection acceptance gate
  while retaining soundness, order-independence, permutation, and full-state
  idempotence checks.
- [ ] Add multi-level fixtures through at least LOD 4 demonstrating parent OR
  selection, AND decomposition, and independent child OR domains.
- [x] Test reopen and reselection invalidation of descendants, fingerprints,
  reviews, and queued activations.
- [x] Add adversarial prompt fixtures for self-approval, combined operations,
  fabricated facts, vague residual sectors, duplicate paraphrases, stale IDs,
  omitted alternatives, and repository text that resembles instructions.
- [x] Update end-to-end runtime fixtures to exercise the three synthesis
  operations and verify bounded prompt growth and activation counts.
- [x] Run the complete test suite, typecheck, production build, and diff checks.
  Treat all four as release gates.

## Done when

- [x] Every genuine decision region forms a bounded OR-domain, survives a fresh
  counterexample challenge, and only then permits CSP propagation to select it.
- [ ] Every selected non-leaf solution decomposes into required AND-children or
  later OR-decisions, and every child repeats the same guarded cycle.
- [x] The graph never claims exhaustive coverage, silently selects an
  unreviewed singleton, converts a soft preference into a hard constraint, or
  loops past its explicit CEGAR/no-progress bounds.
- [x] Existing propagation guarantees and end-to-end implement/verify behavior
  remain green.
