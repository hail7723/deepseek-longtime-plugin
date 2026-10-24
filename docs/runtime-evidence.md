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
