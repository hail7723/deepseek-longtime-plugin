# P2 participant state and task completion

2026-10-25; local development version `0.3.0-dev.8`, schema v5. This work extends P0/P1 without modifying their original records. No Desktop installation, publication, tag, or push is part of this batch.

## Identity and lifecycle evidence

The [R00 evidence](v0.3-lease-and-session-evidence.md) was rechecked against the installed `@deepseek-ai/dsh-* 0.2.1-rc.3` source under `D:\practice\Deepseekharness\memory\dev-runtime\node_modules`. Repository test dependencies use that same version family. These are source/interface findings, not new Desktop observations:

| Operation | Verified evidence | Plugin behavior |
| --- | --- | --- |
| Identity | `dsh-agent/lib/types/runtime-types.d.ts`: `Agent.id` is `SessionId`; Agent exposes its session | Participant ID is the exact current `agent.id` |
| Resume | `dsh-agent-loop/lib/index.js`, `resumeWith`, around lines 1970–1996: uses `options.resumeSessionId`, prepares the same ID with the stored header | Update the existing participant; increment its revision; keep summary/history |
| Fork | `dsh-api-session-controller/lib/types/commands.js`, lines 254–264: creates a fresh child ID and supplies `meta.parentSession = source.header.id` | Independent participant; copy no peer progress. Parent is recorded only from `agent.session.header.parentSession` when the header ID matches the actual agent ID |
| Compaction | `dsh-compaction-basic/lib/index.js`, around lines 469, 634–650: appends compaction markers, summary and replacement user message to the same `agent.session` | Repeated recovery reads create no participant. Receiving the same ID again reuses its row |
| Clear | `SessionStartSource` declares `clear`, but no concrete `/clear` handler establishing ID retention was found in the audited installed entry points | Do not claim retention. Trust the actual delivered ID, whether retained or new; never infer identity or fork ancestry from ID format |
| Dispose | `dsh-agent/lib/index.js`, around lines 550–561: emits `agent/disposed`, contains listener errors and does not await listener promises | Best-effort own lease release and inactive/disposed marking; never task completion |
| Crash | No guaranteed dispose callback or durable turn-stop hook | Persisted participant revision, last-seen timestamp, checkpoints/events, bindings, deferred records and lease expiry are the available recovery facts. Derive stale; never invent dispose |

`agent/created` supplies `source`, which is saved as descriptive evidence. New runtime attachments have an internal random `instance_id`; it prevents delayed disposal or progress writes from an old attachment from replacing a resumed attachment. It is not a participant identity or a lease token. Parent/source/instance metadata cannot be supplied through the Agent tool arguments.

The synthetic clear test verifies plugin behavior **if** the same actual ID is supplied; it does not verify Desktop `/clear`. Real Desktop resume/fork/clear/normal compaction/overflow retry and shutdown delivery remain a validation gate.

## Two independent state machines

| State | Meaning | Completion effect |
| --- | --- | --- |
| Task lifecycle: `active / paused / blocked / completed / archived` | Shared task state and existing task revision/lease rules | Only an explicit task transition ends the task |
| Participant status: `working / waiting / blocked / done` | One session's last reported progress for one task | `done` does not change task lifecycle |
| Participant presence: `active / inactive / stale / disposed` | Whether the saved report has recent activity or an explicit inactive/dispose record | None; `working` plus `stale` is historical progress, not proof of a live worker |

Participant writes do not change task/contract revisions or require the task lease. Successful normal `memory_commit` also records the caller's personal progress and checkpoint sequence atomically; next action/blockers no longer overwrite shared task data. Existing historical checkpoints and legacy task fields remain intact. Recovery uses legacy fields only when the selected scope has no participants at all.

Default stale TTL is **300 seconds**. Presence is derived at read time from an injectable millisecond clock; no sleeps or timer-based stale writes are needed. Creation/resume/explicit progress/successful confirmed commit refresh last-seen. Merely reading a participant or rebuilding a recovery package does not. A long model turn or external tool may therefore become stale without proving a crash. Dispose saves `active=false`, a reason and `disposed_at`; unload/detach saves inactive without pretending to be dispose. Normal disposal also releases a persisted own lease inherited on resume. A foreign lease is never released.

## Schema v5 and transaction boundaries

`participants` has primary key `(project_id, task_id, participant_id)` and a composite task foreign key. Fields include status, summary, next action, blockers JSON, branch/workspace, independent version, last-seen epoch milliseconds, last checkpoint sequence, last explicit progress sequence, active/disposed/reason metadata, verified parent/start source and attachment instance ID. No raw lease fence is stored in participants.

Writes execute in `BEGIN IMMEDIATE` transactions, compare the participant version and append a project-monotonic `participant.activated`, `participant.progress` or `participant.inactive` event. Task/contract/lease CAS remains independent. Nested completion/disposal calls use savepoints so errors roll back the enclosing operation. Same-ID scope changes reset the live progress view rather than exposing old workspace/branch summaries; original reports remain in events. A stale attachment or mismatched scope is rejected.

Before upgrading an actual v4 database, the constructor makes a consistent same-directory `VACUUM INTO` snapshot named `memory.sqlite.v4-backup` (fresh UUID suffix if already present). It includes committed WAL data. Creating the participant table/index and advancing `schema_meta` to 5 is one transaction. The project marker advances only on successful open. Failed v5 DDL leaves v4 metadata and source rows readable; retry creates another backup without overwriting the first. No existing event is modified and no participant identity is guessed from historical task data. Earlier schema upgrades retain their existing steps and backups based on the original schema version.

For downgrade, close all project users, preserve the v5 database/sidecars/marker, then restore the consistent v4 snapshot and its matching v4 marker. Older binaries reject v5; do not point dev.7 directly at the upgraded database. The migration tests build genuine schema-v4 fixtures under `os.tmpdir()` and test both WAL-backed success and failed DDL/reopen/retry.

## Minimal tool contracts

All three tools resolve the current session's selected task. They accept no participant/session ownership override, lease owner, fence, parent, or force parameter. The Agent receives session identity from the Host. Local Remote callers must supply `session_id`; that existing local API is not an authentication boundary.

### `memory_update_progress`

Optional inputs: `summary`, `status` (default `working`), `next_action`, `blockers`, `expected_version`, `idempotency_key`. Omitted content fields retain their previous values. `blockers: []` clears this participant's blockers. Summary is at most 8192 UTF-8 bytes, next action 2048, blockers at most 16 strings of at most 512 bytes. `expected_version` optionally pins the participant CAS; without it the Host rereads its own row and still performs CAS in the transaction. Stale revisions return `PARTICIPANT_REVISION_CONFLICT` with expected/actual versions. No peer revision is affected.

```json
{"summary":"Parser implemented; reviewing edge cases","status":"working","next_action":"Run parser tests","idempotency_key":"parser-review-1"}
```

Success contains only `ok`, `projectId`, `taskId`, `participantId`, `version`, `eventSeq`, `lastSeenAt`; maximum **2048 bytes**. Oversized identity metadata is rejected before mutation. Idempotency keys are namespaced by task/session/branch/workspace; replay returns the original receipt, while different content with the same key fails `IDEMPOTENCY_CONFLICT`.

### `memory_participants`

No Agent arguments. Read-only selected-task overview, filtered by current project, branch and canonical workspace. It can inspect the original terminal binding's history without reactivating it. Self comes first; peers sort by last-seen descending then participant ID using binary ordering. At most 50 rows are examined; a full **8192-byte** response cap further removes complete rows from the end. `total`, `truncated`, `filters`, `staleAfterSeconds` and `maxBytes` expose the actual scope/budget. Summary/next action/blockers are clipped Unicode-safely for display. No raw fence or runtime attachment ID is public.

### `memory_complete_task`

Required `summary` (non-empty, up to 8192 bytes); optional `evidence_refs` (at most 32 strings, 512 bytes each) and `idempotency_key`.

```json
{"summary":"Parser and regression suite complete","evidence_refs":["test:parser"],"idempotency_key":"parser-finish-1"}
```

Inside one transaction the Host:

1. Rereads task lifecycle/revisions, pending deferred counts and the live lease.
2. Rejects queued **or conflict** drafts anywhere in the task with `DEFERRED_COMPLETION_BLOCKED`, counts, and review/flush/discard guidance. A different session's live lease returns readable `LEASE_CONFLICT` with retry timing and no raw owner/fence. There is no implicit force path.
3. Acquires the caller's lease, writes a terminal checkpoint and evidence references, sets task lifecycle `completed`, and records the completing participant as `done`.
4. Retains participant history and marks active rows inactive with reason `task-completed`; this is not a dispose claim.
5. Appends `task.completed` and releases the caller's lease. All steps, including search indexing and idempotency receipt, roll back together on failure.

Existing bindings remain audit rows but become invalid for task resolution. A Remote caller that selects the sole open task without a prior binding persists that binding within the completion transaction, so an idempotent retry can still identify it. Recovery reports the previous terminal lifecycle and does not auto-adopt another task. New unbound sessions never auto-select completed/archived tasks. Explicit `task`/`project` search continues to find terminal checkpoints. Late participant-bearing checkpoints and deferred enqueues reject terminal tasks.

Success is capped at **2048 bytes**: `ok`, `synced`, project/task IDs, `state: "completed"`, task/contract versions, checkpoint ID/event sequence/time, `leaseReleased`. It contains no full task, evidence array, checkpoint payload or raw lease owner/fence. Exact idempotent replay works after binding invalidation; changed content fails. Historical task completion through the compatibility `memory_commit.state="completed"` uses the same atomic completion checks and keeps its P0 compact receipt. The panel's administrative completion path also uses the guarded store operation.

Agent, Remote (`updateProgress`, `participants`, `completeTask`) and store share the implementation. Agent outputs continue through `publicJson`; real ToolRuntime tests check successful and conflict results using lossless JSON, plus the inherited invalid-value sanitizer tests. A real Client/Host Gateway test exercises all new Remote descriptors.

## Recovery, deferred visibility and budgets

The recovery text stays within **6000 UTF-8 bytes**, preserves overall task lifecycle, prioritizes the current session's summary/next action and shows at most four peer summaries with presence labels. Whole peer rows are removed if needed; ordering is deterministic. It never falls back to a peer's progress as the current session's state. The latest confirmed checkpoint is separately labelled historical. A bounded `memory_participants` overview provides additional participant history.

Queued content is not participant-confirmed recovery state. P1 search still labels it `synced:false`, `visibility:"queued"`, `confirmed:false`. On successful flush a draft updates its **author's** checkpoint reference, preserving inactive/disposed/last-seen facts. A saved base progress sequence prevents the older draft from replacing a newer independent author report. A scope mismatch conflicts rather than leaking progress across workspaces. Historical acceptance/evidence still has freshness `unknown`; P2 makes no current-test validity claim.

## Product boundaries and remaining validation

Participants provide persistent progress, recovery and audit. They are a **state view, not a message queue**. The plugin cannot wake another session and cannot guarantee another Agent immediately reads an update. Real-time collaboration still needs Agent Teams, Harness scheduling, or file/message mechanisms. No message channel, cross-device synchronization, vector retrieval or UI redesign is included.

Offline tests cover ownership/CAS/interleavings, resume/fork/compaction identity, best-effort dispose versus crash-derived stale, scope isolation, monotonic events, queued/conflict/foreign-lease completion blockers, terminal atomicity/rollback/idempotency, search of completed tasks, migration backups/rollback, real ToolRuntime/Gateway JSON and response budgets. Desktop source contracts still need live validation; especially `/clear` identity behavior, overflow compaction, rapid replacement/disposal and shutdown persistence are not claimed verified. TTL describes last observed activity, not a heartbeat or liveness guarantee.

Evidence freshness P3 is the next useful batch: attach verification code/contract/environment revisions and time to evidence, derive stale/unknown explicitly, and keep historical `passed` distinct from current acceptance. Keep Desktop P2 validation as a separate gate before relying on these behaviors in a production profile.
