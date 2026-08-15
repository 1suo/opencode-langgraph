# Progressive LOD Collapse Graph

## 1. Purpose

Implement a LangGraph workflow, used through the existing **opencode-langgraph** integration in OpenCode, for solving software-development tasks by **progressively collapsing uncertainty into implementation detail**.

The system must not immediately generate a complete solution or detailed implementation plan.

Instead, it repeatedly transforms:

```text
human task
+ repository reality
+ accumulated context
+ accumulated constraints
+ accepted higher-level decisions
```

into a solution that is **one level more concrete**.

Each collapse should introduce only detail reasonably forced by:

* the original task;
* repository evidence;
* existing architecture;
* existing patterns and reusable code;
* applicable project constraints;
* applicable engineering/domain practice;
* first principles;
* accepted decisions from higher LODs.

The process continues until individual plan branches are concrete enough to implement without making significant architectural decisions during coding.

The workflow is not a sequence of agents writing increasingly long plans.

It is a **progressive semantic constraint system**:

```text
large valid solution space
        ↓
context + constraints
        ↓
least-controversial collapse
        ↓
smaller valid solution space
        ↓
branch-local detailing
        ↓
implementation
        ↓
runtime evidence
```

---

# 2. Governing principle

At every detailing step ask:

> Given everything currently known, what is the maximum justified specificity we can add at this LOD without making unsupported lower-level decisions?

A valid collapse should:

* reduce uncertainty;
* preserve higher-level intent;
* introduce as few unsupported assumptions as possible;
* fit the actual project rather than an imagined clean-room architecture;
* avoid prematurely resolving decisions belonging to a lower LOD.

The system should postpone a choice when evidence is genuinely insufficient.

It should **not** postpone a choice merely because alternative implementations can be imagined.

---

# 3. Canonical semantic state

At any point the task consists of four major semantic categories:

```text
COMMITTED
Decisions sufficiently established to constrain descendants.

OPEN
Questions that still have materially plausible alternatives.

CONTEXT
Repository/project/external evidence relevant to those questions.

CONSTRAINTS
Rules and preferences restricting valid solutions.
```

The graph repeatedly performs:

```text
ASSEMBLE / UPDATE CONTEXT
        ↓
DERIVE / UPDATE CONSTRAINTS
        ↓
SELECT ACTIVE PLAN NODE
        ↓
COLLAPSE ONE LOD
        ↓
EVALUATE
        ↓
MERGE INTO GLOBAL PLAN
```

Execution adds another loop:

```text
IMPLEMENT
   ↓
OBSERVE REALITY
   ↓
confirm
or
reopen affected LOD
```

---

# 4. Original task is immutable

The human-written task must remain available verbatim throughout the entire run.

Derived interpretations may clarify it but must never replace it.

Every semantic operation has access to:

```text
ORIGINAL TASK
+
CURRENT DERIVED STATE
```

If a later plan conflicts with the original task, the original task wins unless the human explicitly changes it.

---

# 5. LOD model

The LOD structure is assumed to be configurable.

Do not hard-code a universal:

```text
requirements → interfaces → pseudocode → skeleton
```

A typical ladder may resemble:

```text
LOD 0 — Task interpretation
LOD 1 — Solution direction
LOD 2 — Architecture / responsibilities
LOD 3 — Components and interactions
LOD 4 — Concrete change structure
LOD 5 — File/symbol/code-chunk plan
LOD 6 — Implementation
```

Each LOD definition should contain:

```yaml
id:
objective:
expected_detail:
must_resolve:
must_not_resolve_yet:
completion_criteria:
```

Example:

```yaml
id: architecture

objective:
  Determine how the requested behavior should fit the existing system.

expected_detail:
  - responsibility boundaries
  - ownership
  - relevant data/control flow
  - abstractions to reuse
  - abstractions that must change

must_resolve:
  - which subsystem owns the behavior
  - which existing concepts remain valid

must_not_resolve_yet:
  - exact local helper names
  - literal code
  - incidental refactors
```

A LOD is complete when remaining uncertainty primarily belongs to the next LOD.

---

# 6. Multi-hierarchy plan

The evolving plan is not a sequence of monolithic documents.

It is a **hierarchical plan tree with optional cross-branch dependency edges**.

Conceptually:

```text
Root task
├── A. Domain/state change
│   ├── A1. Representation
│   └── A2. Migration
├── B. Runtime behavior
│   ├── B1. Service behavior
│   └── B2. Compatibility
└── C. User surface
    ├── C1. Interaction
    └── C2. Rendering
```

Cross-branch relationships may additionally express:

```text
depends_on
provides
consumes
constrains
```

Therefore the canonical structure is logically a DAG even if hierarchy is used for decomposition and presentation.

---

# 7. Plan node model

Each plan node should contain approximately:

```ts
PlanNode {
  id
  parentId
  lod

  goal
  rationale

  status

  committedDecisions
  unresolved

  constraints
  evidenceRefs

  children

  dependsOn
  provides
  consumes

  implementationRefs
  verification
}
```

Possible statuses:

```text
OPEN
DETAILING
COMMITTED
IMPLEMENTABLE
IMPLEMENTING
VERIFIED
INVALIDATED
```

---

# 8. Branch-local detailing

A low-level detailing agent must **not receive the entire plan hierarchy by default**.

The complete plan lives in shared graph state.

Each detailing invocation receives a **projection** of that state for one active node.

This is fundamental.

```text
GLOBAL PLAN / DAG
       ↓
select active node
       ↓
project relevant state
       ↓
detail exactly one node
       ↓
merge result back
```

The projection should contain:

1. original human task;
2. root → current-node ancestry;
3. current node;
4. global `MUST` constraints and important invariants;
5. relevant `SHOULD`/`PREFER` constraints;
6. relevant dependency contracts from sibling/neighbor nodes;
7. repository evidence relevant to the current node;
8. applicable skills/practice profile;
9. current LOD definition.

It should **not** contain full unrelated sibling subtrees.

---

# 9. Context projection

Implement an explicit operation similar to:

```ts
projectContext(nodeId, lod): NodeWorkingContext
```

Conceptually:

```text
Original task

Root intent

Ancestor decisions
  ↓
A
  ↓
A1

Global invariants

Relevant sibling/dependency contracts

Relevant context/evidence

Current node

Current LOD objective
```

Example:

```text
Original task:
Implement feature X.

Ancestor:
A. Data model must represent Y explicitly.

Current node:
A1. Define representation of Y.

Relevant dependency contracts:
A2 requires the representation to be migratable.
B consumes Y through FooRepository.

Do not detail:
A2, B, C.
```

The agent may still discover that the current decomposition itself is wrong.

---

# 10. Plan-node disposition

Detailing must not assume every existing node is correct.

A collapse may return:

```text
REFINE
REMOVE
MERGE
SPLIT
REOPEN_PARENT
```

Example:

```text
Current node:
Add caching layer.

Repository evidence:
Caching is already correctly performed at the upstream query boundary.

Result:
REMOVE / REOPEN_PARENT
```

This prevents the hierarchy itself from becoming an anchoring mechanism.

---

# 11. Graph architecture

The main graph should remain conceptually small:

```text
START
  ↓
initialize
  ↓
classify_task
  ↓
prepare_lod
  ↓
select_active_node
  ↓
assemble_context
  ↓
derive_constraints
  ↓
prepare_collapse
  ↓
collapse
  ↓
evaluate_collapse
  ├─ need context       → assemble_context
  ├─ poor candidates    → collapse
  ├─ decomposition bad  → reopen
  ├─ node refined       → merge_plan
  ├─ LOD complete       → prepare_lod
  └─ final plan ready   → execute
                              ↓
                           verify
                         ↙    ↓    ↘
                       repair pass reopen
```

Do not represent every conceptual role as a permanent agent.

---

# 12. Canonical graph state

Approximate state:

```ts
TaskState {
  originalTask

  taskProfile

  lodConfig
  currentLOD

  plan
  activeNodeId

  evidence
  constraints
  practiceProfile
  loadedSkills

  currentProjection
  currentCandidates
  currentEvaluation

  execution
  verification

  discoveries

  history
}
```

Raw model conversations should not become canonical task state.

They may be logged separately for debugging.

---

# 13. Task classification

Classify only enough to determine reasoning and execution strategy.

Useful dimensions:

```text
scope:
  local
  subsystem
  architectural
  unknown

surface:
  UI / UX
  frontend
  backend
  API
  persistence
  infrastructure
  tooling
  performance
  mixed

nature:
  bug
  feature
  refactor
  architecture
  migration
  optimization
  cleanup
  investigation

verification:
  strong automated oracle
  partial oracle
  runtime oracle
  visual oracle
  architectural judgment

likely strategy:
  direct
  reproduce-first
  test-first
  architecture-first
  compatibility-first
  minimal-change
  controlled-rewrite
```

Classification should influence:

* context gathering;
* relevant practices;
* relevant skills;
* candidate count;
* independent evaluation;
* verification strategy.

It must not choose the solution itself.

---

# 14. Context assembly

Context assembly occurs before **each meaningful collapse**, not once.

The assembler receives:

```text
original task
task profile
current LOD
active node projection
committed decisions
unresolved questions
existing evidence
```

Its objective is:

> Gather the smallest additional context required to reliably detail the active node one LOD deeper.

---

# 15. Context sources

Depending on task and LOD, context assembly may inspect:

## Project intent

* root README;
* nested README files;
* architecture docs;
* ADRs;
* project instructions;
* project-local skills.

## Existing architecture

* related modules/components;
* ownership boundaries;
* state/data flow;
* APIs;
* persistence;
* runtime boundaries;
* tests expressing semantics.

## Existing patterns

Search explicitly for the **nearest analogous solved problem**.

Examples:

```text
How are analogous entities represented?

How do similar components communicate?

How are similar async operations handled?

How does another editor preserve user state?

Where does this project already enforce the same invariant?
```

Repository precedent is an important candidate prior.

It is evidence, not absolute law.

The existing pattern may itself be the thing the task needs to correct.

## Existing libraries

Inspect:

* project dependencies;
* framework capabilities;
* standard library;
* internal utilities.

Avoid introducing parallel machinery where an adequate facility already exists.

## Existing reusable code

Find relevant:

* components;
* functions;
* types;
* hooks;
* services;
* commands;
* validation;
* persistence utilities.

## Likely task-specific failure modes

Identify plausible ways an implementation could look correct while actually failing the task.

Do not produce a generic software-quality checklist.

Examples:

### UI

```text
losing unsaved user state
adding unnecessary interaction
rendering correct output from stale state
lag from needless recomputation
hiding common actions behind extra UI
```

### Backend

```text
partial state mutation
non-idempotent retries
race conditions
silent error swallowing
incompatible transaction boundaries
```

### Architecture

```text
fixing the symptom rather than ownership
duplicating an existing concept
leaking implementation concerns across boundaries
preserving a bad abstraction only because it exists
```

## External knowledge

Use external/current research when repository knowledge and model knowledge are insufficient.

Record why it matters and where it came from.

---

# 16. Context is demand-driven

Do not produce repository summaries.

Context assembly should ask concrete discriminating questions.

Example:

```text
Current disagreement:
Should entity compatibility live in block construction or consumption?

Need to know:
- all consumers of the block type;
- existing compatibility boundary;
- whether other values remain canonical until consumption;
- tests indicating expected entity semantics.
```

Then gather exactly that evidence.

A normal loop may be:

```text
collapse
→ disagreement
→ NEED_CONTEXT
→ inspect
→ collapse
```

---

# 17. Context representation

Canonical context should use compact evidence records:

```ts
Evidence {
  id
  claim
  kind
  source
  relevance
  confidence
}
```

Kinds may include:

```text
human
code
runtime
test
documentation
external
inference
```

Example:

```yaml
claim:
  Structured type compatibility currently applies entity restrictions
  when sockets are connected.

kind:
  code

source:
  src/graph/typeCompatibility.ts:88-132

relevance:
  Determines whether ComposeBlock requires entity ownership.

confidence:
  strong
```

Raw source remains retrievable but is not blindly copied downstream.

---

# 18. Constraint system

Constraints are typed by strength.

```text
MUST
Violation makes the solution invalid.

SHOULD
Strong preference; deviation needs a reason.

PREFER
Use where it does not materially worsen the solution.

OPTIONAL
Potential improvement; not task success.
```

A constraint record contains:

```ts
Constraint {
  id
  statement
  strength
  source
  appliesTo
  rationale
}
```

---

# 19. Constraint sources

Constraints may originate from:

* explicit human request;
* repository semantics;
* architecture;
* existing behavior;
* compatibility requirements;
* tests;
* local skills;
* framework constraints;
* domain practice;
* task-specific engineering principles;
* justified first-principles reasoning.

A generated preference must never silently become a `MUST`.

---

# 20. Practice profile

Do not inject a universal giant “best practices” prompt.

Derive practices relevant to the current task.

Example user-facing task:

```text
MUST preserve user data unless semantics explicitly change.

SHOULD minimize unnecessary interaction steps.

SHOULD preserve responsiveness.

SHOULD keep important state transitions recoverable and understandable.

PREFER established interaction patterns where they are already good.
```

Example backend task:

```text
MUST preserve data consistency.

MUST expose meaningful failure.

SHOULD tolerate retries where semantics permit.

SHOULD avoid unnecessary duplicated state.

SHOULD preserve observability.
```

Example architecture task:

```text
MUST address the underlying responsibility/ownership problem.

SHOULD reduce duplicate concepts.

SHOULD preserve coherent dependency direction.

PREFER existing architectural vocabulary unless that vocabulary is part
of the problem.
```

These are not universal templates; generate the actual relevant profile.

---

# 21. Skills

Before a meaningful collapse or execution step, determine which project/local/external skills are relevant.

Examples:

```text
karpathy-guidelines
UI/UX guidance
testing
database
framework-specific skills
project architecture skill
```

Load only relevant skills.

Extract applicable guidance into context/constraints rather than blindly appending every skill in full where possible.

A newly discovered useful skill may also become a final broader proposition.

---

# 22. Broader discoveries

During context gathering and implementation, agents may discover useful but out-of-scope improvements.

Examples:

* reusable library already available;
* repeated abstraction that should later be unified;
* missing local project skill;
* architectural debt;
* unrelated UX defect;
* reusable testing primitive.

Do not expand active scope automatically.

Record these under:

```text
DISCOVERIES / BROADER PROPOSITIONS
```

and include them in the final summary.

---

# 23. Collapse controller

The controller determines:

```text
what node is active?
what LOD is it at?
what exactly must be resolved next?
does sufficient context exist?
how controversial is the next refinement?
what candidate strategy is justified?
```

Controller output:

```yaml
node:
lod:
goal:
questions_to_resolve:
relevant_ancestry:
relevant_dependencies:
relevant_constraints:
relevant_context:
strategy:
expected_output_detail:
```

---

# 24. Candidate strategy

Do **not** generate N candidates by default.

Candidate generation depends on controversy.

## Low controversy

One collapse candidate.

```text
collapse
→ evaluate
```

## Moderate controversy

Generate materially distinct alternatives, either in one call or independent calls.

## High architectural controversy

Use independent inference.

```text
candidate A
candidate B
optional candidate C
      ↓
fresh evaluator
```

## Missing factual basis

Do not generate speculative alternatives.

```text
identify discriminating question
→ gather evidence
→ collapse
```

---

# 25. Candidate generation from the decision boundary

The detailing agent must solve only:

> What are the most reasonable ways to refine **this active node exactly one LOD deeper**?

It must not solve the entire root task.

Its input is the node projection, not the whole task plan.

---

# 26. Candidate seeding

Candidate generation should be informed by three useful priors.

When materially applicable, consider:

### Existing-project continuation

> What is the closest valid continuation of the architecture/pattern already used by the project?

### First-principles solution

> What is the simplest coherent solution if reasoning from the actual requirements and invariants?

### Materially superior alternative

> Is there a different approach justified because it materially improves correctness, architecture, usability, performance, or maintainability?

Do not generate the third candidate merely to create variety.

If there is no materially justified alternative, omit it.

This is a search aid, not a permanent three-agent structure.

---

# 27. Candidate schema

Each candidate should expose the assumptions and architectural cost it introduces.

```ts
DetailCandidate {
  id

  disposition:
    | "REFINE"
    | "REMOVE"
    | "MERGE"
    | "SPLIT"
    | "REOPEN_PARENT"

  refinement

  children

  rationale

  evidenceUsed
  constraintsSatisfied

  assumptionsIntroduced
  deviationsFromExistingPatterns

  unresolved
  contextNeeded

  risks
}
```

`children` may be absent for dispositions such as `REMOVE` or `REOPEN_PARENT`.

---

# 28. Why assumptions must be explicit

A superficially attractive candidate often reveals its weakness through assumption cost.

Example:

```text
Candidate A:
- reuse existing connection validator;
- no new public abstraction;
- assumes only that the validator is the canonical consumption boundary.

Candidate B:
- introduce CompatibilityService;
- migrate callers;
- assumes compatibility should become a standalone service;
- deviates from existing architecture.

Candidate C:
- encode restrictions in block type;
- conflicts with task-level entity independence.
```

The evaluator should see these differences explicitly rather than infer them from polished prose.

---

# 29. Evaluation objective: forcedness

Do not evaluate candidates primarily by how impressive or comprehensive they appear.

Evaluate how strongly the candidate is **forced by available information**.

Useful dimensions:

```text
task fidelity
evidence support
architecture fit
constraint compliance
project-pattern fit
first-principles quality
reuse quality
downstream simplicity

minus:

unsupported assumptions
unnecessary concepts
unnecessary code volume
incidental scope
compatibility breakage
irreversible decisions
avoidable complexity
```

Do not pretend these are calibrated numeric probabilities.

Use explicit ordinal judgments.

---

# 30. Candidate assessment schema

```ts
CandidateAssessment {
  candidateId

  taskFit:
    "strong" | "adequate" | "weak"

  evidenceSupport:
    "strong" | "partial" | "weak"

  architectureFit:
    "strong" | "adequate" | "conflicting"

  constraintsFit:
    "strong" | "adequate" | "conflicting"

  precedentFit:
    "strong" | "neutral" | "deviating"

  assumptionCost:
    "low" | "medium" | "high"

  complexityCost:
    "low" | "medium" | "high"

  reversibility:
    "easy" | "moderate" | "hard"

  blockingIssues: string[]
}
```

---

# 31. CandidateEvaluation schema

Candidate evaluation must return a structured decision used directly for routing.

```ts
CandidateEvaluation {
  assessments: CandidateAssessment[]

  common: Conclusion[]

  preferredCandidateId?: string

  supportedDifferences: Difference[]

  unsupportedAssumptions: Assumption[]

  contradictions: Contradiction[]

  evidenceNeeded: EvidenceRequest[]

  retryReason?: string

  decision:
    | "ACCEPT"
    | "ACCEPT_COMMON_ONLY"
    | "NEED_CONTEXT"
    | "RETRY"
    | "REOPEN"
    | "NEED_HUMAN"
}
```

`preferredCandidateId` is optional.

The evaluator must be able to explicitly say:

> There is currently no justified complete winner.

---

# 32. Common-prefix collapse

When several reasonable candidates share an important semantic conclusion but differ in unsupported lower-level decisions, commit only the common conclusion.

Example:

```text
Candidate A:
Entity validation belongs at connection;
reuse existing compatibility helper.

Candidate B:
Entity validation belongs at connection;
add policy object.

Candidate C:
Entity validation belongs at connection;
move logic into socket validator.
```

Current collapse:

```text
COMMIT:
Entity-specific restrictions are enforced at connection/consumption.

DEFER:
Exact implementation mechanism.
```

This is one of the central mechanisms of the system.

---

# 33. Choosing a complete candidate

Select a complete candidate only when the current LOD actually requires the disputed decision and at least one of the following applies:

* repository evidence differentiates alternatives;
* explicit constraints differentiate them;
* project precedent strongly differentiates them;
* first principles materially differentiate them;
* one candidate has substantially lower assumption/complexity cost;
* the remaining choice is local and easily reversible.

Otherwise:

```text
NEED_CONTEXT
```

is the correct result.

---

# 34. All candidates can be wrong

The evaluator must not be forced to choose among candidates.

If all candidates:

* violate task intent;
* rely on unsupported assumptions;
* conflict with architecture;
* solve the wrong problem;
* introduce unjustified machinery;

return:

```text
RETRY
```

with a precise reason.

Example:

```text
All candidates assume a new persistence abstraction is needed, but none
establishes why the existing transaction boundary cannot support the
requested behavior.
```

The retry prompt should target that defect.

Never use:

```text
Try again and make it better.
```

---

# 35. Context-seeking from disagreement

When candidate disagreement depends on unknown facts, evaluation should formulate the smallest discriminating question.

Example:

```text
A and B differ on whether compatibility belongs in socket construction
or connection validation.

Needed evidence:
Trace all current consumers of StructuredBlock and determine whether
compatibility is already centralized at connection time.
```

Then:

```text
NEED_CONTEXT
→ context assembly
→ candidate generation again
```

---

# 36. Collapse output

A normal accepted collapse should produce:

```yaml
node:
lod:

committed:
  - ...

children:
  - ...

still_unresolved:
  - ...

assumptions:
  - ...

evidence:
  - ...

constraints:
  - ...
```

The exact child schema may vary by LOD.

---

# 37. Plan merge

Accepted detail is merged back into the canonical plan.

The merge operation must:

* preserve the node ID;
* record accepted decisions;
* create/update/remove children according to disposition;
* maintain dependency edges;
* record evidence provenance;
* invalidate descendants if their parent semantics changed;
* leave unrelated branches untouched.

The merge operation should be deterministic graph/state code, not free-form LLM behavior.

---

# 38. Branch progression

Different branches do not need to remain at identical LODs.

For example:

```text
Root                   LOD 2
├── data model         LOD 5
├── service behavior   LOD 4
└── UI                 LOD 3
```

This is expected.

Detail the branch whose next refinement is currently:

* required by dependencies;
* highest value for reducing uncertainty;
* needed before another branch can proceed.

Do not repeatedly rewrite the whole global plan merely because one branch advanced.

---

# 39. Dependency contracts

Sibling branches should communicate through compact contracts rather than full plan exposure.

Example:

```yaml
node: A1

provides:
  - stable persisted entity ID
  - migration path from old records

consumed_by:
  - B1
  - C2
```

When detailing `B1`, provide this contract.

Do not provide A1's entire internal implementation hierarchy unless B1 genuinely depends on it.

---

# 40. Final planning LOD

A leaf is `IMPLEMENTABLE` when the coding agent should not need to make substantial architectural decisions.

Final leaf detail should include:

```yaml
file:
symbols:

operation:
  add | remove | modify | move

purpose:

code_chunks:
  - location:
    current_behavior:
    required_behavior:
    implementation_pattern:
    existing_code_to_reuse:
    constraints:
    dependencies:
    verification:
```

The complete final plan is the union of implementable leaves and their dependency structure.

---

# 41. Final plan requirements

Before implementation, ensure the finalized branches identify, where applicable:

* files to add/remove/modify;
* components/classes/functions/types involved;
* code chunks/regions;
* behavior before;
* behavior after;
* patterns to reuse;
* existing libraries/utilities to reuse;
* ordering/dependencies;
* required removals;
* compatibility implications;
* migrations;
* verification.

Literal code does not need to be generated during planning unless a specific tricky interface/algorithm benefits from it.

---

# 42. Avoid redundant pseudo-implementation

Do not require:

```text
architecture
→ exhaustive pseudocode
→ exhaustive code skeleton
→ final code
```

for every task.

This duplicates inference and prematurely anchors implementation.

Use lower-level sketches only where they remove meaningful uncertainty.

The normal final planning unit is a precise **code-chunk specification**, followed by actual implementation.

---

# 43. Execution strategy

After a leaf or coherent dependent cluster becomes implementable, select the appropriate strategy.

## Normal

```text
implement
→ verify
```

## TDD

Use only when expected behavior is sufficiently established and a useful automated oracle exists.

```text
write failing test
→ ensure it represents accepted semantics
→ implement
→ verify
```

Do not use TDD to decide unresolved product behavior.

## Reproduction-first

For observable bugs:

```text
reproduce
→ preserve reproduction
→ fix
→ verify disappearance
```

## Minimal implementation

Use the:

> smallest maintainable coherent change,

not the fewest characters.

Do not multiply codebase volume without architectural or maintenance value.

## Architectural rewrite

Allowed only when higher-LOD collapse establishes that the existing architecture prevents a coherent solution.

The implementation agent must not independently turn a local task into a rewrite.

---

# 44. Implementation projection

An implementation agent should receive one coherent implementable node or dependency cluster.

Its input should contain:

```text
original task

root → leaf ancestry

accepted architecture relevant to this leaf

global MUST constraints

relevant dependency contracts

leaf implementation specification

relevant source context

relevant skills

verification requirements
```

It does not need the full plan hierarchy.

---

# 45. Plan deviation

Implementation may reveal that planning assumptions were wrong.

Local implementation details may be changed freely when they do not violate accepted semantics.

Meaningful deviation should be returned structurally:

```yaml
plan_deviation:
  assumption:
  observed_reality:
  evidence:
  affected_node:
  estimated_lod:
```

The graph reopens the earliest affected node/LOD.

Do not force the implementation agent to patch around an invalid plan.

---

# 46. Verification

Use the strongest available oracle appropriate to the task:

```text
tests
typecheck
build
lint
runtime behavior
integration behavior
browser interaction
visual comparison
performance measurement
git diff
architecture review
```

Deterministic evidence outranks LLM judgment when available.

---

# 47. Verification independence

Independent verification is useful when errors are likely to be correlated with implementation reasoning.

Examples:

* architecture;
* cross-cutting changes;
* complex behavior;
* important user-facing UX;
* large refactors.

For trivial/mechanical changes it may be unnecessary.

A verifier receives primarily:

```text
original task
accepted commitments
relevant final plan
actual diff
runtime/test evidence
```

not the implementer's self-justification.

---

# 48. Verification failure classification

Classify failure according to the earliest invalid level:

```text
IMPLEMENTATION_FAILURE
Code does not correctly implement a valid plan.

PLAN_FAILURE
The leaf/code-chunk plan is incorrect or incomplete.

ARCHITECTURE_FAILURE
A higher-level responsibility/boundary decision was wrong.

TASK_INTERPRETATION_FAILURE
The original request was misunderstood.
```

Route to the corresponding node/LOD rather than restarting the task.

---

# 49. Human interaction

Normal human workflow:

```text
write task
→ wait
→ receive result
```

The human should not manage:

* individual agents;
* candidate counts;
* LOD transitions;
* context searches;
* reviewers;
* branch projections;
* retries.

Ask the human only when repository evidence and engineering reasoning cannot establish a genuine product decision.

---

# 50. Human-visible task state

Show semantic progress, not agent activity.

Example:

```text
Task: Make Compose Block entity-independent

Plan
✓ Intent
✓ Block value semantics
● Compatibility enforcement
  ├─ ✓ ownership boundary
  └─ ● concrete integration
○ migration
○ tests

Current collapse:
Compatibility enforcement / LOD 4 → LOD 5

Committed:
✓ Blocks are entity-independent values.
✓ Entity restrictions apply at consumption.

Resolving:
• exact existing compatibility path to modify

Human input:
none
```

---

# 51. Final execution summary

On success return a compact summary:

```text
Result

Important decisions

Major files/areas changed

Verification

Plan deviations

Broader propositions
```

Broader propositions remain outside task scope unless separately accepted.

---

# 52. Deterministic code vs LLM work

Implement graph mechanics deterministically.

## Hand-written graph/application logic

* task state schemas;
* plan hierarchy/DAG;
* context projection;
* LOD transitions;
* plan merges;
* constraint strength;
* candidate routing;
* retry bounds;
* reopening;
* dependency tracking;
* verification routing;
* budgeting.

## LLM semantic work

* ambiguous task classification;
* relevance judgments;
* context questions;
* constraint derivation;
* architecture reasoning;
* candidate generation;
* candidate comparison;
* semantic verification.

## Deterministic tools

* file existence;
* symbol lookup where supported;
* repository search;
* tests;
* builds;
* typecheck;
* lint;
* git diff;
* exit status;
* structured schema validation.

Do not ask an LLM to infer facts the environment can establish exactly.

---

# 53. Avoid fake deterministic rigor

Do not implement heuristics such as:

```text
Every generated identifier must already exist in context.
```

New implementation legitimately introduces symbols.

Deterministic validation should establish actual deterministic facts.

Semantic architectural correctness remains a reasoning problem.

---

# 54. Inference discipline

Additional agents/inference are justified by uncertainty, not ceremony.

Therefore:

* no mandatory N candidates;
* no mandatory critic after every step;
* no full-plan regeneration when one branch changes;
* no full transcripts downstream;
* no exhaustive pseudocode by default;
* no repeated repository summaries;
* no agent debates without a concrete disagreement;
* no review loop without bounded termination.

Spend inference where it reduces meaningful uncertainty.

---

# 55. Stalling

A branch is stalled when repeated rounds produce neither:

```text
new useful evidence
nor
new accepted specificity
```

After a bounded number of attempts:

1. state the unresolved question precisely;
2. try one materially different evidence/context strategy;
3. ask the human if it is genuinely a product decision;
4. otherwise terminate that branch with the concrete blocker.

Never allow unlimited critique/retry loops.

---

# 56. Worked example

Consider a simplified task:

```text
Human task:
Saving an existing document sometimes creates a duplicate.
Fix the underlying behavior without breaking creation of new documents.
```

Assume only three planning LODs for this example:

```text
LOD 1 — semantic solution
LOD 2 — architecture/components
LOD 3 — implementation chunks
```

## 56.1 Initial context

Context assembly finds:

```text
DocumentEditor.save()
DocumentRepository.create()
DocumentRepository.update()

DocumentEditor currently decides create/update by checking local draft state.

Other editors route persistence through repository.save(entity).
```

Tests establish:

```text
new document → create new persistent ID
existing document → preserve persistent ID
```

Constraints:

```text
MUST preserve existing document ID on update.
MUST preserve new-document creation.
SHOULD reuse established repository ownership patterns.
PREFER avoid editor-specific persistence rules.
```

---

## 56.2 LOD 1 — semantic solution

Active node:

```text
Fix save semantics.
```

Candidate A:

```text
Editor should distinguish create/update more reliably.
```

Candidate B:

```text
Persistence layer should decide create/update from entity identity.
```

Evaluation:

```text
COMMON:
Saving an existing identified document must follow update semantics;
saving a new unidentified document must follow creation semantics.

DISAGREEMENT:
Whether the editor or repository owns this distinction.

NEED_CONTEXT:
Where is this responsibility owned by analogous entities?
```

No full candidate is committed.

Context assembly checks analogous repositories and establishes that other entity repositories own this distinction.

Accepted LOD 1:

```text
COMMIT:
Persistence semantics depend on persistent identity.

COMMIT:
Create/update choice belongs to repository persistence rather than editor-local state.
```

---

## 56.3 LOD 2 — architecture

Global plan:

```text
Fix save semantics
├── Repository persistence ownership
└── Editor integration
```

Select:

```text
Repository persistence ownership
```

Projection includes:

```text
Original task.

Committed:
Persistence layer owns create/update distinction.

Dependency:
Editor integration will consume a single save operation.

Relevant code:
DocumentRepository.create/update
analogous FooRepository.save
```

Candidate A:

```text
Add DocumentRepository.save(document):
  ID absent → create
  ID present → update.
Reuse create/update internally.
```

Candidate B:

```text
Add generic PersistenceCoordinator shared by all repositories.
```

Candidate C is omitted because no other materially justified design exists.

Evaluation:

```text
A:
strong task fit
strong evidence
strong architecture fit
low assumption cost
low complexity

B:
adequate task fit
weak evidence
deviates from project precedent
high assumption/complexity cost
```

Commit A.

Global plan becomes:

```text
Fix save semantics
├── Repository persistence ownership
│   └── DocumentRepository.save(document)
└── Editor integration
```

Now select `Editor integration`.

Projection does not contain the full internals of repository planning; it receives the contract:

```text
DocumentRepository.save(document)
provides:
- create when identity absent
- update preserving ID when identity present
```

Collapse:

```text
Editor calls repository.save(currentDocument)
instead of owning create/update selection.
```

LOD 2 is complete.

---

## 56.4 LOD 3 — implementation chunks

Select repository node.

Projection:

```text
Root intent
→ repository ownership decision
→ DocumentRepository.save contract
→ relevant repository source
→ tests
```

Collapse:

```yaml
file: src/repositories/DocumentRepository.ts

operation: modify

code_chunks:
  - location: DocumentRepository
    required_behavior:
      Add save(document).
      If persistent ID exists, call existing update path.
      Otherwise call existing create path.
    existing_code_to_reuse:
      - create()
      - update()

  - location: repository tests
    required_behavior:
      Existing ID remains stable.
      Missing ID creates a new document.
```

Select editor node separately.

Projection:

```text
Root intent
→ editor integration decision

Dependency contract:
DocumentRepository.save owns create/update selection.

Relevant editor source.
```

Collapse:

```yaml
file: src/editor/DocumentEditor.ts

operation: modify

code_chunks:
  - location: save handler
    current_behavior:
      editor chooses repository.create/update

    required_behavior:
      call repository.save(currentDocument)

    remove:
      editor-local create/update branch
```

Both leaves are now `IMPLEMENTABLE`.

Implementation proceeds in dependency order.

---

## 56.5 Runtime contradiction example

Suppose implementation discovers:

```text
Imported documents may have temporary IDs that are not persistent IDs.
```

This invalidates:

```text
ID present → update
```

The implementation agent reports a plan deviation.

The graph reopens the repository semantic branch at the earliest affected LOD instead of patching:

```text
if id.startsWith("temp") ...
```

New context is gathered around document identity semantics before collapse continues.

This is the intended behavior.

---

# 57. Acceptance criteria

The workflow is considered correctly implemented when:

1. The original human task remains immutable and available throughout execution.

2. The plan is represented as a hierarchy/DAG rather than repeatedly flattened into monolithic plan prose.

3. Each detailing operation works on one selected node or coherent dependency cluster.

4. Low-level agents receive a **projection** containing ancestry, relevant global constraints, dependency contracts, and relevant repository context rather than the full plan by default.

5. A node is refined only one configured LOD deeper per collapse.

6. Candidate generation is adaptive: one candidate where continuation is strongly constrained and multiple independent candidates only where meaningful controversy exists.

7. Candidate evaluation can return `ACCEPT_COMMON_ONLY` and commit shared supported conclusions without selecting a complete candidate.

8. Candidate evaluation can reject every candidate and route to `NEED_CONTEXT` or `RETRY`.

9. Repository precedent, first principles, assumption cost, architecture fit, and relevant practices participate explicitly in candidate evaluation.

10. Detailing may invalidate its own node through `REMOVE`, `MERGE`, `SPLIT`, or `REOPEN_PARENT`.

11. Final implementable leaves contain concrete file/symbol/code-chunk changes and verification requirements.

12. Implementation agents do not need the complete multi-hierarchy plan.

13. Runtime/test evidence can reopen the earliest affected plan node/LOD.

14. Deterministic evidence outranks model self-report where a deterministic oracle exists.

15. Candidate/reviewer loops are bounded and cannot run indefinitely.

---

# 58. Success criterion

The system is successful when a human can provide a task at approximately the level they would give to a strong engineer—including tasks requiring architecture discovery—and the graph can progressively turn it into a solution and implementation without requiring the human to perform the missing reasoning manually.

The relevant metric is not:

```text
number of agents
number of planning stages
plan length
number of generated alternatives
```

It is:

> **How often can the human specify a task once and receive an implementation they would keep?**

The mechanism intended to improve that metric is:

> **branch-local progressive collapse toward maximum justified specificity, with reality continuously constraining the remaining solution space.**


