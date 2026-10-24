# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-10-24

### Fixed

- Renamed the package to `@hail7723/dsh-project-memory` to avoid collision with an unrelated npm package named `dsh-project-memory@0.1.0` that targets DSH `0.1.0-rc.6`.
- Declared and reverified compatibility with DSH `0.2.1-rc.3` under the unique package identity.

## [0.1.0] - 2026-10-24

### Added

- Explicit project markers and stable local project identity.
- SQLite WAL storage for tasks, contracts, events, evidence, and checkpoints.
- Task and contract compare-and-swap revision checks.
- Idempotent writes, leases, and fencing tokens.
- Agent-scoped bootstrap, read, claim, checkpoint, search, and contract-proposal tools.
- Durable recovery context for new sessions, resumes, compaction, and overflow retries.
- Branch/workspace evidence isolation and pending tool-operation recovery.
