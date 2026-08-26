# Real-session Segment hierarchy targets

These are human-authored optimization targets for the frozen V3 leaves in
`real-session-v3-selection.json`. They define desirable organization, not an exact
required wording. Observation order and IDs remain immutable.

## Shared target shape

- Root title names the actual session, never a bootstrap label such as `Session memory`.
- Root summary preserves the session purpose, major completed outcomes, decisive choices,
  and current blocker/state in one information-dense paragraph.
- Once a session has substantial closed history, Root should normally have 3–8 direct
  children. A small number of newest open Observations may remain direct children.
- Closed history should deepen with age: oldest stable work is normally chapter → phase
  group → phase → Observation (leaf depth 4), middle history is chapter → phase →
  Observation (leaf depth 3), recent completed work may stop at leaf depth 2–3, and the
  newest unresolved state may remain a direct Root Observation at depth 1. This is a
  recency trend, not an artificial requirement that every adjacent leaf be deeper.
- A phase Segment captures one coherent action thread. A chapter Segment may compress
  several consecutive closed phases even when their immediate tasks differ, provided the
  summary truthfully names the covered phases instead of inventing a shared goal.
- Segment summaries preserve action, result/current state, key decision/reason, and live
  blocker where present. High-level summaries should usually carry more information than
  one leaf while remaining shorter than their direct children.
- Do not manufacture depth with one-child wrappers or vague labels. Depth follows real
  chapter/phase structure; the newest unfinished work stays shallow.

## SwarmForge

### Root

**Title:** `SwarmForge architecture, Pi integration, and dashboard launch`

**Summary:** `Mapped SwarmForge's tmux/worktree orchestration, durable handoff and dashboard contracts; identified the human-input and terminal-injection gaps for Pi; chose a native in-repository Pi extension with filesystem delivery receipts; then worked through missing local dependencies to launch and verify a four-role Codex dashboard, leaving a full TypeScript rewrite as a substantial future option.`

### Target tree

```text
Root: SwarmForge architecture, Pi integration, and dashboard launch
├─ Architecture survey and operating model [ca3ad133f8d9 … 697913ef7525]
│  ├─ Core orchestration model [ca3ad133f8d9 … 2abc3bd0b641]
│  │  ├─ Project purpose, startup, and role topology [ca3ad133f8d9 … 8c9901ea412b]
│  │  └─ Durable handoff protocol and queue lifecycle [f228a8fbbf34 … 2abc3bd0b641]
│  └─ Dashboard, runtime safety, and quality controls [da8bb1a435ba … 697913ef7525]
├─ Roles and human interaction contract [93c06420f2b4 … 07de952f4d5a]
│  ├─ Role prompts and four-pack configuration [93c06420f2b4 … 0f44025a7aa0]
│  └─ Persisted task/handoff contract and intake gap [8c368421b6cb … 07de952f4d5a]
├─ Pi integration decision [0c8790c74dcb … dd9c556e2fc1]
│  ├─ CLI and tmux message-semantics investigation [0c8790c74dcb … 4bf31d16cc45]
│  └─ Native extension capability and chosen bridge [89138eda0cf0 … dd9c556e2fc1]
├─ Dashboard launch and verification [389ba70b2b53 … f63b4614cc13]
│  ├─ Environment and runnable-branch blockers [389ba70b2b53 … b9573445758b]
│  └─ Successful four-role launch and browser verification [1e1a42046dfb … f63b4614cc13]
├─ [604b3df34926] User suggested a future Pi adaptation would be better rewritten in TypeScript.
└─ [e5ac8ed56b58] A full rewrite would cover roughly 5,200 script lines plus 2,841 test lines.
```

Suggested chapter summaries:

- **Architecture survey and operating model:** `Documented how SwarmForge turns role configuration into isolated worktrees and tmux sessions, moves validated handoffs through daemon-owned filesystem queues, and exposes board, approval, chat, watchdog, cleanup, and quality-control behavior; delivered the requested project explanation.`
- **Pi integration decision:** `Found that adding Pi requires message-semantics support, not just a launch command: terminal injection cannot reliably express steer versus follow-up or prove delivery. Chose an in-repository Pi extension that watches durable request files, calls pi.sendUserMessage with explicit delivery mode, records receipts, and leaves tmux display-only.`
- **Dashboard launch and verification:** `The requested Codex dashboard was initially blocked by missing bb/tmux and branch-specific configuration. After obtaining Babashka, restoring a temporary four-pack setup, and gaining tmux, launched four role sessions and verified the SwarmForge Pack page at 127.0.0.1:38319.`

## Orchestra frontend/backend release work

### Root

**Title:** `Release workflow hardening and Segment Memory interface design`

**Summary:** `Diagnosed incorrect manual and RC publishing in orchestra-frontend, implemented ref-based dev/test/rc/formal routing, promoted the fix through dev, test, and release/v0.3.3, and verified a real RC deployment; ported the contract to orchestra-backend through PR #498 while resolving duplicate create/push edge cases and stopping at dev as requested; then simplified the Segment Memory public tools and finalized its ATX Markdown rendering contract.`

### Target tree

```text
Root: Release workflow hardening and Segment Memory interface design
├─ Frontend release hardening [737a2b11bf4a … 3ae6d0793b53]
│  ├─ Publish diagnosis and implementation [737a2b11bf4a … 1054c9e81cc3]
│  │  ├─ Trigger, ref, and metadata root-cause analysis [737a2b11bf4a … 6d38436a2d51]
│  │  ├─ Initial RC-specific implementation and checks [722b3da55001 … df1db1e8d2a6]
│  │  └─ Corrected all-ref manual routing and workflow audit [fd1bb2c9426b … 1054c9e81cc3]
│  └─ Promotion and RC verification [5d3ca7c4ee0f … 3ae6d0793b53]
│     ├─ PR #216 into dev [c6ea8f0d81c9 … 2e48fbac4c1a]
│     ├─ Create-event correction and PR #217 into test [7e05f9b648bd … ccbf55b791e1]
│     └─ PR #219 into release and successful manual RC run [abbbb1667eb8 … 3ae6d0793b53]
├─ Backend publish parity [aded3786476c … 22e989bcaa6a]
│  ├─ Backend contract and implementation [aded3786476c … 533f4d5cf03d]
│  ├─ Duplicate create/push review corrections [b30ddb3f212a … 8d8b06b90964]
│  └─ PR-only merge into dev and post-merge CI [ea0c28bc248c, 22e989bcaa6a]
├─ Segment Memory public interface design [9fcbb734e668 … 7e76c0e4f0fd]
│  ├─ Tool surface simplification [9fcbb734e668 … 45d064badc79]
│  └─ ATX Markdown memory format [5251d445da02 … 7e76c0e4f0fd]
└─ [2523570c0952] The om_sessions tool input contract is still missing from the architecture document.
```

Suggested chapter summaries:

- **Frontend publish diagnosis and implementation:** `Confirmed that branch creation may emit no useful push, workflow_dispatch behavior depended on the workflow file at the selected ref, and manual metadata incorrectly defaulted to dev. Reworked publishing so manual dev/test/release/tag refs map to dev/test/rc/formal channels, illegal refs fail, and automatic create remains restricted to the active RC branch; focused YAML/Bash/ref tests passed.`
- **Frontend promotion and RC verification:** `Committed the frontend fix in PR #216, merged it into dev, corrected an over-broad create trigger through PR #218, resumed PR #217 into test, promoted PR #219 into release/v0.3.3, and confirmed workflow run 32960231353 pushed the RC image, synchronized ACR, and updated the rc Nomad Pack.`
- **Backend publish parity:** `Ported the frontend routing contract to orchestra-backend while honoring the instruction to merge only into dev via PR. Two reviews exposed duplicate RC create/push and dev/test recreation gaps; both were corrected before PR #498 merged, and post-merge build/test/lint passed without promoting or publishing.`

## Pi Observational Memory V4

### Root

**Title:** `Segment Memory V4 implementation, validation, and hardening`

**Summary:** `Replaced the V3 Reflection/Dropper ledger with a strict append-only Segment Memory Tree, depth rendering, cross-session inspection, and om_sessions/om_read; evolved Luna prompts and tool schemas through production-normalized functional tests; published the V4 documentation contract; fixed root-only persistence and empty-Observer retry defects; expanded test-contract coverage; and froze three real V3 sessions for hierarchy evaluation under the API-key and concurrency constraints.`

### Target tree

```text
Root: Segment Memory V4 implementation, validation, and hardening
├─ V4 implementation and publication [7ad91814b6ce … f81fa47394ca]
│  ├─ Initial constraints and integration [7ad91814b6ce … bbcf00ffc1dc]
│  └─ Prompt, tools, and publication [07be3abbab3b … f81fa47394ca]
│     ├─ Initial Luna prompt and memory-tool validation [07be3abbab3b … ea80dcfcc7a7]
│     ├─ Documentation and package migration [178569fd1290 … 3a5a2f519b4e]
│     └─ Production-normalized validation and strict record contract [fa0b0b62a357 … f81fa47394ca]
├─ Architecture review and runtime hardening [b1cc995a3990 … 4024899854df]
│  ├─ Architecture assessment and root-only event remediation [b1cc995a3990 … 0ad1792858dd]
│  └─ Observer retry, cache, model, and token-watermark backoff [cfd410736232 … 4024899854df]
├─ Test-contract review and coverage closure [4d0513770fa8 … 6b6afc287767]
│  ├─ Static contract review and six T1 witness fixes [4d0513770fa8 … f979ba95d722]
│  └─ Expanded tree/runtime/tool gap audit and test completion [f038e67584b9 … 6b6afc287767]
└─ Frozen real-session hierarchy evaluation [3bb140be475a … 37db760aaac8]
```

Suggested chapter summaries:

- **Initial Luna prompt and tool validation:** `Built production-shared Observer and memory-tool eval harnesses on the Responses API. Luna medium improved from 5/9 to stable 9/9 for Observation/segmentation behavior and from 2/4 to 4/4 for tool selection after nullable optional schemas and argument normalization.`
- **V4 publication and production-normalized validation:** `Published the V4 documentation and package contract, then routed Observer proposals through production normalization. That exposed non-compressing Root summaries, drove stricter concise-summary guidance, restored 9/9 Luna medium behavior, and ended with full verification, strict record validation, and local credential exclusion.`
- **Observer runtime behavior and retry hardening:** `Traced Observer input, chunk sizing, model selection, and provider cache affinity, then fixed successful tree=null runs repeatedly reprocessing the same uncovered range. Ordinary retries now wait for another observeAfterTokens of growth, forced compaction bypasses the watermark, valid Observations clear it, status exposes it, and 101 tests plus typecheck passed.`
- **Test-contract review and coverage closure:** `Applied the latest agentic-review contract methodology, strengthened six false-confidence witnesses, then audited and filled concrete tree, runtime, Observer, tool, command, and eval-oracle gaps. The final suite reached 133 tests across 17 files with typecheck and diff checks clean.`
