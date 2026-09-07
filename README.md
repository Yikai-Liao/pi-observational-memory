# pi-segment-memory

> Persistent Segment Memory Trees for long Pi sessions.

`pi-segment-memory` records source-backed Observations while a session runs, groups older work into hierarchical Segments, and renders the tree during compaction at a configurable depth.

## Origin and attribution

`pi-segment-memory` is an independently maintained continuation of the MIT-licensed [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) project by `elpapi42` and its contributors. This repository and npm package are released independently. The original license and copyright notice are preserved in [`LICENSE`](LICENSE); the independent modifications are described in [`NOTICE.md`](NOTICE.md).

> [!IMPORTANT]
> V4 is a breaking format change. It does not read or migrate V2/V3 memory. Start a new Pi session after upgrading.

## Why

Repeated free-form summaries lose decisions, failed approaches, exact errors, and completion state. V4 keeps those facts as immutable Observation leaves and adds shorter Segment summaries above coherent historical ranges. Older work can become deeper without deleting its details; `om_read` expands it when needed.

## Memory model

- **Observation** — one durable fact or event, with exact Pi source entry IDs.
- **Segment** — a title, summary, and at least two ordered Observation/Segment children.
- **Root** — the unique node without a parent. The first Observation is Root; the second creates a normal Segment Root.
- **Tree projection** — append-only `om.observations.recorded` entries are replayed from the active Pi branch. Later records update the same logical Segment ID.

Example compacted memory at the recommended `memoryDepth: 3`:

```md
These are your past working memories, organized as a Segment Tree.

# [s_7f4a2c91d0be] Release automation and memory design

Repaired release routing and implemented the Segment Memory architecture.

1. [e1a8459c3b72] The architecture requires deterministic depth rendering.

## [s_04bc86a2fd31] Release workflow repair

Located the routing defect, implemented the correction, and verified the release candidate.

1. [737a2b11bf4a] Investigation traced the defect to ref-aware metadata.
2. [722b3da55001] completed: the corrected workflow passed focused validation.

### [s_91d6e0a4c2b8] Branch routing investigation

Mapped branch creation and manual dispatch to the intended release channels.

1. [c4a7d2e91f30] The workflow selected the wrong path when a release branch was created.
2. [f8b1c6a03d27] The ref-aware route passed focused validation.
```

Every displayed ID is readable with `om_read`.

## Install

Requires Pi 0.81.0 or newer.

```bash
pi install npm:pi-segment-memory
```

After publication, the package is discoverable in Pi's [Package Catalog](https://pi.dev/packages) because this package declares the `pi-package` keyword in `package.json`.

## Release

Releases are published by the `Publish package to npm` GitHub Actions workflow when a GitHub Release is published. The release tag must match the package version, for example `v1.0.0` for version `1.0.0`. The workflow runs the type check and test suite, verifies the tag, and publishes with npm provenance.

The workflow uses npm Trusted Publishing through GitHub Actions. Configure the package's trusted publisher on npm with GitHub user `Yikai-Liao`, repository `Yikai-Liao/pi-segment-memory`, workflow filename `npm-publish.yml`, environment `npm`, and permission to run `npm publish`. No long-lived npm token is required.

Development checkout:

```bash
pi install /absolute/path/to/pi-segment-memory
```

## Configuration

Settings live under `observational-memory` in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`. Project settings override global settings.

Minimal recommended configuration:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openai-codex",
      "id": "gpt-5.6-luna",
      "thinking": "medium"
    },
    "memoryDepth": 3
  }
}
```

This example assumes the user is signed in with a Codex subscription. The recommended Observer configuration uses `gpt-5.6-luna` with medium thinking. When `model` is omitted, Observer uses the active Pi session model and its configured authentication. If a different provider is used, change the override to a provider and model available in the local Pi credentials.

Full configuration, including every available setting:

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "observerChunkMaxTokens": 60000,
    "segmentEveryObserverRuns": 2,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "memoryDepth": 3,
    "model": {
      "provider": "openai-codex",
      "id": "gpt-5.6-luna",
      "thinking": "medium"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

All other settings are optional and use their built-in defaults. `model` and `model.thinking` are optional; when omitted, Observer calls use the session model without inventing a thinking level. The `memoryDepth: 3` value above is the recommended README setting; the runtime default remains `2`.

| Setting | Default | Meaning |
|---|---:|---|
| `observeAfterTokens` | `10000` | Estimated pending source tokens required before a background Observer run. Lower values run more often; higher values create larger batches. |
| `observerChunkMaxTokens` | derived | Maximum source size for one background run. When unset, uses 20% of the model context, with a `60000` fallback and `256` minimum. Forced compaction ignores this cap. |
| `segmentEveryObserverRuns` | `2` | Number of successful non-empty Observation batches between background Segment checks. A compaction always forces a Segment check. |
| `compactAfterTokens` | `81000` | Estimated source-token threshold after the latest compaction boundary for proactive compaction. Manual/window-pressure compaction is independent. |
| `compactAfterTokensMode` | `calibrated` | `calibrated` uses the fixed threshold; `ratio` scales the threshold to the active model context. |
| `compactAfterTokensRatio` | `0.68` | Multiplier used only when `compactAfterTokensMode` is `ratio`; must be between `0` and `1`. |
| `memoryDepth` | `2` | Maximum Segment expansion depth during compaction; Root is depth `0`, and a Segment at the limit keeps its summary without expanding children. |
| `model` | session model | Optional Observer model override. If omitted, Observer uses the active session model. |
| `model.provider` | — | Pi provider ID for the Observer override. Required together with `model.id`. |
| `model.id` | — | Pi model ID for the Observer override. Required together with `model.provider`. |
| `model.thinking` | unset | Optional Observer thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `showWorkerNotifications` | `true` | Shows routine Observer start/completion notifications. Warnings and errors remain visible when this is `false`. |
| `passive` | `false` | Disables background Observer runs and proactive compaction. Manual compaction, commands, and memory tools remain available. |
| `debugLog` | `false` | Writes local diagnostic NDJSON containing counts, IDs, estimates, warnings, and errors. |

See [docs/configuration.md](docs/configuration.md) for exact semantics.

### Adjusting `memoryDepth`

`memoryDepth` controls how far the memory tree is expanded when its contents are injected during compaction. Root is depth `0`; a Segment at the configured limit still shows its title and summary, but its children are not expanded. Using the same tree shaped like `Root → Chapter → Phase → Detail`, the rendered result changes like this:

With `memoryDepth: 0`, only the Root summary is injected:

```md
# [s_root] Project session

Migration and release work for the project.
```

With `memoryDepth: 1`, Root Observations and the Chapter summary become visible:

```md
# [s_root] Project session

Migration and release work for the project.

1. [o_root] The release candidate is waiting for final verification.

## [s_chapter] Release automation

The release workflow was repaired and verified.
```

With `memoryDepth: 2`, Chapter Observations and the Phase summary are added:

```md
# [s_root] Project session

Migration and release work for the project.

1. [o_root] The release candidate is waiting for final verification.

## [s_chapter] Release automation

The release workflow was repaired and verified.

1. [o_chapter] The workflow now routes release branches to the correct environment.

### [s_phase] Branch routing investigation

The routing defect was traced to ref-aware metadata.
```

With the recommended `memoryDepth: 3`, Phase Observations and the Detail summary are also visible:

```md
# [s_root] Project session

Migration and release work for the project.

1. [o_root] The release candidate is waiting for final verification.

## [s_chapter] Release automation

The release workflow was repaired and verified.

1. [o_chapter] The workflow now routes release branches to the correct environment.

### [s_phase] Branch routing investigation

The routing defect was traced to ref-aware metadata.

1. [o_phase] The manual dispatch path passed focused validation.

#### [s_detail] Exact ref verification

The candidate image and Pack reference point to the same release commit.
```

Each increment applies the same rule to the next Segment level: the Segment summary is retained, and its direct Observations and child Segments are expanded when their parent is below the configured depth. Lower values keep the injected memory shorter and more abstract; higher values expose more detail and can use more context. Changing `memoryDepth` changes the rendered view; it does not delete or flatten the stored memory tree.

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
