# How Weird Is Your AI Use?

A private desktop app that maps your recent Codex or Claude Code sessions onto Anthropic's published
AI-use categories, then compares your distribution with Anthropic's reference frequencies.

It reports:

- an overlaid histogram across every published task category;
- a distributional uniqueness score based on Jensen–Shannon divergence;
- overrepresented and underrepresented categories;
- Stanford's closed criticality, agency, engagement, and friction rubrics; and
- an inspectable row for every classification.

All session-derived data and model judgments stay on the machine. The app uses a signed-in local
Codex or Claude Code installation to run bounded classifier subagents; it does not need a separate API
key.

## Desktop app

Requirements for development are Node.js 22.12+ and at least one signed-in local agent:

- Codex, from the Codex/ChatGPT desktop app or the `codex` CLI; or
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), available as `claude`.

```bash
npm ci
npm run desktop
```

The Electron window starts the analysis service on a random loopback port and closes it with the app.
The port is an internal transport, not part of the user workflow. Generated session indexes,
classification shards, and results live in Electron's private user-data directory.

Build an installable package for the current platform with:

```bash
npm run package
```

The manual **Package desktop app** GitHub Actions workflow builds macOS, Windows, and Linux artifacts.

## How integration and classifier selection work

The app configures its session source once at startup rather than exposing an in-app platform switch.
An integration can set `AI_USE_PROFILE_SOURCE=codex` or `AI_USE_PROFILE_SOURCE=claude`, or launch the
app with `--source codex` / `--source claude`. Without an explicit setting, the app detects a Codex or
Claude Code launcher environment, then a sole installed local agent, then a sole available session
history. Codex is the final fallback when both platforms are equally available.

The matching local agent classifies the selected history. If that CLI is unavailable but the other
supported local agent is installed, the app falls back to the available agent. Thus a Codex
installation can profile Claude Code sessions and vice versa without uploading the history.

Both coordinator paths use at most three classifier subagents concurrently. Codex loads
`.codex/agents/ai_use_classifier.toml`; Claude Code loads
`.claude/agents/ai-use-classifier.md`. Every output passes the same deterministic validator before it
is merged into the profile.

## What is read

### Codex

- `~/.codex/session_index.jsonl` for task IDs and titles;
- the dedicated local task-summary cache when a summary exists; and
- `codex app-server` task-list metadata when available.

Raw Codex rollout transcripts are never read.

### Claude Code

- top-level session files under `~/.claude/projects/`;
- the dedicated `ai-title` record;
- Claude's compact session summary, when present; and
- a bounded, evenly sampled trajectory of plain human-authored turns.

The Claude importer ignores child-agent transcripts, assistant messages, tool inputs and results,
sidechains, and hidden reasoning. It strips known injected IDE/browser context blocks, caps each human
turn at 500 characters, samples at most 24 turns across the session, and caps classification evidence
at 10,000 characters. This is materially richer than using only the last prompt while remaining much
narrower than a raw transcript export.

Task text is always treated as untrusted input. Generated private data is written with restrictive
permissions under `runtime/` in development and is excluded from Git.

## Statistical comparison

- **Your share:** fraction of the selected recent cohort assigned to a category.
- **Baseline share:** that category's published reference frequency.
- **Percentage-point gap:** your share minus the baseline share.
- **Distributional uniqueness:** `100 × Jensen–Shannon divergence`, rounded to the nearest integer.

The uniqueness score describes category mix, not whether the work is creative, valuable, or hard.

## Reference data

The checked-in source extracts come from Anthropic's
[`enabling-independent-research`](https://huggingface.co/datasets/Anthropic/enabling-independent-research)
release:

- `data/source/stanford_clusters.csv`: mixed Claude.ai and Claude Code request clusters and rubric
  aggregates;
- `data/source/metr_clusters.csv`: Claude Code task-description clusters and frequencies.

`npm run prepare:reference` compiles those CSVs into
`data/reference/anthropic-reference.json`. Closed rubric definitions transcribed from the Stanford
paper's appendix live in `data/reference/rubrics.json`.

## Development server

The desktop app is the primary package. A browser preview remains available for development:

```bash
npm start
```

It binds only to `127.0.0.1:4178`.

Useful commands:

```bash
npm run import:tasks     # Codex
npm run import:claude    # Claude Code
npm test
npm run validate:run -- --run <run-id> --source codex
```

## Project map

- `desktop/`: Electron shell and private workspace setup
- `public/`: dashboard UI
- `server/`: importers, orchestration, validation, and statistics
- `.codex/agents/`: Codex classifier definition
- `.claude/agents/`: Claude Code classifier definition
- `docs/`: classification protocol and coordinator prompts
- `data/reference/`: fixed taxonomies and rubrics
- `runtime/`: private generated inputs and outputs, excluded from Git
