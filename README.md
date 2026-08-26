# pi-observational-memory

> Persistent Segment Memory Trees for long Pi sessions.

`pi-observational-memory` records source-backed Observations while a session runs, groups older work into hierarchical Segments, and renders the tree during compaction at a configurable depth.

> [!IMPORTANT]
> V4 is a breaking format change. It does not read or migrate V2/V3 memory. Start a new Pi session after upgrading.

## Why

Repeated free-form summaries lose decisions, failed approaches, exact errors, and completion state. V4 keeps those facts as immutable Observation leaves and adds shorter Segment summaries above coherent historical ranges. Older work can become deeper without deleting its details; `om_read` expands it when needed.

## Memory model

- **Observation** — one durable fact or event, with exact Pi source entry IDs.
- **Segment** — a title, summary, and at least two ordered Observation/Segment children.
- **Root** — the unique node without a parent. The first Observation is Root; the second creates a normal Segment Root.
- **Tree projection** — append-only `om.observations.recorded` entries are replayed from the active Pi branch. Later records update the same logical Segment ID.

Example compacted memory at `memoryDepth: 2`:

```md
These are your past working memories, organized as a Segment Tree.

# [s_7f4a2c91d0be] Release automation and memory design

Repaired release routing and implemented the Segment Memory architecture.

1. [e1a8459c3b72] The architecture requires deterministic depth rendering.

## [s_04bc86a2fd31] Release workflow repair

Located the routing defect, implemented the correction, and verified the release candidate.

1. [737a2b11bf4a] Investigation traced the defect to ref-aware metadata.
2. [722b3da55001] completed: the corrected workflow passed focused validation.
```

Every displayed ID is readable with `om_read`.

## Install

Requires Pi 0.81.0 or newer.

```bash
pi install npm:pi-observational-memory
```

Development checkout:

```bash
pi install /absolute/path/to/pi-observational-memory
```

## Configuration

Settings live under `observational-memory` in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`. Project settings override global settings.

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "segmentEveryObserverRuns": 2,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "memoryDepth": 2,
    "model": {
      "provider": "openai",
      "id": "gpt-5.4",
      "thinking": "medium"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

`model` and `model.thinking` are optional. When omitted, Observer calls use the session model without inventing a thinking level.

| Setting | Default | Meaning |
|---|---:|---|
| `observeAfterTokens` | `10000` | Pending source tokens before a background run, and additional growth before retrying a successful empty run. |
| `observerChunkMaxTokens` | derived | Background-only source cap: 20% of model context, fallback `60000`, minimum `256`. |
| `segmentEveryObserverRuns` | `2` | Successful non-empty Observation batches between Segment checks. |
| `compactAfterTokens` | `81000` | Proactive compaction source-token threshold. |
| `compactAfterTokensMode` | `calibrated` | Fixed threshold or `ratio` of active model context. |
| `compactAfterTokensRatio` | `0.68` | Ratio-mode threshold multiplier. |
| `memoryDepth` | `2` | Non-negative Segment render depth; Root is depth `0`. |
| `model` | session model | Optional `{ provider, id, thinking }` Observer override. |
| `showWorkerNotifications` | `true` | Show routine Observer notifications. |
| `passive` | `false` | Disable background Observer and proactive compaction only. |
| `debugLog` | `false` | Write local diagnostic NDJSON. |

See [docs/configuration.md](docs/configuration.md) for exact semantics.

## Runtime behavior

### Background

`agent_start` and `turn_end` check pending source growth. One Observer model request returns one recursive `tree` proposal containing new Observations, new nested Segments, and an optional same-ID Root Segment version. Background runs use `observerChunkMaxTokens` and are serialized per runtime.

### Compaction

`session_before_compact` always runs a fresh forced Observer after any queued background run. The forced run:

- rereads the latest active branch;
- flushes all pending source without the background chunk cap;
- forces a Segment check;
- cancels compaction on model/API failure instead of deleting unobserved history.

After success, the validated tree is rendered by `memoryDepth`. Pi's `firstKeptEntryId` still controls only the raw tail.

### Validation

The store rejects malformed persisted events and invalid trees: missing children, duplicate/shared children, multiple parents, cycles, unreachable nodes, reordered Observation leaves, one-child Segments, or Segment text that is not shorter than its direct children. Invalid persisted memory is never silently repaired before compaction or tool reads.

Model proposals use narrower best effort: invalid local Segments are removed and valid children are promoted; the final tree still must pass all invariants.

## Commands and tools

| Surface | Purpose |
|---|---|
| `/om:status` | Tree counts/depth, rendered size, cadence, compaction progress, and validation state. |
| `/om:view` | Render and copy the configured visible depth. |
| `/om:view current` | Render and copy the complete current tree. |
| `om_sessions` | Discover local persisted sessions by path and optional Root keywords. |
| `om_read` | Read a current or exact-session node/subtree; supports Markdown, JSON, JSONL, and file output. |

`om_read` defaults to the current Session Root, `depth: 1`, summaries included, and inline Markdown. Use `depth: -1` for a complete subtree. Exact `sessionId` lookup is not restricted by cwd.

Example tool arguments:

```json
{"sessionId":"01abc...","nodeId":"s_7f4a2c91d0be","depth":-1,"format":"jsonl","outputPath":"reports/memory.jsonl"}
```

## Persistence and boundaries

- V4 uses Pi custom entries; no SQLite, service, or background daemon.
- Only the active branch is replayed.
- Historical persisted sessions are read through Pi's `SessionManager` catalog.
- `--no-session` memory is readable only while that runtime exists.
- Observation source IDs remain available for provenance; `om_read` does not expand raw source text.

## Development

```bash
npm test
npm run typecheck
```

Prompt behavior can be evaluated without storing credentials in the repository:

```bash
set -a; source .env; set +a
EVAL_ENDPOINT='https://example/openai/v1' \
EVAL_MODEL='your-model' \
EVAL_REASONING='medium' \
npx --yes tsx eval/run-observer-eval.mjs
```

`eval/run-memory-tools-eval.mjs` validates `om_sessions` and `om_read` selection/arguments. Both runners require `API_KEY` from the environment and never read or print `.env` themselves.

## Documentation

- [Concepts](docs/concepts.md)
- [How it works](docs/how-it-works.md)
- [Configuration](docs/configuration.md)
- [Architecture plan](docs/segment_memory_architecture_plan.md)

## License

MIT
