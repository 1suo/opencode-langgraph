# Solution graph: core composition and problem-solving ideas

This document states the conceptual design of the solution graph. It explains
what kind of reasoning system the graph is intended to be, how its parts compose,
and which guarantees belong to deterministic controller code rather than to an
LLM. It is neither an implementation checklist nor a claim that every mechanism
described here has already shipped. Current behavior is documented in
`GRAPH.md` and `SPEC-graph.md`; unfinished work belongs in the TODO files.

## 1. The central idea: explore broadly, then deepen conditionally

The graph solves a task by progressively constructing and reducing a hierarchy
of constrained decision spaces. It should not immediately produce one detailed
plan and then spend the rest of the run defending it. At each level of detail it
must first establish the local problem boundary and identify the materially
different directions available inside that boundary.

Those directions are solution sectors: complete alternative approaches at the
current resolution. They should represent a reasonable partition of the useful
solution space, not a list of small steps, cosmetic variations, or every
Cartesian combination of low-level choices. The purpose is to consider the
meaningfully different ways the task could be solved before committing to one of
them.

The graph then tests those sectors against the task, known facts, constraints,
dependencies, risks, and existing repository structure. Impossible sectors are
removed only when an authoritative constraint entails their removal. Viable
sectors are compared, and the most justified one is selected. Only the selected
sector is expanded into finer decisions and required deliverables. At that next
LOD, the graph performs the same operation again: form the local space of
reasonable directions, test its coverage, propagate constraints, choose, and
deepen.

This produces deliberate coarse-to-fine reasoning:

```text
frame local problem
  -> form materially distinct alternatives
  -> challenge omissions
  -> propagate facts and constraints
  -> choose a justified survivor
  -> decompose the chosen direction
  -> repeat independently in each unresolved child
```

The breadth is bounded, but it is considered before depth. Detail is generated
gradually, where the selected path makes it relevant. Rejected branches are not
needlessly elaborated, while plausible high-level directions are not silently
lost merely because the first model preferred one of them.

## 2. Two graphs with different responsibilities

The system contains two related but distinct graphs. Treating them as one graph
causes role confusion and makes execution order look like solution structure.

The solution graph represents the problem being solved. Its regions form a
conditional hierarchy of decisions and deliverables. Each region owns a local
objective, boundary, acceptance criteria, candidate domain, applicable evidence,
and constraints. Its edges explain semantic composition:

- OR alternatives are mutually exclusive candidate sectors inside one region.
- `partOf` children are AND-related deliverables that are all required by the
  selected parent solution.
- `refines` children are later choices that become meaningful only after the
  parent direction has been selected.

Different live regions may be at different LODs. One branch may already be
implementable while another still needs inspection or a higher-level decision.
LOD is therefore a property of the solution hierarchy, not the number of agent
calls and not a global phase shared by the entire run.

The activation graph represents work performed on the solution graph. An
activation is one bounded request to one capability: inspect, synthesize, refine,
implement, verify, or present. Activations read a projected slice of semantic
state and return typed proposals. They do not own the solution state and cannot
directly change lifecycle bookkeeping.

The static LangGraph should remain a small controller loop rather than mirror
the potentially large solution tree:

```text
schedule -> acquire if mutation is needed -> activate -> validate/merge
         -> propagate -> schedule
```

This separation lets the solution hierarchy grow dynamically without rebuilding
the orchestration topology. It also makes scheduling, batching, retries,
checkpointing, and permissions controller concerns rather than reasoning content
that every model must understand.

## 3. The problem-solving technique set

The design deliberately combines several established techniques. None of them
alone supplies the entire behavior.

### Constraint satisfaction

CSP provides explicit local variables, candidate domains, constraints,
propagation, contradictions, and collapse. Candidates can state positions on
shared choices. Constraints express requirements, exclusions, equivalence,
support, and refutation with stable endpoints and provenance.

The kernel recomputes the consequences of authored state to a fixed point. It
may eliminate a candidate only when the stored facts and constraint rules entail
that elimination. Empty domains and incompatible commitments become explicit
contradictions with witnesses. A model's dislike, uncertainty, or unsupported
interpretation is not a constraint.

### WFC-style propagation and scheduling

WFC contributes useful operational behavior, not semantic completeness. Every
new fact, constraint, or commitment is propagated immediately. The scheduler
prefers the most constrained unresolved region, analogous to minimum remaining
values or lowest entropy, because resolving it is most likely to expose a
contradiction early and reduce downstream work.

WFC assumes a domain already exists; it cannot determine whether an LLM omitted
an entire family of solutions. A singleton may therefore collapse only after the
local semantic domain has passed its coverage review. Otherwise one generated
candidate would be mistaken for proof that no alternatives exist.

### Counterexample-guided domain completion

Open-ended software tasks do not provide a finite universe from which logical
exhaustiveness can be proven. The graph instead uses a bounded CEGAR-like loop.
A generator proposes a compact local domain. A fresh challenger tries to name a
materially different missing solution family. A concrete counterexample expands
the domain and causes another review; a missing distinguishing fact triggers
inspection.

Acceptance means that no concrete material omission was found within the stated
decision boundary and resource limits. It is an operational coverage result,
not a theorem that every imaginable solution has been enumerated. If review
continues to find omissions beyond the explicit bounds, the graph reports that
unresolved frontier instead of falsely declaring the domain complete.

### AND/OR search and hierarchical decomposition

Selection resolves an OR-domain. Refinement then exposes the AND-related work and
later OR-decisions implied by that selection. This is an AND/OR solution tree
with hierarchical task decomposition: choose one solution family, require all
of its independent deliverables, and defer its lower-level choices until their
context exists.

The hierarchy is conditional. Children of rejected candidates never become live
work. Reopening a parent invalidates only the conditional subtree that depended
on the old choice; unrelated branches, facts, and verified artifacts survive.

### Evidence-driven feedback

Inspection grounds decisions in repository facts. Implementation creates actual
artifacts. Verification checks those artifacts against explicit acceptance
criteria. A local implementation defect returns to implementation; new evidence
that refutes an earlier premise reopens the nearest responsible decision region.

This turns execution and verification into new constraint-generating stages
rather than terminal rituals. Observed failures can prune a shared choice across
every region where that choice is visible, while the recorded evidence explains
why the pruning occurred.

## 4. Authority: models propose, deterministic code disposes

Every model output is untrusted input. Models may propose candidates, variables,
stances, relationships, decompositions, changes, and verdicts. Schemas establish
shape; semantic validators establish whether the proposed operation is legal in
the current state; controller reducers merge accepted data; the kernel derives
all mechanical consequences.

Authored and derived state must stay separate. In particular, an authored
`eliminated` label is not itself an elimination. A candidate becomes eliminated
only through an admissible, referenced rule. On every propagation pass, derived
statuses are rebuilt from authored commitments and current evidence so stale
consequences disappear when their premises disappear.

Evidence also has an explicit authority lifecycle:

- Repository, tool, and immutable user evidence can ground decisions.
- Model inference begins as a hypothesis.
- A hypothesis cannot prune or select until independent evidence validates it.
- Rejected claims cannot silently reappear as established facts.
- Soft preferences can rank viable candidates but cannot impersonate hard
  incompatibilities.

Stable identifiers carry meaning between activations. Agents cite region,
candidate, variable, constraint, evidence, criterion, activation, and artifact
references. Consequential state is never reconstructed by asking a later model
to interpret an earlier model's prose.

## 5. Locality and graph composition

Each region is a bounded local CSP, while shared choices provide controlled
coupling between regions. A variable is visible only in its owner's subtree, so
decisions flow downward as boundary conditions without exposing unrelated
branches. Cross-region propagation follows those explicit shared coordinates,
not vague textual similarity.

The graph should keep coupling sparse and inspectable. Local candidate relations
remain local. Shared-variable constraints connect only the regions that actually
depend on the same choice. If unrestricted cyclic coupling becomes necessary,
that is a measured reason to adopt a general CSP/SAT backend; it should not be
smuggled into prose or hidden inside scheduler behavior.

Composition follows four rules:

1. A parent choice constrains its descendants but does not dictate unrelated
   sibling work.
2. AND-children collectively cover the selected parent's required outcomes.
3. OR-candidates answer one local decision and must not contain independent
   deliverables that should be children.
4. Evidence is stored once and projected by reference only where it can affect
   the receiving operation.

These rules allow global behavior to emerge from small local problems without
giving any one agent the whole graph or asking it to coordinate the entire run.

## 6. LLM nodes are lossy components, not reliable colleagues

Every activation starts an independent LLM session. It may misunderstand a
term, overfit a schema, repeat near-duplicates, invent authority, prematurely
choose, or amplify an earlier ambiguity. The architecture must assume this
degeneration instead of relying on agents to understand one another through
natural-language handoffs.

Meaning therefore lives in one typed semantic contract. Human-readable prompts,
diagnostic JSON, UI views, validation errors, and downstream assignments are
deterministic projections of that contract. They are different views of the same
state, not separately authored paraphrases that can drift apart.

Each prompt must be locally exhaustive but globally small. It states:

- the single operation requested;
- the exact local goal, boundary, and acceptance criteria;
- fixed earlier choices and the only legal reopening condition;
- relevant confirmed facts and explicitly unresolved claims;
- allowed state mutations and forbidden role overreach;
- the authority required for rejection, selection, or verification;
- the valid terminal forms and stopping condition;
- one narrow structured output schema.

Ambiguous project terms are briefly defined where they become operational. One
minimal contrast may distinguish a likely confusion, such as evidence-backed
refutation versus mere preference. Repeating the entire instruction three times
is not robustness: it wastes context and encourages a model to manufacture
differences between equivalent phrasings.

Validation feedback must identify the rejected operation, the exact failed
precondition, and the admissible correction. It should teach the model how to
repair one output without reopening the entire semantic contract.

Tool access follows the same separation. Inspectors observe but do not choose;
synthesizers and refiners manipulate semantic proposals without inspecting or
editing; implementers mutate only an actionable scope; verifiers observe and
test without redesigning; presenters render only supported results.

## 7. Scheduling and efficiency

Efficiency is not achieved by skipping alternative formation or verification.
It comes from avoiding work that cannot affect the result.

The scheduler operates on the unresolved frontier. It propagates before calling
a model, performs deterministic transitions without a model, and invokes an
agent only for a semantic delta the controller cannot derive. Read-only work on
independent regions may run in parallel; mutations are serialized and protected
by a worktree lease.

The main efficiency mechanisms are:

- bounded candidate domains and bounded counterexample rounds;
- MRV ordering to resolve tight regions before expanding loose ones;
- lazy LOD refinement only beneath selected candidates;
- dependency-scoped prompts rather than whole-network serialization;
- normalized deduplication of facts, constraints, candidates, and requests;
- semantic fingerprints that suppress unchanged retries and invalidate only
  affected reviews;
- fixed-point propagation after every activation attempt, including failure;
- explicit no-progress and cycle limits that stop repetition before the global
  activation ceiling;
- fast paths for direct factual answers and already-grounded small corrections.

The graph should measure activation count, retries, prompt size, candidate and
region growth, reopening, blocked reasons, elapsed time, and cost. More solver
machinery, reviewers, scoring, or learned scheduling belongs only after telemetry
shows a concrete failure that the added mechanism would solve.

## 8. Correctness, recovery, and completion

Deterministic graph behavior should satisfy strong mechanical properties even
though semantic coverage is bounded:

- Soundness: every derived elimination has a live authored witness.
- Fixed point: propagation continues until no rule changes the state.
- Idempotence: propagating a stable state again changes nothing.
- Order independence: insertion and parallel completion order do not change the
  canonical result.
- Explicit contradiction: incompatible commitments and empty domains retain
  structured, stable witnesses.
- Stale-result safety: results computed against obsolete or removed regions are
  superseded rather than merged opportunistically.
- Local invalidation: changing one decision removes precisely the conditional
  state that depended on it.

Every controller transition is checkpointed. Inspection shows the semantic
state rather than only model transcripts. Pruning reopens a named region and its
dependent subtree. Resume continues from the surviving checkpoint. Recovery is
therefore a graph operation over explicit state, not a request for another model
to remember and repair an informal conversation.

A region becomes implementable because its contract is bounded and observable,
not merely because a depth limit was reached. Implementation completion is not
task completion. Verification must establish every local criterion against the
actual output, and the complete verified region tree must still cover the
material requirements of the original request. The run finishes only when all
required live regions are verified or answered and no necessary frontier remains
unresolved.

## 9. Honest guarantees and non-goals

The graph can guarantee deterministic lifecycle legality, evidence authority,
constraint-propagation soundness, bounded retries, local invalidation, and
criterion-based verification. It can make omission less likely by forcing a
fresh counterexample search before selection.

It cannot prove that an LLM has named every semantically possible way to solve an
open-ended task. It must never label bounded review as formal exhaustiveness. It
also should not enumerate all combinations globally, expand every rejected
branch, treat LOD depth as correctness, use model confidence as evidence, or add
unconditional overseer agents whose own errors multiply cost and degeneration.

The intended system is therefore neither a free-form multi-agent conversation
nor a conventional solver operating on a fully known domain. It is a durable,
inspectable hierarchical search process in which LLMs propose semantic structure
and perform bounded work, while typed state, evidence rules, constraint
propagation, scheduling, validation, and recovery remain deterministic.
