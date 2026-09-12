# Project agent memory

Segment Memory V4 entrypoint: `src/index.ts`. Configuration: `README.md`.
Lifecycle and ledger: `docs/how-it-works.md`. `CLAUDE.md` links to this file.
Observer prompts are product behavior for the configured memory model or session
model, not development Skills.

Checks: `npm test -- <test-file>` for affected behavior; `npm run typecheck` for
TypeScript changes. Full CI: `.github/workflows/ci.yml`. Model evaluations are
task-specific; see `eval/AGENTS.md` when changing prompts or evaluation harnesses.

## Model auth

`Runtime.resolveModel` (`src/runtime.ts`) requires successful auth and either a
non-empty API key/header value (including headers-only OAuth) or a Pi-confirmed
credential source for request-time signing (non-OAuth; no empty-string key).
Preserve the bounded, rate-limited re-check of stale credential availability and
`apiKey`/`headers`/`env` forwarding to Observer. Regressions:
`tests/runtime.test.ts`, `tests/ambient-credential-auth.test.ts`.

## Segment Memory V4

`src/memory-tree/store.ts` owns replay and tree invariants. Persisted V4 events
are strict; only model proposals get best-effort normalization. V4 intentionally
does not read V2/V3 memory. Code derives sibling order from Observation sources,
not proposal array order; segmentation preserves every leaf and its provenance.
Segment non-expansion is a prompt/eval quality criterion, not a runtime tree
invariant; replay and proposal normalization must not reject records using local
token estimates.

Node IDs are the persisted `sN/oN` identities (envelope version 2), with no
random-ID compatibility layer. Allocation must replay the whole Session ledger,
while trees replay only the selected branch. Fork inherits source watermarks
before exposing or allocating IDs. Pi mutates memory before disk append; an
uncertain write blocks that manager until the saved Session is reopened. See
`docs/node-reference-design.md` and `tests/session-node-ids.test.ts`.

Compaction queues a fresh forced Observer, then rebuilds and renders by
`memoryDepth` (Root depth 0). The forced run rereads the active branch and flushes
all pending source without the background chunk cap, even in passive mode.
Observer failure cancels compaction; never substitute stale memory. Preserve
Session/generation checks before append. See `src/hooks/compaction-hook.ts` and
`src/hooks/consolidation-trigger.ts`.

## Maintaining this file

Keep durable constraints learned from real work and useful across repository tasks.
Update existing entries and link authoritative sources; omit task logs, duplicated
code explanations, and generic workflow advice.

## Token accounting and compaction

<!-- opm:managed:start -->
- Proactive compaction counts estimated source entries after the compaction boundary, even in ratio mode. Observer scheduling can use provider deltas with a raw-estimate fallback; serialized-input and diagnostic sizes use local estimates. Pi's aggregate context usage is not exact per-entry/range attribution. Rendering is controlled by `memoryDepth`, not a memory token budget. Keep trigger, status, documentation, and affected tests aligned; see `src/progress.ts` and `tests/compaction-trigger.test.ts`.
- Context pressure does not imply removable history: extension-requested `ctx.compact()` can fail before `session_before_compact` when no range is removable. Pi-native compaction handles this separately.
- `firstKeptEntryId` controls Pi's raw tail, not tree membership or a progress reset. Retained source entries can exceed the effective threshold; cadence changes must test consecutive post-success turns and distinguish successful repetition from failed-attempt backoff.
<!-- opm:managed:end -->
