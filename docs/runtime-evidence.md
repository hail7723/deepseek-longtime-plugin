# Runtime Interface Evidence

Verified 2026-10-24 against the currently running Desktop Host.

| Surface | Observed version or contract |
|---|---|
| Desktop runtime | `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.3` |
| Host packages | `@deepseek-ai/dsh-* 0.2.1-rc.3` |
| Cordis | `4.0.5` |
| PATH CLI | `0.1.5-rc.1` (not used as the compatibility authority) |
| Node / SQLite | `v24.19.0` / `3.53.3` |
| Active profile during inspection | `desktop` |
| Agent start | `agent/created`, serial and awaited before queued input |
| Prompt refresh | `systemPrompt.refreshContext()` reruns accepted runtime-context providers on every request attempt |
| Overflow | `agent/request-error` retry re-runs request preparation and `refreshContext`; accepted step messages are not duplicated |
| Tool API | agent-scoped `tools.register(definition)` with JSON schema, output schema/render, execution callback, and concurrency classifier |
| Working directory | `workingDirectory.ensure(agent, signal)` returns the committed absolute directory |

Implementation consequence: recovery is a required, agent-scoped runtime context whose text synchronously reads the latest SQLite snapshot. The Agent loop durably commits changed runtime context as a session `user/message`, so replay, resume, and compaction recovery do not depend on unsupported PreCompact/PostCompact hooks.

## P2.1 offline black-box verification — 2026-10-26

The historical Desktop audit above is retained. The following evidence is **offline**, collected by `test/p2-compaction-reinjection.test.js` with repository-resolved, exact `0.2.1-rc.3` packages. No Desktop profile or real Provider was used.

The fixture mounts the real AgentRegistry/AgentLoop, LlmRuntime, SystemPrompt, ToolRuntime, SessionStore, SessionProjectionRegistry, TokenMeter, BasicCompactionEngine and JSONL persistence. It loads the unchanged memory plugin. A fake `LlmAdapter` captures actual conversation and auxiliary-summary requests at the Provider boundary, supplies deterministic text, and can issue canonical context-overflow errors or abort/fail a summary. All fixture projects, databases and persisted sessions are under `os.tmpdir()`.

| Scenario | Observed black-box assertion |
|---|---|
| Complete replacement | `compactNow()` returns real `shadowedSeqs` including the old runtime-context event; that snapshot disappears from derived surface; the first subsequent Provider request contains a new ID with the same recovery text |
| Partial replacement | Public `compactRegion()` runs in a real `agent/pre-step`; only the selected assistant event is replaced, and the retained recovery ID is reused without another append |
| Latest SQLite state | After full or partial compaction, explicit progress changes appear in the first next Provider request |
| Three compactions | Every post-compaction request has current recovery; unchanged ordinary follow-ups reuse its ID; exactly four snapshots are logged for startup plus three replacements, with a bounded current surface |
| Suppression | Scoped `suppressRuntimeContext()` removes an optional marker while required recovery survives and is re-injected after replacement |
| Automatic overflow | The fake adapter throws `CONTEXT_WINDOW_EXCEEDED`; the real backend compacts and AgentLoop retries in the same turn/step, reads SQLite changed during summarization, and retains one accepted user-message ID/event |
| Failed/aborted compaction | Summary failure and in-flight cancellation commit no replacement; the old valid recovery remains visible and no duplicate is appended |
| State isolation/budget | Before/after SQLite task, participant, lease/fence, revisions, events and schema snapshots remain identical unless the test explicitly updates progress; every checked recovery section stays within 6000 UTF-8 bytes |
| Session identities | Actual startup, JSONL-backed `agents.resume()` and an Agent fork built through `buildForkSeed()`/`agents.create()` retain correct participant identity and current model-visible recovery |

These eleven tests demonstrate the existing model-visible mechanism; they do not copy or stub RuntimeContextProjection and do not validate behavior by matching installed source text. Test imports use package exports, with no external checkout path. No plugin runtime change, schema migration or original-event rewrite was required. The older P2 repeated-provider-read test remains an identity/source-label test only; synthetic `source="clear"` does not prove the Desktop `/clear` implementation.

On this Windows environment, sandboxed execution denied the JSONL backend's native `MoveFileExW` publication under Temp (`EACCES`). Running the same offline tests outside that sandbox passed; the fixture and its persistence assertions were retained. This is a test-environment requirement, not a recovery implementation workaround.

**Desktop gate: 尚未验证.** Normal `/compact`, automatic overflow compaction and final post-compaction request/equivalent surface capture still require a separately authorized Desktop run. Clear ID behavior also remains a separate P2 Desktop question. See [P2.1 detailed contract](p2-compaction-reinjection.md).
