# Model evaluations

Use the harness relevant to the changed behavior:

- `run-observer-eval.mjs`: extraction and proposal contracts.
- `run-memory-tools-eval.mjs`: tool selection and arguments.
- `run-hierarchy-eval.mjs`: grouping, metadata, and hierarchy stability.
- `run-real-session-v4-eval.mts`: progressive Session/cadence behavior.

These make live model requests through Responses API. The tested Luna model did
not support reasoning effort plus function tools on Chat Completions.
The first two require `EVAL_ENDPOINT`, `EVAL_MODEL`, `EVAL_REASONING`, and
`API_KEY` in the environment. The hierarchy and real-session harnesses have
defaults and load project `.env` if `API_KEY` is absent; inspect their controls
before running them.

`EVAL_VALIDATE_ONLY=1` runs the Observer, memory-tools and hierarchy fixture/schema checks
without model requests or credentials; it does not measure model behavior.
Synthetic V4 seeds use `sN/oN` IDs. `node-id-fixtures.mjs` adapts frozen hierarchy
inputs for evaluation only, not runtime migration.

`hierarchy-results.tsv` records accepted rules and failed alternatives;
`real-session-hierarchy-targets.md` defines semantic targets, not exact wording.
V3-named fixtures are frozen evaluation inputs, not runtime compatibility support.
