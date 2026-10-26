import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openProjectStore } from '../src/store.js';
import {
  commit, leaseStatus, listDeferredCommits, discardDeferredCommit, startTask,
} from '../src/operations.js';
import { findProjectRoot, registerAgent } from '../src/plugin.js';

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function harnessAgent(id) {
  const tools = new Map();
  const contexts = new Map();
  const ctx = {
    systemPrompt: { getContextOrder() { return 100; }, context(d) { contexts.set(d.name, d); return async () => contexts.delete(d.name); } },
    tools: { register(d) { tools.set(d.name, d); return async () => tools.delete(d.name); } },
    on() { return async () => {}; },
  };
  return { agent: { id, ctx }, tools, contexts };
}

const logger = { warn() {} };
async function callTool(h, name, args) { return h.tools.get(name).execute(args ?? {}, {}); }
function taskRow(root) {
  const db = new DatabaseSync(path.join(root, '.deepseek-memory', 'memory.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT lease_owner, lease_fence, lease_expires_at FROM tasks').get();
  db.close();
  return row;
}

test('strict-field commit against a live foreign lease fails readably', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-strict-');
  const started = startTask({ cwd: root, sessionId: 'session-a', objective: 'R01 strict', idempotencyKey: 'start' });
  const a = await commit({ cwd: root, sessionId: 'session-a', progress: 'from a', nextAction: 'hold', idempotencyKey: 'a1' });
  assert.equal(a.ok, true);
  const b = await commit({ cwd: root, sessionId: 'session-b', progress: 'from b', nextAction: 'take over', blockers: ['lease'], idempotencyKey: 'b1' });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'LEASE_CONFLICT');
  assert.ok(Number.isFinite(b.error.retryAfterSeconds) && b.error.retryAfterSeconds > 0, 'readable retry seconds must be present');
  assert.ok(typeof b.error.canRetryAt === 'string' && !Number.isNaN(Date.parse(b.error.canRetryAt)), 'canRetryAt must be an ISO timestamp');
  assert.equal(b.error.heldBy, 'other-session');
  assert.equal(b.error.owner, undefined, 'owner/fence stay diagnostic-only in the commit error');
  assert.deepEqual(b.error.requested, { progress: 'from b', next_action: 'take over', blockers: ['lease'] });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b, 'conflict must survive JSON without omission');
  const status = leaseStatus({ cwd: root, taskId: started.task.id, sessionId: 'session-b' });
  assert.equal(status.ok, true);
  assert.equal(status.heldBy, 'other-session');
  assert.ok(status.remainingSeconds > 0 && status.remainingSeconds <= 60);
  assert.equal(status.diagnostics.owner, 'project-memory:session-a');
});

test('append-only commit defers under a foreign lease and flushes after release', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-defer-');
  startTask({ cwd: root, sessionId: 'session-a', objective: 'R01 defer', idempotencyKey: 'start' });
  await commit({ cwd: root, sessionId: 'session-a', progress: 'from a', nextAction: 'hold', idempotencyKey: 'a1' });
  const deferred = await commit({ cwd: root, sessionId: 'session-b', progress: 'evidence only', evidenceRefs: ['test:unit'], idempotencyKey: 'b1' });
  assert.equal(deferred.ok, true, JSON.stringify(deferred));
  assert.equal(deferred.synced, false);
  assert.equal(deferred.deferredCount, 1);
  const queued = listDeferredCommits({ cwd: root, taskId: deferred.taskId }).items;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].sessionId, 'session-b');
  assert.equal(queued[0].kind, 'append');
  // The deferred write must not claim a synced checkpoint.
  const before = openRow(root, 'SELECT COUNT(*) n FROM checkpoints').n;
  assert.equal(before, 1);

  // Lease expires; the next commit with strict fields must succeed and flush once.
  const db = new DatabaseSync(path.join(root, '.deepseek-memory', 'memory.sqlite'));
  db.prepare('UPDATE tasks SET lease_expires_at = ?').run(Date.now() - 1);
  db.close();
  const flushed = await commit({ cwd: root, sessionId: 'session-b', progress: 'resume write', nextAction: 'done', idempotencyKey: 'b2' });
  assert.equal(flushed.ok, true, JSON.stringify(flushed));
  assert.equal(flushed.flushed, 1);
  const after = listDeferredCommits({ cwd: root, taskId: flushed.taskId }).items;
  assert.equal(after[0].status, 'flushed');
  assert.equal(after[0].flushedAt !== null, true);
  const checkpoints = openRow(root, 'SELECT COUNT(*) n FROM checkpoints').n;
  assert.equal(checkpoints, 3, 'flush replay adds its own checkpoint');
});

test('flush conflict keeps the queued item for review instead of dropping it', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-conflict-');
  startTask({ cwd: root, sessionId: 'session-a', objective: 'R01 conflict', idempotencyKey: 'start' });
  await commit({ cwd: root, sessionId: 'session-a', progress: 'from a', nextAction: 'hold', idempotencyKey: 'a1' });
  const deferred = await commit({ cwd: root, sessionId: 'session-b', progress: 'acceptance observation', acceptanceUpdates: [{ criterion: 'works', status: 'observed' }], idempotencyKey: 'b1' });
  assert.equal(deferred.synced, false);
  // The contract revision moves after the item was queued: flush must refuse to merge.
  const db = new DatabaseSync(path.join(root, '.deepseek-memory', 'memory.sqlite'));
  db.prepare("UPDATE tasks SET contract_version = contract_version + 1").run();
  db.prepare('UPDATE tasks SET lease_expires_at = ?').run(Date.now() - 1);
  db.close();
  const resumed = await commit({ cwd: root, sessionId: 'session-b', progress: 'resume write', nextAction: 'review queue', idempotencyKey: 'b2' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.needsReview, 1);
  const kept = listDeferredCommits({ cwd: root, taskId: resumed.taskId }).items;
  assert.equal(kept[0].status, 'conflict');
  assert.ok(kept[0].reason.includes('contract'));
});

test('queued drafts can be discarded and are never flushed afterwards', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-discard-');
  startTask({ cwd: root, sessionId: 'session-a', objective: 'R01 discard', idempotencyKey: 'start' });
  await commit({ cwd: root, sessionId: 'session-a', progress: 'from a', nextAction: 'hold', idempotencyKey: 'a1' });
  const deferred = await commit({ cwd: root, sessionId: 'session-b', progress: 'draft', evidenceRefs: ['x'], idempotencyKey: 'b1' });
  const item = listDeferredCommits({ cwd: root, taskId: deferred.taskId }).items[0];
  const discarded = discardDeferredCommit({ cwd: root, id: item.id, sessionId: 'session-b' });
  assert.equal(discarded.ok, true);
  const db = new DatabaseSync(path.join(root, '.deepseek-memory', 'memory.sqlite'));
  db.prepare('UPDATE tasks SET lease_expires_at = ?').run(Date.now() - 1);
  db.close();
  const resumed = await commit({ cwd: root, sessionId: 'session-b', progress: 'resume', nextAction: 'done', idempotencyKey: 'b2' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flushed, 0);
  assert.equal(listDeferredCommits({ cwd: root, taskId: resumed.taskId }).items[0].status, 'discarded');
});

test('same-session consecutive commits keep succeeding through their own lease', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-same-');
  startTask({ cwd: root, sessionId: 'session-a', objective: 'R01 same', idempotencyKey: 'start' });
  const one = await commit({ cwd: root, sessionId: 'session-a', progress: 'one', nextAction: 'two', idempotencyKey: 'c1' });
  const two = await commit({ cwd: root, sessionId: 'session-a', progress: 'two', nextAction: 'three', idempotencyKey: 'c2' });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(one.synced, true);
  assert.equal(two.synced, true);
});

test('agent dispose releases its own lease; crash still relies on TTL', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-dispose-');
  const a = harnessAgent('session-a');
  const dispose = registerAgent(a.agent, root, logger);
  t.after(() => dispose().catch(() => {}));
  await callTool(a, 'memory_start_task', { objective: 'R01 dispose', idempotency_key: 'start' });
  const saved = await callTool(a, 'memory_commit', { progress: 'held', next_action: 'release on dispose' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(taskRow(root).lease_owner, 'project-memory:session-a');
  await dispose();
  const row = taskRow(root);
  assert.equal(row.lease_owner, null);
  const events = openRow(root, "SELECT COUNT(*) n FROM events WHERE type = 'lease.released'").n;
  assert.equal(events, 1);
  // Session B can now commit immediately without waiting for the TTL.
  const b = harnessAgent('session-b');
  const disposeB = registerAgent(b.agent, root, logger);
  t.after(() => disposeB().catch(() => {}));
  const resumed = await callTool(b, 'memory_commit', { progress: 'after release', next_action: 'ok' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await disposeB();
});

test('memory_lease_status tool reports a readable state without leaking the fence', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-status-');
  const a = harnessAgent('session-a');
  const dispose = registerAgent(a.agent, root, logger);
  t.after(() => dispose().catch(() => {}));
  await callTool(a, 'memory_start_task', { objective: 'R01 status', idempotency_key: 'start' });
  await callTool(a, 'memory_commit', { progress: 'held', next_action: 'wait' });
  const status = await callTool(a, 'memory_lease_status', {});
  assert.equal(status.ok, true);
  assert.equal(status.heldBy, 'current-session');
  assert.ok(status.remainingSeconds > 0);
  assert.equal('fence' in status, false);
  await dispose();
});

test('v2 databases upgrade to the deferred_commits schema with a backup', (t) => {
  const root = temporaryDirectory(t, 'dsh-r01-v2-');
  const state = path.join(root, '.deepseek-memory');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'project.json'), JSON.stringify({ schema_version: 2, project_id: 'v2-project', created_at: '2026-10-25T00:00:00.000Z' }));
  // A real v2 database (projects + schema_meta 2); the v3 migration must
  // create a recovery copy before touching it.
  const dbPath = path.join(state, 'memory.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO schema_meta VALUES ('schema_version', '2');
    CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, marker_id TEXT NOT NULL UNIQUE, event_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, contract_json TEXT NOT NULL, task_version INTEGER NOT NULL, contract_version INTEGER NOT NULL, branch TEXT, workspace TEXT, lease_owner TEXT, lease_fence INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, display_order INTEGER NOT NULL DEFAULT 0, last_checkpoint_at TEXT, last_activity_at TEXT, superseded_by_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,id)) STRICT;
    CREATE TABLE events (project_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT, session_id TEXT, type TEXT NOT NULL, source_ref_json TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,seq)) STRICT;
    CREATE TABLE evidence (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, event_seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, branch TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, event_seq INTEGER NOT NULL, payload_json TEXT NOT NULL, branch TEXT, workspace TEXT, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE idempotency (project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,idempotency_key)) STRICT;
    CREATE TABLE session_bindings (session_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, workspace_id TEXT NOT NULL, bound_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, binding_source TEXT NOT NULL, PRIMARY KEY(session_id, project_id, workspace_id)) STRICT;
    CREATE TABLE contract_candidates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, base_contract_version INTEGER NOT NULL, diff_json TEXT NOT NULL, source_ref_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT) STRICT;
    CREATE TABLE tool_operations (call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, tool_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, result_summary_json TEXT, evidence_ref TEXT) STRICT;`);
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, 0, ?, ?)').run('v2-project', path.resolve(root), 'v2-project', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, 1, 1, NULL, NULL, NULL, 0, NULL, 1, NULL, NULL, NULL, ?, ?)').run('v2-task', 'v2-project', 'V2 task', 'active', '{}', '{}', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  db.close();
  const store = openProjectStore(root);
  assert.equal(fs.existsSync(`${dbPath}.v2-backup`), true);
  store.enqueueDeferredCommit({ projectId: 'v2-project', taskId: 'v2-task', sessionId: 's', baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: {} });
  store.close();
  const marker = JSON.parse(fs.readFileSync(path.join(state, 'project.json'), 'utf8'));
  assert.equal(marker.schema_version, 5);
});

function openRow(root, sql) {
  const db = new DatabaseSync(path.join(root, '.deepseek-memory', 'memory.sqlite'), { readOnly: true });
  const row = db.prepare(sql).get();
  db.close();
  return row;
}
