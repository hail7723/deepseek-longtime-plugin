# Project memory reliability P0 (2026-10-25)

Scope: Agent output JSON safety, acceptance preservation, and bounded
`memory_commit` output. No schema migration, search implementation, participant
state, UI, Desktop profile, release, or package version changes.

## Acceptance update semantics

- Omitted `acceptance_updates`: do not write acceptance to task data or the new
  checkpoint. Existing observations remain effective.
- Explicit `acceptance_updates: []`: an empty set of updates, **not a clear**.
  The checkpoint/queued draft records the explicit empty array, while task
  observations remain unchanged. This is safe to defer as an append-only no-op.
- Non-empty updates: merge by exact `criterion` string, replacing that
  criterion's observation and preserving the others. Repeated criteria within
  one submission use the last observation. This does not edit the contract.
- Each observation requires a non-blank string `criterion` and one of
  `pending`, `passed`, `failed`, `blocked`, `observed` as `status`.
  `evidence_refs` is an optional string array; `note` is an optional string.
  Non-JSON values and malformed entries are rejected before opening/writing a
  store. Remote requests support the existing snake_case/camelCase aliases;
  an explicit null is invalid, rather than an omitted list.
- Deferred observations update task data and the checkpoint in the existing
  `commitCheckpoint` transaction. A changed contract revision still requires
  review. Malformed legacy queued observations also require review.
- Recovery combines task observations with the newest non-empty acceptance
  checkpoint in the selected task/branch/workspace. Historical automatic empty
  arrays cannot mask an earlier observation; a legacy deferred checkpoint can
  supersede an older task observation. This is a read fallback, not a rewrite
  of old databases. Existing evidence freshness limitations still apply.

## Agent output boundary

All registered Agent tools pass through a shared JSON boundary before Harness
validates or renders their return value. It recursively omits undefined object
properties and array entries, and rejects non-finite numbers, negative zero,
functions, bigint, symbols, exotic objects, accessors, and cycles with a small
`INVALID_TOOL_OUTPUT` response. It does not use stringify/parse to hide lossy
values. Lease errors omit raw owner/fence details and use a generic readable
message. Commit conflicts carry only submitted fields in `requested` (public
snake_case names), together with readable retry information.

`memory_commit` projects successful Agent responses to IDs, revisions,
checkpoint ID/event sequence/time, sync status and flush/review counts.
Deferred responses retain `synced: false`, `deferredItemId`, `deferredCount`.
The internal operations result and Remote panel API retain full objects for
existing callers; the Agent binding retains its lease for normal dispose.
Compatibility tools keep their success shapes, including explicit legacy
lease claims, but errors no longer expose raw lease owner/fence fields.

## Regression evidence

`test/p0-reliability.test.js` covers the real pinned Harness `ToolRuntime`
execution/snapshot/render pipeline, including an unsanitized undefined
negative control that reproduces `invalid output: value is not lossless JSON`.
It tests A/B conflicts, three ordinary commits after passed acceptance,
evidence-only commits, explicit empty updates, validation before writes,
deferred flush, old checkpoint fallback, partial criterion updates, Remote
aliases, every registered tool's JSON boundary, and a public response below
2 KB even with large stored task/evidence/checkpoint payloads.

Tests use only fresh `os.tmpdir()` databases. The Harness tools package is a
pinned development dependency; it does not change production dependencies.

Validation on 2026-10-25: `npm run check` exited 0; `npm test` exited 0
(59 passed, 0 failed, 0 skipped); `npm run pack:check` exited 0
(26 packaged files, including both new source modules; no memory databases).
No package was published and no Git commit, tag, release, or push was made.

## Compatibility and next batch

No additional schema version is introduced. External consumers of the Agent
`memory_commit` tool must use IDs/revisions rather than its old full objects;
internal/Remote callers retain their shapes. Explicit empty acceptance updates
are deliberately a no-op; clearing acceptance is not introduced in this batch.
Legacy malformed observation bodies are not repaired automatically. These
offline tests do not establish real Desktop profile behavior.

P1: first reproduce history retrieval misses and scope leakage with failing
tests, then design indexed retrieval (including FTS), ranking, deterministic
limits, and freshness-aware results. Keep task/branch/workspace isolation and
bounded context as acceptance gates. Do not treat historical `passed` as a
fresh verification result.
