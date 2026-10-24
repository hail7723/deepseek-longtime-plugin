# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-10-24

### Added

- Explicit project markers and stable local project identity.
- SQLite WAL storage for tasks, contracts, events, evidence, and checkpoints.
- Task and contract compare-and-swap revision checks.
- Idempotent writes, leases, and fencing tokens.
- Agent-scoped bootstrap, read, claim, checkpoint, search, and contract-proposal tools.
- Durable recovery context for new sessions, resumes, compaction, and overflow retries.
- Branch/workspace evidence isolation and pending tool-operation recovery.
