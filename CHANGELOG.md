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
