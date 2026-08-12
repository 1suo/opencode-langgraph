# Neolit

Neolit progressively turns an ambiguous coding task into constrained implementation gaps. It uses independent agents for grounding, candidate generation, selection, and skeleton construction, then gives Codex only the disposable task worktree and permission to fill explicit gap ranges. Deterministic checks decide whether the result survives.

## Requirements

- Node.js 22.12 or newer
- Git and ripgrep (`rg`)
- [`opencode`](https://opencode.ai/) authenticated for trusted stages
- [`codex`](https://developers.openai.com/codex/cli/) authenticated for hostile gap filling

## Install and run

```bash
npm install -g neolit
cd your-clean-git-repository
neolit "implement the requested feature"
```

When stdout is a terminal, Neolit opens its live TUI. The graph is derived from the compiled LangGraph and decorated with checkpoint status:

- `✓` completed
- `▶` active
- `○` pending
- `↻` retrying
- `×` failed
- `!` interrupted

Keys: `g` graph, `l` logs, `f` focus/full graph, `q` detach from the display.

For automation:

```bash
neolit run "fix the parser" --no-tui --json
neolit resume RUN_ID --no-tui
neolit attach RUN_ID
```

Inspect the executable graph without starting a run:

```bash
neolit graph --format ascii
neolit graph --format mermaid --output graph.mmd
neolit graph --format json
```

## Routes

1. **Trivial** accepts only a mechanical command shaped like `replace "old" with "new" in path` and requires one exact occurrence.
2. **Simple** generates tests, implements the smallest change, and runs deterministic validation.
3. **Complex** accumulates repository context, evolves grounded rephrasings and plans, creates a constrained skeleton, fills gaps, and validates the patch.
4. **Exploratory** evolves a grounded report and produces no code patch.

Each code-producing run requires a clean git repository and operates in a detached temporary worktree. The caller's branch is never modified. A successful run writes a binary-safe patch under the state directory; an unsuccessful run retains its worktree for resume and inspection.

State defaults to `$XDG_STATE_HOME/neolit/runs`, or `~/.local/state/neolit/runs` when `XDG_STATE_HOME` is unset. Every run contains SQLite checkpoints, immutable prompts and outputs, JSONL audit events, validation data, and its final report or patch.

## Configuration

Copy [`neolit.config.example.json`](neolit.config.example.json) to `neolit.config.json` in the target repository. Candidate count is restricted to 3–5 and gap-fill retries to at most three. Runner commands and validation commands are always executed as argument arrays, never through a shell.

```json
{
  "candidates": 3,
  "trusted": {
    "command": "opencode",
    "args": ["run", "--pure", "--format", "json"],
    "model": "deepseek/deepseek-reasoner"
  },
  "hostile": {
    "command": "codex",
    "args": ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write"],
    "model": "gpt-5.6-sol"
  },
  "validation": [
    { "name": "tests", "command": "npm", "args": ["test"] }
  ]
}
```

The worktree is an integrity boundary for the caller's branch, not a host-security sandbox. Codex can inspect and execute content inside that worktree. Neolit snapshots it before Stage 6 and rejects created/deleted files, undeclared-file edits, changed markers, or any changed byte outside a declared gap.

## Development

```bash
npm install
npm run check
npm run build
npm run demo  # invokes the configured real agents and consumes model tokens
```

The demo creates a temporary git repository and runs the full complex route against it.

## Release

The release helper fails closed unless `main` is clean, `v<package-version>` exists, checks and package inspection pass, and both npm and GitHub authentication are valid:

```bash
npm run build
npm run release
```

It then publishes npm and pushes `main` with tags. Architecture and threat-model details are in [`PLAN.md`](PLAN.md).
