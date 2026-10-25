# P1 retrieval reliability — 0.3.0-dev.7

Implemented 2026-10-25 on top of the uncommitted P0 changes. This batch covers
retrieval, scope, ordering, response budgets and deferred visibility. It adds
no participant state, messaging, evidence revalidation, or new UI flows.

## Query contract

Agent `memory_search` accepts:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | required | Non-blank string, at most 512 UTF-8 bytes and 16 distinct terms; NUL is rejected. |
| `mode` | `any` | `any`: at least one term; `all`: every term in any order; `phrase`: literal normalized text in the supplied order, including punctuation. |
| `scope` | `current` | Selected task and current branch/workspace. `task` searches one task across branches/workspaces. `project` searches this project across tasks/branches/workspaces and must be explicit. |
| `task_id` | selected task | Optional explicit task for current/task; optional narrowing filter for project. Supplying it never removes current branch/workspace filters. |
| `include_deferred` | `true` | Include queued drafts, clearly marked unconfirmed. Conflict/discarded drafts are diagnostic counts only. |
| `limit` | `20` | Positive integer; maximum returned count is 100, also subject to the byte budget. The Agent schema accepts 1–100; the shared operation/store layer clamps larger legacy requests and reports `limitClamped`. |

Task selection uses the requesting session's binding, or an explicit task, or
the sole open task. An ambiguous/unavailable selection returns
`TASK_SELECTION_REQUIRED`; it never falls back to a project-wide search.
The Remote panel passes its session ID. Existing requests containing only
query/task_id/limit keep their current branch/workspace bounds.

The Remote uses the same operation and supports its existing camelCase aliases
(`taskId`, `sessionId`, and `includeDeferred`). `store.searchPage()` returns the
same envelope given resolved filters; current requires branch/workspace and
task requires taskId. `store.search()` retains the low-level array return API,
delegating to that implementation; it infers current from supplied
branch/workspace or task from taskId, and does not silently search the project
without a scope.

The response echoes `scope`, `filters` (`null` means unrestricted), `mode`,
`normalizedTerms`, `matchedTerms`, `searchedSources`, and
`queuedDeferredCount`. Results expose source/id, taskId, branch, workspace,
eventSeq (null for queued), createdAt, snippet, matchedTerms, relevance,
freshness, synced, confirmed, and visibility. Full payloads are not returned.
`groups` counts the confirmed and queued rows actually returned. For legacy
checkpoint consumers, bounded `kind`/`summary` remain available.

Normalization uses Unicode NFKC, lowercase, collapsed whitespace, and distinct
letter/number terms. Chinese sequences remain literal substrings, without a
dictionary segmenter. Snippets show normalized human-text values, never JSON
keys or known lease/session metadata.

## SQLite schema and atomicity

Schema v4 adds:

- Nullable branch/workspace provenance on `deferred_commits`. New operation
  writes capture the writer's actual workspace and branch. Legacy drafts keep
  unknown provenance, rather than borrowing a peer task's current scope.
- `memory_search_documents`: source identity, scope, event/time, visibility,
  deferred linkage, and normalized searchable text.
- `memory_search_fts`: FTS5 trigram external-content index with document
  insert/update/delete triggers.
- Source triggers for checkpoints, evidence, deferred drafts, and meaningful
  task history (`task.created`, `task.updated`, `contract.updated`, accepted
  contract-candidate diffs). Pending proposals are not confirmed history.

Every store connection probes a temporary FTS5/trigram table, inserting and
querying English and Chinese text. Missing support returns `SEARCH_UNAVAILABLE`.
Terms of three or more code points use bound, escaped literal FTS expressions;
shorter terms use parameterized `instr` over normalized text. SQL structure is
fixed, and user text is never interpolated into SQL. This follows the
[SQLite trigram tokenizer contract](https://www.sqlite.org/fts5.html#the_trigram_tokenizer).

Before upgrading an existing database, the constructor reads its actual schema
version and uses parameterized `VACUUM INTO` to create a consistent,
same-directory `memory.sqlite.v<V>-backup`, including committed WAL contents.
Existing backups are preserved; a retry gets a UUID suffix. The backup's own
schema remains the old version. Unlike copying live database/WAL files
separately, [VACUUM INTO produces a consistent snapshot](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause).
The source database is not vacuumed in place.

The v4 schema, index backfill and version advance run in one transaction.
Failures leave the marker and v3 schema intact, preserve the backup and close
the connection. v1/v2 still advance through their existing migration steps,
with a backup before any upgrade. Backfill does not rewrite original event
payloads. Legacy task history without recorded scope stays unscoped, available
through task/project search rather than being guessed into current scope.

New source writes and index changes share the existing source transaction;
index failures abort the source write. Search counts and results use a single
read snapshot. Direct maintenance writes to indexed source tables must use a
store connection, which registers the normalization functions needed by the
triggers; arbitrary external SQLite writers do not have these functions.

## Deferred visibility and freshness

Queued results always carry `synced:false`, `visibility:"queued"`,
`confirmed:false`. A confirmed checkpoint linked by `deferredItemId` shadows
its queued source even in the crash window before the queue status changes.
Flush preserves the recorded origin branch/workspace. Queued content is not
added to the recovery package's confirmed state.

Confirmed means persisted history, not a current verification. All result
freshness values are `unknown`, including historical `passed` observations.
No filesystem hashes are checked and no verification commands are rerun.

## Ranking, budget and zero-result diagnostics

Confirmed rows precede queued rows. Within each group, score is 100 per matched
distinct term plus 25 for an exact normalized phrase; then eventSeq descending,
createdAt descending, binary ID ascending and source ascending break ties.
This is deterministic lexical ranking, not semantic ranking.

The entire pretty-printed response (matching Agent rendering) is at most
16,384 bytes. Snippets are Unicode-safe and bounded; only complete rows are
removed to meet the budget. `budget` reports actual bytes and truncation.
Metadata that cannot fit produces `SEARCH_RESPONSE_TOO_LARGE`, rather than
invalid/truncated JSON. Public Agent results still pass through P0 publicJson.

`queuedDeferredCount` counts all visible queued drafts within the effective
scope, independent of text matching. Diagnostics report matchedCount,
scopeFilteredMatches (counts only, no out-of-scope text/IDs), queuedMatchCount,
conflictCount, discardedCount, unscopedDeferredCount, queryModeMismatch,
deferredExcluded, and limitClamped. Stricter mode failures can be distinguished
from any-term matches, and excluded queued matches remain visible as counts.
Zero results explicitly do not establish that nothing was saved. No zero-hit
fallback silently expands the requested scope or query mode. Existing panel
feedback and result rows surface this distinction and queued/freshness labels.

## Examples

```json
{"query":"Hello","scope":"current"}
```

Case-insensitive substring in the selected task's current branch/workspace.

```json
{"query":"handshake 打招呼","mode":"all","scope":"task","task_id":"task-a"}
```

Both terms, regardless of order, in task-a across branches/workspaces.

```json
{"query":"Hi lead","mode":"phrase","scope":"project","include_deferred":true,"limit":10}
```

Literal normalized phrase across this project, with confirmed and queued
groups distinguished; no access to another project in the same database.

## Regression coverage and limits

The tests use fresh os.tmpdir() projects only. `test/fixtures/schema-v3.sql`
is a schema-only snapshot of the pre-P1 database. Tests cover migration with a
live WAL writer, backup preservation/retry, failure rollback, FTS integrity
after update/delete/reopen, scopes and peers, literal query escaping,
multilingual modes, deferred before/after flush and crash shadowing,
deterministic ranking/ties, counts and size limits. Real Harness ToolRuntime
and Client/Host Gateway tests exercise the public boundaries, and the panel
smoke test checks zero-result and queued labels.

Remaining limits: short substring queries can scan many scoped rows; large
index backfills need additional disk/time; Chinese terms use literal substring
matching rather than semantic segmentation; old missing scope cannot be
reconstructed; evidence freshness remains unknown. No production database,
Desktop profile or installed package was changed during this work. The package
and lockfile versions are 0.3.0-dev.7; no tag, release or push is created.

P2 suggestion: design workspace/task-scoped per-session participant records
with explicit lifecycle and ownership, leases/CAS, terminal-state rules and
bounded recovery projections. Specify resume/fork/dispose/crash concurrency
tests before adding cross-agent messages or merging participant state.

Validation on 2026-10-25:

| Command | Actual result |
| --- | --- |
| `npm run check` | Exit 0; all listed JavaScript files pass syntax checks. |
| `npm test` | Exit 0; 81 passed, 0 failed, 0 skipped. Includes 21 P1 search tests, one added panel test, expanded real Gateway coverage, and all P0 tests. |
| `npm run pack:check` | Exit 0; 0.3.0-dev.7 dry-run, 29 files, both search modules included, no database files. |

The existing P0 worktree changes remain uncommitted. No package installation,
commit, tag, release, publish or push was performed in this batch.
