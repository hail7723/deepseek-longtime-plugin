# P2.1 compaction recovery reinjection

2026-10-26. Local version `0.3.0-dev.9`; schema remains **v5**. This batch preserves the existing P0/P1/P2 work and makes **no plugin runtime-code changes**.

## Product contract

**压缩完成后的首个模型请求，必须能看到当前最新 recovery package。**

The contract is about what the model sees at its Provider boundary:

- If a partial compaction leaves the existing runtime-context snapshot on the surface, that snapshot remains sufficient; an unchanged provider read must not append another message.
- If the compaction replacement covers the old runtime-context event, the next request must append and see a new snapshot, even when its recovery text is unchanged.
- If SQLite changes after compaction and before request admission, the next request must contain the latest recovery text. When an older snapshot was retained, the newer snapshot supersedes it in model-visible order; older historical snapshots are not a second current state.
- Repeated compaction followed by unchanged requests must not cause duplicate appends per request or unbounded retained-surface growth. The append-only audit log still grows intentionally for real compactions and actual snapshot changes.
- Reinjection alone must not create participant progress, refresh last-seen, complete tasks, change leases/fences or CAS revisions, migrate schema, or rewrite project events.

## Existing mechanism confirmed

`registerAgent()` already contributes `project-memory:recovery` as a required, agent-scoped `systemPrompt.context()`. Its synchronous provider calls `recoveryText()`, which reads the latest SQLite snapshot on each call. Each Agent request attempt refreshes accepted runtime contexts before projection.

The Harness owns retained-snapshot tracking and surface replacement. A replacement covering runtime context invalidates its retained reference, allowing the next projection to append unchanged text again. A replacement outside it keeps the reference, so unchanged text is reused. A changed provider value produces a newer snapshot. No plugin compression epoch, nonce, database marker, manual `inject()` call, or PreCompact/PostCompact hook is needed.

This conclusion comes from real behavior observed at an offline Provider boundary, rather than copied projection logic or source-text assertions. The production plugin, operations, store, public JSON and schema implementations remain exactly as they were at the start of P2.1.

## Black-box harness

`test/p2-compaction-reinjection.test.js` uses public package exports to mount the real services:

- AgentRegistry and AgentLoop create, drive, quiesce, resume and dispose actual agents.
- SystemPrompt and ToolRuntime register the unchanged memory plugin's real context and tools.
- SessionStore, SessionProjectionRegistry and JSONL persistence own actual event/surface/replay state.
- TokenMeter and BasicCompactionEngine select, summarize and durably replace real surface regions.
- An offline `LlmAdapter` is the only registered Provider. Its `stream()` captures actual `GenerateOptions.messages`, returns deterministic chat/summary streams, and can throw the canonical context-overflow failure or block a summary until explicit cancellation.

The fixture uses `compactNow()` for normal full compaction. For partial coverage it calls the public `compactRegion()` inside a real open-turn `agent/pre-step`, as that API requires. Overflow is triggered by a fake Provider error and handled by the real automatically registered compaction listener; the test does not call a handcrafted retry or manually re-inject memory.

Startup/resume/fork tests use actual Agent handles and temporary JSONL files. Fork history is constructed with exported `buildForkSeed()`, and verified parent metadata is supplied through the normal Agent creation API. No test imports an external Harness checkout or relies on a machine-specific installation path. No test copies RuntimeContextProjection or searches installed sources to assert success.

## Eleven new tests

| Test | Evidence checked |
| --- | --- |
| Full replacement, unchanged text | Actual backend `shadowedSeqs` covers the old context; derived surface loses it; first next request sees equal text under a new message ID |
| Partial replacement, unchanged text | Actual assistant-only replacement preserves the recovery ID and adds no second snapshot |
| SQLite change after full compaction | Next request exactly matches the current recovery renderer and includes the new summary/next action |
| SQLite change after partial compaction | A fresh snapshot supersedes the retained historical one; the next unchanged follow-up appends nothing further |
| Three consecutive compactions | Every next request has current recovery; intervening ordinary follow-ups reuse the ID; four runtime-context log events total and at most eight retained messages in the fixture |
| Runtime-context suppression | Optional context is absent, while required recovery survives and reappears after replacement |
| Automatic overflow/retry | Two actual conversation attempts share one accepted user-message identity; one turn/step/input event, one real summary; SQLite updated during summarization is visible in the retry |
| Summary failure | No replacement or summary record lands; valid recovery remains and is reused on the next request |
| In-flight abort | Cancellation is synchronized with a Promise gate, without sleeps; no replacement lands and recovery remains valid |
| Large multi-participant recovery | The actual re-injected section stays within 6000 UTF-8 bytes and all memory state is preserved |
| Startup, resume and fork | Real requests show the correct current participant; resume reuses its row, fork records its verified parent and does not adopt the parent's current progress |

The fixture compares full SQLite task/participant fields and project event rows before/after relevant scenarios. This checks identity, task lifecycle, lease owner/fence/expiry, task/contract/participant revisions, last-seen/checkpoint state and schema. Only deliberate test progress writes are permitted to change those values. All fixture projects, SQLite databases, WAL files and persisted sessions are created beneath `os.tmpdir()` and cleaned after disposal.

The renamed P2 test `P2 repeated recovery reads and source labels preserve identity (not compaction evidence)` remains a separate identity regression. Its supplied `compact`/`clear` labels do not perform actual compression or establish what Desktop `/clear` does. The full suite preserves that conditional identity coverage; actual clear handling remains a Desktop gate.

## Dependencies and compatibility

Nine explicit development dependencies are pinned to **exactly `0.2.1-rc.3`**, matching the audited Harness environment:

| Packages | Reason |
| --- | --- |
| `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-loop` | Public Agent registry/factory and actual request/retry loop |
| `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-token-meter` | Real summary replacement and pressure/overflow behavior |
| `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-system-prompt` | Fake adapter boundary and real required-context refresh/suppression |
| `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-projection`, `@deepseek-ai/dsh-session-persistence-jsonl` | Actual surface/event projection, persisted resume and fork seed |

Several services were already transitive peers; declaring them directly makes test imports reproducible. There is no dependency on a private testkit, no added production dependency and no newer Harness version. Node remains `>=24.0.0`. A different Harness version must rerun this suite; these tests do not promise all future or older runtime implementations behave identically.

On the current Windows sandbox, JSONL native atomic publication failed with `MoveFileExW EACCES` beneath the sandbox Temp directory. The same tests pass outside the sandbox while still using `os.tmpdir()`. No fixture assertion, native persistence behavior or compaction check was skipped to work around that restriction. CI/other operating systems need their own run.

Independent review confirmed that `npm audit` reports 27 high-severity affected nodes from one memory-exhaustion advisory for `zod <4.6.6`, propagated through the Harness development dependency graph. `npm audit --omit=dev` reports **0 vulnerabilities**: this added dependency risk is confined to development/testing and is not added to the plugin's production dependency graph. A Desktop Host may separately contain the affected upstream Harness dependencies. Do not use `npm audit fix --force`: its required major upgrade would break the exact `0.2.1-rc.3` compatibility lock. Track Zod/DSH upgrade compatibility as a separate batch, independently of P3 evidence/schema work.

## Desktop validation gate

All of the following are **尚未验证** for this build:

1. Normal Desktop `/compact` in a real conversation.
2. Real Provider overflow triggering automatic compaction/retry.
3. Capturing the final first post-compaction model request, or equivalent actual session surface, to demonstrate current recovery is present.

These require separate authorization and an isolated Desktop run. Offline Agent/Provider evidence does not substitute for this gate. No Desktop profile, paid Provider, installation, real project memory, package release, Git commit, tag or push is part of P2.1. Schema v5 and existing project events are unchanged.

## Verification commands

```text
npm run check
npm test
npm run pack:check
```

`npm test` includes the new black-box suite without test skips. `pack:check` remains `npm pack --dry-run`; it checks dev.9 package contents and does not install or publish a package.
