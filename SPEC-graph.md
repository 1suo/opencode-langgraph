# Solution LOD graph — production specification

Status: normative for the built-in `solution-lod` graph.

## Purpose

The package is a generic OpenCode/LangGraph connector. Its built-in graph turns one message into a repository-grounded answer or verified mutation by progressively resolving the solution at the resolution actually required by the task.

Two structures are orthogonal:

1. The solution hierarchy represents the same problem at conditional levels of detail. WFC-style constraint propagation collapses its candidate domains.
2. The agent activation network is sparse message passing. Agents inspect, synthesize, implement, verify, or present exact state deltas.

Agent routing is not WFC, and hierarchy depth is not automatically a LOD.

## LOD invariants

1. A region declares the variables permitted at its current LOD.
2. A region's candidates are mutually distinguishable solution families at that resolution.
3. Finer variables exist only as conditional definitions attached to candidates.
4. Conditional regions materialize only after their parent candidate collapses.
5. `refines` means the same solution at finer resolution; `partOf` means an independent deliverable region.
6. Different regions may remain at different LODs simultaneously.
7. Implementation begins when a required region is actionable, not at a configured depth.
8. Equivalent surviving candidates may be delegated as an implementer-local choice when no unresolved external constraint distinguishes them.
9. A contradiction reopens only the nearest implicated region. Unrelated collapsed regions and all observed artifacts survive.

## Solution state

Checkpoint schema 3 contains regions, candidates, typed constraints, normalized evidence, activations, and observed artifacts. `originalTask` is immutable and the conversation frame is linked to the originating OpenCode message.

Constraint kinds are `requires`, `excludes`, `supports`, `refutes`, `equivalent`, `acceptance`, and `permission`. Controller code propagates them to a fixed point, detects empty domains, performs forced collapse, and exposes conditional children. Models propose deltas; they do not mutate controller bookkeeping.

## Activation network

The static LangGraph is an engine loop:

```text
schedule → acquire-if-mutating → activate → merge/propagate → schedule
```

Each activation specifies a capability, region, exact request, expected delta, stable context references, optional wake condition, sender, state revision, and status. Agents may propose downstream activations. Controller code validates region and context references and suppresses the same capability/region/delta at the same state revision.

Every activation sees the complete capability catalog with each capability's admission condition and output contract. It can request a capability but cannot create sessions, choose models, invent roles, or bypass the controller. This gives agents awareness of their possible downstream connections without uncontrolled recursive spawning.

The built-in capabilities are:

- `inspect`: gather only facts needed to distinguish the current domain;
- `synthesize`: form candidates, constraints, selection, and conditional next-LOD definitions without tools;
- `implement`: execute one collapsed actionable change region;
- `verify`: check artifacts against exact criteria and target failures to regions;
- `present`: render a collapsed read-only answer.

All capability contracts live in `src/core/solution-lod/roles.ts`. The shared invariant prompt forbids finer variables before collapse. Graph nodes supply typed projected payloads; configuration chooses models and scheduling quanta.

## Context and failure semantics

An activation receives the original message, compact preceding conversation, collapsed ancestry, current domain, and only referenced evidence, constraints, and artifacts. Durable facts are stored once and passed by IDs.

Structured schemas enforce shape without small arbitrary prose limits. Invalid JSON, schema errors, timeouts, or a scheduling quantum stop fail the activation locally. The solution state remains available and another novel capability may run. Repeating failed work against an unchanged revision is forbidden. If no capability can produce a novel delta, the run returns a precise blocked result rather than looping.

Workspace status and file content hashes are captured around mutating activations. Actual changes are recorded even when an agent's final output is malformed or interrupted. Pre-existing dirty files remain distinct from files changed during the activation.

Turns, tokens, cache reads, and cost are telemetry and per-call scheduling quanta. They do not cause human budget interruptions or discard solution state. Human input is reserved for genuine decisions or authority that repository inspection cannot supply.

## Completion

A change region moves through actionable, implementing, implemented, and verified. A verifier pass completes it. A bounded defect returns it to actionable; a contradicted solution choice reopens the targeted region. A read-only region completes after presentation. The run completes only when all required live regions are verified or have a verified answer.

## TUI

F8 opens the semantic run view:

- the primary pane is the solution LOD tree with relation, LOD, status, viable-domain count, contributing capabilities, and selection;
- the region pane shows candidates, elimination reasons, conditional children, constraints, evidence, activations, and artifacts;
- `G` shows the distinct activation/message network;
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

A release requires reducer tests for conditional exposure, mixed LODs, propagation, equivalence, convergence, and selective reopening; graph tests for answer and mutation paths, local malformed-output failure, artifact reconciliation, and verifier feedback; TUI view/navigation tests; typecheck/build/pack; clean npm installation; and a real OpenCode mutation with visible F8 state.
