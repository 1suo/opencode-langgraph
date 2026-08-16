# Solution LOD graph replacement

This file tracks the clean state-v3 replacement of the fixed progressive-lod pipeline. The solution hierarchy and the agent activation network are deliberately separate: WFC-style constraint propagation resolves the former; sparse message passing drives the latter.

## State and collapse semantics

- [x] Replace generic plan nodes with solution regions, candidate domains, typed constraints, evidence, artifacts, and activations.
- [x] Distinguish `refines` edges (the same solution at finer resolution) from `partOf` edges (independent deliverable regions).
- [x] Materialize conditional child regions only after their parent candidate collapses.
- [x] Propagate `requires`, `excludes`, `supports`, `refutes`, and `equivalent` relations to a fixed point.
- [x] Permit different live regions to remain at different LODs.
- [x] Reopen only the nearest implicated collapsed region after contradiction, preserving unrelated regions and artifacts.
- [x] Treat an equivalent surviving candidate set as implementer-local choice when acceptance constraints cannot distinguish it.

## Agent activation and prompts

- [x] Replace the classifier/scout/decider pipeline with a generic schedule/activate/merge/propagate loop.
- [x] Centralize concise capability prompts for inspect, synthesize, implement, verify, and present.
- [x] Give every activation a precise expected delta and referenced context projection.
- [x] Show every agent the capability pool and let it request targeted downstream activations while controller code validates references, novelty, permission, and duplicate suppression.
- [x] Store conversation, evidence, constraints, and artifacts once; pass stable references instead of replaying whole transcripts.
- [x] Make structured-output failure local to its activation and preserve the rest of the run.
- [x] Reconcile actual workspace mutations after every mutating activation, including timeout or malformed final output.

## Scheduling and completion

- [x] Use budgets as telemetry and scheduling pressure, not repeated human interrupts or normal graph termination.
- [x] Reserve execution and verification capacity before allowing further LOD expansion.
- [x] Wake waiting activations only when their referenced state changes.
- [x] Start implementation when required regions are actionable rather than at a fixed depth.
- [x] Map verifier failures to exact criteria and responsible regions; reopen only those regions.
- [x] Complete only when every required root region is answered or verified and no necessary frontier remains unresolved.

## TUI

- [x] Make the primary view a navigable solution LOD tree with level, relation, viable-domain count, state, active capabilities, and verification status.
- [x] Show the selected region's candidate domain, elimination reasons, constraints, evidence, conditional children, activations, and artifacts.
- [x] Provide a separate activation-network view; never duplicate the solution tree as execution topology.
- [x] Derive every pane from the same latest state event so selections and details cannot become stale.
- [x] Keep raw JSON diagnostic-only and place navigation legends in panel headers.

## Migration and acceptance

- [x] Replace checkpoint schema 2 with schema 3 and explicitly reject old interrupted runs.
- [x] Rename the built-in graph to `solution-lod` while keeping the package a generic OpenCode/LangGraph connector.
- [x] Remove fixed-role, fixed-depth, budget-interrupt, and compatibility fallback code.
- [x] Add reducer tests for conditional exposure, mixed LODs, propagation, equivalence, and selective reopening.
- [x] Add activation tests for sparse context, wake conditions, deduplication, and isolated malformed output.
- [x] Add artifact reconciliation and TUI navigation/view-model tests.
- [x] Run typecheck, unit tests, build, and inspect a clean package tarball.
- [x] Run a real OpenCode task requiring inspection, alternative collapse, finer LOD resolution, implementation, corrective feedback, and verification.
- [x] Fault-test malformed output and scheduling-quantum exhaustion without discarding state or prompting through a budget loop.
