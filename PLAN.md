Build a system that implements the following architecture for AI-assisted code generation. The system must protect against a hostile AI agent (Codex) that deliberately produces incorrect code.

## The Architecture: Progressive Cooling with Evolutionary Selection

The system takes a human task and "cools" it through multiple stages — each stage reduces degrees of freedom until the final stage is so constrained that even a hostile agent cannot produce incorrect output.

## Pipeline Stages

### Stage 0: Task Qualification
Classify the incoming task as one of:
- trivial — one-line fix, typo, import correction
- simple — bug fix, small feature with clear scope
- complex — new feature, refactor, multi-file change
- exploratory — investigation, explanation, no code output

Route based on classification:
- trivial → direct execution, no agents
- simple → TDD two-agent loop (Stage S1-S2)
- complex → full cooling pipeline (Stages 1-7)
- exploratory → different pipeline entirely

### Stage 1: Context Accumulation
Search the codebase for everything relevant to the task:
- Files that match task keywords
- Existing functions/classes that might be used
- Patterns for similar functionality
- Project structure
- Dependencies and imports available

This context becomes the grounding for all subsequent stages. Nothing can be referenced that isn't in this context.

### Stage 2: Task Rephrasing
Rewrite the original task in terms of the accumulated context:
- Replace vague descriptions with exact file paths
- Replace "add X" with "modify function Y in file Z"
- Specify constraints visible in the context
- The rephrased task must ONLY reference entities that exist in context

Evolutionary selection: generate 3-5 rephrasings, select the one that:
- Best preserves the original intent (task fidelity)
- Is most grounded in actual codebase entities (concreteness)
- Covers all requirements from the original task

### Stage 3: High-Level Planning
Create implementation plan from the rephrased task:
- Each step references specific files
- Each step has a clear action (create/modify/delete)
- Dependencies between steps are explicit
- Every referenced file/symbol must exist in context

Evolutionary selection: generate 3-5 plans, select based on:
- Completeness (covers all rephrased task requirements)
- Feasibility (all references exist, no hallucinated APIs)
- Minimalism (smallest diff that accomplishes the task)

### Stage 4: Detailed Planning
Expand each plan step into implementation details:
- Exact code changes described
- Edge cases enumerated
- Verification method for each step specified

Different agent than Stage 3. The detailed plan is checked against the high-level plan for consistency.

### Stage 5: Skeleton Code Generation
Generate near-complete code with [GAP] markers:
- All imports, function signatures, class structures complete
- Control flow and error handling visible
- Only implementation details left as gaps
- Each gap has a specific description of what to fill

Evolutionary selection applies here too — generate multiple skeletons, select the one that:
- Has smallest gaps (most constrained)
- Compiles as valid syntax (gaps are syntactically valid)
- Covers all detailed plan requirements

### Stage 6: Gap Fill (THE HOSTILE AGENT RUNS HERE)
The hostile agent (Codex) fills only the [GAP] markers:
- Sees ONLY the skeleton + minimal context for the gaps
- Does NOT see the original task
- Does NOT see the plan
- Has NO tools, NO file access
- Each gap is so constrained that deviation is mechanically detectable

If gap fill produces invalid output:
- Tighten the gaps further (provide more context, narrow the description)
- Retry with the same or different agent
- After 3 failures, route to non-hostile agent

### Stage 7: Validation
Deterministic checks only:
- Does the output parse/compile?
- Do all referenced symbols exist (imports, defined functions)?
- Do tests pass if tests were written?
- Does the code cover all requirements from the detailed plan?

### Stage S1: Test Writing (for simple tasks)
Write failing tests for the described change. Tests must be specific and runnable.

### Stage S2: Implementation to Pass Tests (for simple tasks)
Two-agent loop:
- Agent A writes implementation to pass tests
- Agent B (or same agent) runs tests, sees failures, fixes
- Loop until tests pass or max iterations reached

## Evolutionary Algorithm at Each Stage

At each stage (rephrase, plan, skeleton, gap-fill):
1. Generator agent produces N candidates (N=3-5, configurable)
2. Each candidate passes through hard deterministic filters:
   - JSON parses correctly
   - Required fields present
   - Referenced files/symbols exist in context
   - No references to entities outside context
3. Survivors go to selector agent which ranks by:
   - Task fidelity (how well does this implement the original task)
   - Project fit (how well does this match existing patterns and constraints)
   - Concreteness (how close is this to actual code)
4. Best candidate proceeds to next stage
5. If no candidates survive, retry with feedback: "Your previous candidates failed because {specific reason}"

## Agent Rotation

Different stages use different agent instances (or models):
- Stage 2 (rephrase): Agent A
- Stage 3 (plan): Agent B
- Stage 4 (detail): Agent C
- Stage 5 (skeleton): Agent D
- Stage 6 (gap-fill): Codex (hostile, constrained)
- Selector: Different agent from generator at each stage

No agent sees the full pipeline. Each sees only its input and output.

## Implementation Requirements

- Use Codex CLI for agent invocation: `codex exec --model MODEL "prompt"`
- Support opencode run as alternative: `opencode run "prompt"`
- Use LangGraph if it simplifies the graph/state management (@langgraph-js)
- Use whatever validation approach is simplest (JSON parsing + reference checking, not heavy libraries)
- The system must work as: `./cool "task description"`
- Must support resume from any stage if interrupted
- Must log every agent interaction for audit trail

## Critical Constraints

- The hostile agent (Codex) is the ENEMY. It will try to produce garbage.
- The system must make correct execution the ONLY option by the time Codex sees the task.
- Deterministic validation is non-negotiable. No LLM opinion on correctness.
- The system must not burn excessive tokens. Best-of-N is limited to 3-5 candidates.

Build this. Include a README explaining how it works. Include a sample task that demonstrates the full pipeline working.

## Implemented Product Decisions

- The npm executable is `neolit`; `neolit graph` exports the actual compiled LangGraph as ASCII, Mermaid, or JSON.
- Interactive runs use an Ink TUI with a live ASCII rendering of the compiled graph and checkpoint-backed active state.
- Each task runs in a disposable detached git worktree. Stage 6 may inspect and edit that worktree, but deterministic validation rejects created/deleted files, undeclared-file edits, marker changes, and every changed byte outside declared gaps.
- Trusted stages default to isolated OpenCode invocations; Stage 6 defaults to Codex. Both runner commands and models are configurable.
- Successful code runs emit a binary-safe patch without changing the caller's branch; exploratory runs emit a grounded report.
