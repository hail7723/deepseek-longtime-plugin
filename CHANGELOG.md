# Changelog

All notable changes to this project will be documented in this file.

> The package was unified as `dsh-longtime-memory` in `0.1.2` and `0.2.2`. Entries before that use the historical package identity `@hail7723/dsh-project-memory`; they are kept for traceability.

## [0.3.0-dev.1] - 2026-10-24

### Added

- Schema v2 migration backups, session/task bindings, contract-candidate decisions, tool-operation records, and bounded recovery rendering.
- Offline migration, multi-session, canonical-workspace, recovery-budget, and candidate-decision tests.

### Changed

- Default model tools no longer expose revision, lease, or fencing fields. Legacy low-level tools are behind `compatibilityTools`.

### Not yet verified

- Real Desktop new-session, `/compact`, and provider-overflow behavior; no Desktop profile was modified and no paid model request was made.

## [0.3.0-dev.2] - 2026-10-25

### Fixed

- Do not read the non-injected Harness `ctx.config` property during `agent/created`; this previously prevented real session creation with `cannot get property "config" without inject`.

## [0.3.0-dev.6] - 2026-10-25

### Added

- "等待约 N 秒后自动重试" option in the save-state bar while another session holds the lease: a real timer retries the save once when the lease is due to expire, shows a countdown label, and can be cancelled ("取消等待"); an immediate manual retry cancels any scheduled wait first. Completes the R01 UI requirement (refresh / wait-then-retry / draft), with a timer-driven client test covering both the firing and the cancelled path.

## [0.3.0-dev.5] - 2026-10-25

### Changed

- When the Host cannot map exactly one workspace (welcome page with no live project conversation, or several live ones), the panel now shows an explicit "选择项目工作区" candidate picker instead of an error; picking one loads that project, and a "切换项目" button re-opens the picker. Auto-selection order is unchanged: slot-scoped session id first, sole live workspace second.
- Rewrote the workspace/session error copy: it now tells the user to open or select a project conversation and refresh — the panel itself always stays in the sidebar.
- New client render test drives the picker through the real slot wrapper (the Remote-namespace injection path), asserting both candidates render and a pick requests that exact cwd.

## [0.3.0-dev.4] - 2026-10-25

Remediation R00 + R01 + R02. Evidence: `docs/v0.3-lease-and-session-evidence.md`.

### Fixed

- `workspace` Remote registered a zero-argument wire signature because of a default parameter; every real gateway call failed with `gateway/signature-invalid`. Covered by the new `test/session-interface.test.js` real-gateway integration test.
- `memory_commit` no longer locks a task against every other session for five minutes: the commit lease is short (60 s) and renewable, a normal `agent/disposed` releases this session's own lease, and a foreign lease that is about to expire triggers one backed-off retry instead of an immediate failure.

### Added

- `memory_lease_status` tool and `leaseStatus`/`deferred`/`discardDeferred` Remotes return readable save state (`heldBy`, `remainingSeconds`, `canRetryAt`, `retryAfterSeconds`); owner, fence, and raw timestamps stay in a diagnostics object.
- Durable `deferred_commits` queue (schema v3, with `memory.sqlite.v2-backup` recovery copies before migration). Strict commit fields (state, next action, blockers) are rejected readably under a foreign lease; provably independent appends defer, and the next lease holder flushes the queue at most once, keeping conflicting items for review instead of dropping them.
- Panel save-state bar (`已保存于…` / `正在保存` / `等待另一会话（约 N 秒）` / `未保存—可重试`) with retry-save, discard-draft actions, a deferred-draft list (`排队中`/`需要复核`), Chinese error mapping, relative timestamps, and a diagnostics-only area for code/owner/ISO/fence.
- Session-bound task selection: completing or archiving a task invalidates only its own session binding, which must then re-select explicitly (`invalidated-binding`); it never silently adopts the remaining open task. Unbound sessions with multiple open tasks get `TASK_SELECTION_REQUIRED` everywhere, including commits.
- v0.3 panel flow through new `startTask`/`useTask`/`listTasks`/`setTaskState`/`commit` Remotes; the Client passes its slot-scoped `sessionId` (single-window `workspace` fallback), the panel offers an explicit task list with select/new/pause/complete/archive, and a selection banner replaces guessing.

### Not yet verified

- Real Desktop profile run of the new lease/deferred/task flow (A/B sessions, dispose release, queue flush, multi-window session ids) and R03–R06; no paid model request was made.

## [0.3.0-dev.3] - 2026-10-25

### Changed

- The panel derives its path from the active Harness conversation's committed workspace and shows it read-only. It no longer asks users to type a directory or reuses a process-wide directory from another window.

## [0.2.2] - 2026-10-24

### Added

- Native **Project Memory** panel registered in the global `sidebar.panellist` and `main` Slots: overview, tasks, contracts, and history views.
- Package-private `projectMemory` Remote service with six operations shared with the Agent tools.
- Visual initialization, task claim, checkpoint, contract candidate proposal, and scoped history search.

### Fixed

- Use strict JSON-object Remote codecs; the withdrawn `0.2.1` build passed `src-json` inputs that the real Client gateway rejects.
- Use identifier-only Host Remote parameters, as required by source reflection.
- Read the dynamically mounted `remote.projectMemory` service through the context lookup instead of an undeclared injection dependency.
- Contain Remote mount failures inside the memory panel so an optional plugin can never block Web boot.
- Include scoped checkpoint summaries in history search alongside evidence.

### Changed

- Renamed the package to `dsh-longtime-memory` across the manifest, bundle row, Client entry, descriptors, tests, and docs; repository moved to `hail7723/deepseek-longtime-plugin`.

### Verification

- 26 offline tests, including real Harness Client/Host Gateway mount, all six operations, CAS/fencing conflicts, disposal, and remount.
- Isolated browser profile: sidebar entry, panel rendering, initialization, claim, checkpoint, contract candidate, and history search.

## [0.1.2] - 2026-10-24

### Changed

- Host-only line renamed to `dsh-longtime-memory`, with the repository moved to `hail7723/deepseek-longtime-plugin`.
- Rebuilt the release artifact so its embedded `package.json` carries the new identity; the earlier renamed `v0.1.1` asset still contained the old package name.
- Ignored the whole `.deepseek-memory/` runtime directory instead of only the SQLite files.

## [0.2.1] - 2026-10-24

> Withdrawn development build: invalid `src-json` Client input codecs caused the entry to fail during Web boot. Do not install.

### Fixed

- Mount the `projectMemory` Remote contribution from the Client before registering UI slots.
- Remove the impossible startup dependency on `remote.projectMemory` that kept `0.2.0` pending.

## [0.2.0] - 2026-10-24

> Withdrawn before release: the Client declared `remote.projectMemory` as a hard dependency without mounting its Remote contribution, which blocked Web boot.

### Added

- Native Harness Project Memory panel in the global sidebar and central main view.
- Visual overview, task claim and checkpoint forms, contract candidate proposals, and history search.
- Package-private `projectMemory` Remote service for Client-to-Host operations.
- Shared Host operations used by both the visual panel and Agent tools with identical CAS and fencing semantics.

## [0.1.1] - 2026-10-24

### Fixed

- Renamed the package to `@hail7723/dsh-project-memory` to avoid collision with an unrelated npm package named `dsh-project-memory@0.1.0` that targets DSH `0.1.0-rc.6`.
- Declared and reverified compatibility with DSH `0.2.1-rc.3` under that unique package identity.

## [0.1.0] - 2026-10-24

### Added

- Explicit project markers and stable local project identity.
- SQLite WAL storage for tasks, contracts, events, evidence, and checkpoints.
- Task and contract compare-and-swap revision checks.
- Idempotent writes, leases, and fencing tokens.
- Agent-scoped bootstrap, read, claim, checkpoint, search, and contract-proposal tools.
- Durable recovery context for new sessions, resumes, compaction, and overflow retries.
- Branch/workspace evidence isolation and pending tool-operation recovery.
