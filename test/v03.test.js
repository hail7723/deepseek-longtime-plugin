import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openProjectStore } from '../src/store.js';
import {
  commit, decideContractChange, proposeContractChange, readProjectSnapshot,
  startTask, useTask,
} from '../src/operations.js';
import { renderRecoveryPackage } from '../src/plugin.js';

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('v1 migration preserves records, creates a recovery backup, and imports candidates', (t) => {
  const root = temporaryDirectory(t, 'dsh-memory-v1-');
  const state = path.join(root, '.deepseek-memory');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'project.json'), JSON.stringify({ schema_version: 1, project_id: 'legacy-project', created_at: '2026-10-24T00:00:00.000Z' }));
  const databasePath = path.join(state, 'memory.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO schema_meta VALUES ('schema_version', '1');
    CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, marker_id TEXT NOT NULL UNIQUE, event_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, contract_json TEXT NOT NULL, task_version INTEGER NOT NULL, contract_version INTEGER NOT NULL, branch TEXT, workspace TEXT, lease_owner TEXT, lease_fence INTEGER NOT NULL, lease_expires_at INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,id)) STRICT;
    CREATE TABLE events (project_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT, session_id TEXT, type TEXT NOT NULL, source_ref_json TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,seq)) STRICT;
    CREATE TABLE evidence (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, event_seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, branch TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, event_seq INTEGER NOT NULL, payload_json TEXT NOT NULL, branch TEXT, workspace TEXT, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE idempotency (project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,idempotency_key)) STRICT;`);
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, 2, ?, ?)').run('legacy-project', path.resolve(root), 'legacy-project', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, 1, 1, NULL, NULL, NULL, 0, NULL, ?, ?)').run('legacy-task', 'legacy-project', 'Legacy task', 'active', '{}', '{"objective":"Preserve me"}', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z');
  db.prepare('INSERT INTO events VALUES (?, 1, ?, NULL, ?, NULL, ?, ?)').run('legacy-project', 'legacy-task', 'task.created', '{}', '2026-10-24T00:00:00.000Z');
  db.prepare('INSERT INTO events VALUES (?, 2, ?, NULL, ?, NULL, ?, ?)').run('legacy-project', 'legacy-task', 'contract.change-proposed', JSON.stringify({ proposal: { objective: 'Candidate' }, expectedContractRevision: 1, sourceRef: 'user:1' }), '2026-10-24T00:00:00.000Z');
  db.close();

  const store = openProjectStore(root);
  t.after(() => store.close());
  assert.equal(store.getTask('legacy-project', 'legacy-task').contract.objective, 'Preserve me');
  assert.equal(store.listContractCandidates({ projectId: 'legacy-project' }).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'project.json'))).schema_version, 2);
  assert.equal(fs.existsSync(`${databasePath}.v1-backup`), true);
  store.close();
});

test('session bindings prevent first-active selection and persist explicit choices', (t) => {
  const root = temporaryDirectory(t, 'dsh-memory-bindings-');
  const first = startTask({ cwd: root, sessionId: 'session-a', objective: 'First task', idempotencyKey: 'a' });
  const second = startTask({ cwd: root, sessionId: 'session-b', objective: 'Second task', idempotencyKey: 'b' });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const ambiguous = readProjectSnapshot({ cwd: root, sessionId: 'session-c' });
  assert.equal(ambiguous.selectionRequired, true);
  assert.equal(ambiguous.task, null);
  assert.equal(readProjectSnapshot({ cwd: root, sessionId: 'session-a' }).task.id, first.task.id);
  assert.equal(useTask({ cwd: root, sessionId: 'session-c', taskId: second.task.id }).ok, true);
  assert.equal(readProjectSnapshot({ cwd: root, sessionId: 'session-c' }).task.id, second.task.id);
});

test('commit is host-managed and recovery remains complete, deterministic, and bounded', (t) => {
  const root = temporaryDirectory(t, 'dsh-memory-recovery-v3-');
  const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
  const started = startTask({ cwd: root, sessionId: 'session-a', objective: 'x'.repeat(9000), constraints: ['constraint'.repeat(1000)], nextAction: 'verify recovery', idempotencyKey: 'start' });
  const saved = commit({ cwd: nested, sessionId: 'session-a', progress: 'implemented', nextAction: 'verify recovery', evidenceRefs: ['test:unit'], idempotencyKey: 'commit' });
  assert.equal(saved.ok, true);
  const rootSnapshot = readProjectSnapshot({ cwd: root, sessionId: 'session-a' });
  const nestedSnapshot = readProjectSnapshot({ cwd: nested, sessionId: 'session-a' });
  assert.equal(rootSnapshot.workspaceId, nestedSnapshot.workspaceId);
  const one = renderRecoveryPackage(rootSnapshot); const two = renderRecoveryPackage(readProjectSnapshot({ cwd: root, sessionId: 'session-a' }));
  assert.equal(one, two); assert.ok(Buffer.byteLength(one, 'utf8') <= 6000);
  assert.match(one, /Objective:/); assert.match(one, /Next action: verify recovery/); assert.match(one, /Conflict\/write rule:/);
  assert.equal(started.task.id, saved.taskId);
});

test('contract decisions are auditable and accepted updates advance the contract revision', (t) => {
  const root = temporaryDirectory(t, 'dsh-memory-candidates-');
  const started = startTask({ cwd: root, sessionId: 'session-a', objective: 'Original', idempotencyKey: 'start' });
  const proposed = proposeContractChange({ cwd: root, taskId: started.task.id, expectedContractRevision: 1, diff: { objective: 'Accepted' }, sourceRef: 'user:change', idempotencyKey: 'proposal' });
  const accepted = decideContractChange({ cwd: root, candidateId: proposed.candidate.id, decision: 'accepted', decidedBy: 'user', idempotencyKey: 'accept' });
  assert.equal(accepted.ok, true); assert.equal(accepted.task.contract.objective, 'Accepted'); assert.equal(accepted.task.contractVersion, 2);
});
