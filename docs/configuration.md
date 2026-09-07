# Configuration

V4 keeps the `observational-memory` namespace and intentionally removes V3 Reflection/Dropper/pool settings.

## Locations and precedence

1. `~/.pi/agent/settings.json`
2. `<project>/.pi/settings.json`
3. `PI_OBSERVATIONAL_MEMORY_PASSIVE` for `passive` only

Project values override global values. Restart Pi or reload extensions after changes.

## Full example

The example assumes the user is signed in with a Codex subscription. The recommended Observer configuration uses `gpt-5.6-luna` with medium thinking. The `model` block is an optional override; if you use a different provider, change it to a provider and model available in the local Pi credentials.

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "observerChunkMaxTokens": 60000,
    "segmentEveryObserverRuns": 2,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "memoryDepth": 2,
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

Everything is optional.

## Reference

| Setting | Type | Default | Controls |
|---|---|---:|---|
| `observeAfterTokens` | positive integer | `10000` | Pending source estimate required for background Observer. |
| `observerChunkMaxTokens` | positive integer | derived | Background Observer source cap only. |
| `segmentEveryObserverRuns` | positive integer | `2` | Successful non-empty Observation batches between Segment checks. |
| `compactAfterTokens` | positive integer | `81000` | Proactive source-entry compaction threshold. |
| `compactAfterTokensMode` | `calibrated` or `ratio` | `calibrated` | Fixed or context-scaled proactive threshold. |
| `compactAfterTokensRatio` | number in `(0,1)` | `0.68` | Ratio-mode multiplier. |
| `memoryDepth` | non-negative integer | `2` | Maximum Segment expansion depth from Root. |
| `model` | object | unset | Optional Observer model override. |
| `model.provider` | non-empty string | — | Pi provider ID. |
| `model.id` | non-empty string | — | Pi model ID. |
| `model.thinking` | enum | unset | Optional Observer thinking level. |
| `showWorkerNotifications` | boolean | `true` | Routine Observer notices. |
| `passive` | boolean | `false` | Background Observer and proactive compaction. |
| `debugLog` | boolean | `false` | Local diagnostic NDJSON. |

Invalid values are ignored. Valid thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. When `model.thinking` is unset, the extension does not inject a default effort.

## Observation cadence

### `observeAfterTokens`

The trigger compares pending source growth against this threshold. It prefers provider context deltas when a reliable anchor exists and falls back to local source-entry estimates.

Lower values reduce each batch size but make more model calls. Higher values reduce call frequency but leave more source pending.

A successful ordinary run with no new Observation writes no empty event and does not advance coverage. It retries only after another `observeAfterTokens` of source growth; forced compaction bypasses this in-memory backoff. Model/API failures do not activate the backoff and leave coverage unchanged.

### `observerChunkMaxTokens`

This applies only to background runs. If unset:

```text
max(256, floor(resolvedModel.contextWindow * 0.2))
```

When context metadata is unavailable, fallback is `60000`.

Entries are serialized oldest-first. If the first entry alone exceeds the cap, it is sent as a marked head/tail excerpt and keeps the original source ID.

Compact-forced Observer runs deliberately ignore this cap and flush all pending source once. If the selected model cannot accept that input, compaction is cancelled safely.

## Segment cadence

### `segmentEveryObserverRuns`

Default `2` means:

1. first successful non-empty Observation batch: no ordinary Segment check;
2. second: Segment check required;
3. `complete`: counter resets;
4. `partial`: grouping remains due.

The counter counts batches, not Observations, turns, or tokens. Root lifecycle transitions still happen when structurally required. Every compaction forces a Segment check regardless of the counter.

## Rendering

### `memoryDepth`

- `0`: Root only;
- `1`: Root and direct children;
- `2`: also expand child Segments one more level;
- larger values continue the same recursion.

Visited Segment headings/summaries are retained. V4 does not lower depth dynamically or apply a memory token budget.

## Proactive compaction

### `compactAfterTokens`

`agent_settled` counts estimated source-entry tokens after the latest compaction boundary. Memory events and compaction metadata count as zero. If Pi remains idle and the threshold still holds after a deferred recheck, the extension calls `ctx.compact()`.

Pi manual/window-pressure compaction remains independent.

### `compactAfterTokensMode`

`calibrated` uses the fixed threshold.

`ratio` computes:

```text
max(1, floor(activeModel.contextWindow * compactAfterTokensRatio))
```

If context-window metadata is missing or invalid, it falls back to `compactAfterTokens`.

A ratio is useful for large-context models, but context size does not guarantee long-range attention. Tune from real sessions.

## Model selection

When `model` is absent, Observer uses the active Session model. When configured, both provider and ID are required. If the configured model is unavailable, Runtime warns and uses the Session model.

Authentication accepts:

- non-empty API key;
- non-empty auth headers, including OAuth bearer headers;
- provider-managed request-time signing when Pi reports configured ambient credentials.

Do not set `model.thinking` unless a specific effort is desired. V4 has no hidden Observer effort default.

## Notifications

`showWorkerNotifications: false` hides routine start/completion notices. Model resolution failures, proposal warnings, tree errors, and compaction cancellation remain visible.

## Passive mode

`passive: true` disables:

- background Observer runs;
- proactive auto-compaction.

It does not disable:

- manual/Pi compaction hook and its forced Observer;
- `/om:status` and `/om:view`;
- `om_sessions` and `om_read`.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy: `1`, `true`, `yes`, `on`. Falsy: `0`, `false`, `no`, `off`.

## Debug logs

`debugLog: true` writes best-effort NDJSON under Pi's agent directory:

```text
observational-memory/debug/<session-id>.ndjson
```

Events contain counts, IDs, token estimates, depth, warnings, and errors—not full prompts or memory text by default. Treat logs as sensitive local artifacts.

## V3 migration

V4 is intentionally incompatible with V3 memory and settings. Start a new clean Session.

Remove these V3 keys; they have no V4 replacement:

- `reflectAfterTokens`
- `observationsPoolMaxTokens`
- `observationsPoolTargetTokens`
- `agentMaxTurns`

Replace the old compression controls with:

- `segmentEveryObserverRuns` for grouping cadence;
- `memoryDepth` for compaction visibility.

V3 Reflection, Drop, pool, and `recall` records/tools are not imported.
