import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import * as operations from '../src/operations.js';
import { openProjectStore, ProjectMemoryStore } from '../src/store.js';
import { registerAgent, renderRecoveryPackage } from '../src/plugin.js';
import { configureSearchFunctions } from '../src/search-index.js';
import ProjectMemoryService from '../src/service.js';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p2-'));
  const closers = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, closers };
}
function fixture(t) {
  const base = directory(t);
  const started = operations.startTask({ cwd: base.root, sessionId: 'a', taskId: 'task', objective: 'Shared task' });
  assert.equal(started.ok, true);
  operations.useTask({ cwd: base.root, sessionId: 'b', taskId: 'task' });
  return { ...base, started, scope: { projectId: started.projectId, taskId: 'task', branch: started.branch, workspace: started.workspaceId } };
}
function list(root, sessionId = 'a', now = Date.now()) {
  const out = operations.participants({ cwd: root, sessionId, now });
  assert.equal(out.ok, true, JSON.stringify(out)); return out;
}
function update(root, sessionId, summary, extra = {}) {
  const out = operations.updateProgress({ cwd: root, sessionId, summary, status: 'working', ...extra });
  assert.equal(out.ok, true, JSON.stringify(out)); return out;
}
function harness(base, id, source = 'startup', parentSession, clock = Date.now) {
  const tools = new Map(); const contexts = new Map();
  const ctx = { systemPrompt: { getContextOrder() { return 1; }, context(d) { contexts.set(d.name, d); return () => {}; } },
    tools: { register(d) { tools.set(d.name, d); return () => {}; } }, on() { return () => {}; } };
  const dispose = registerAgent({ id, ctx, session: { header: { id, ...(parentSession ? { parentSession } : {}) } } }, base.root, { warn() {} }, { source, clock });
  base.closers.push(dispose);
  return { dispose, recovery: () => contexts.get('project-memory:recovery').text(),
    call: (name, args = {}) => tools.get(name).execute(args) };
}

test('P2 two sessions preserve independent progress; done is not completed', async t => {
  const { root } = fixture(t);
  await Promise.all([Promise.resolve().then(() => update(root, 'a', 'A summary', { nextAction: 'A next' })),
    Promise.resolve().then(() => update(root, 'b', 'B summary', { nextAction: 'B next', status: 'done' }))]);
  const rows = list(root).participants;
  assert.equal(rows.find(row => row.participantId === 'a').summary, 'A summary');
  assert.equal(rows.find(row => row.participantId === 'b').summary, 'B summary');
  update(root, 'a', 'A newer');
  assert.equal(list(root).participants.find(row => row.participantId === 'b').summary, 'B summary');
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).task.state, 'active');
});

test('P2 per-participant CAS, ownership and project-monotonic events', t => {
  const { root, scope } = fixture(t); const store = openProjectStore(root);
  try {
    const a = store.getParticipant({ ...scope, participantId: 'a' });
    const before = store.getProject(scope.projectId).eventSeq;
    const one = store.updateParticipant({ ...scope, sessionId: 'a', participantId: 'a', expectedVersion: a.version, patch: { summary: 'one' }, now: 1000 });
    assert.throws(() => store.updateParticipant({ ...scope, sessionId: 'a', participantId: 'a', expectedVersion: a.version, patch: { summary: 'stale overwrite' }, now: 1001 }), error => error.code === 'PARTICIPANT_REVISION_CONFLICT');
    const b = store.getParticipant({ ...scope, participantId: 'b' });
    store.updateParticipant({ ...scope, sessionId: 'b', participantId: 'b', expectedVersion: b.version, patch: { summary: 'independent' }, now: 1002 });
    assert.throws(() => store.updateParticipant({ ...scope, sessionId: 'a', participantId: 'b', expectedVersion: b.version + 1, patch: { summary: 'forged' }, now: 1003 }), error => error.code === 'PARTICIPANT_OWNER_CONFLICT');
    const events = store.listEvents(scope.projectId, { afterSeq: before });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.seq), [before + 1, before + 2]);
    assert.equal(one.event.seq, before + 1);
    assert.equal(store.getTask(scope.projectId, scope.taskId).taskVersion, 1, 'progress never changes task revision');
    assert.equal(store.db.prepare('PRAGMA table_info(participants)').all().some(row => /fence|lease/i.test(row.name)), false);
  } finally { store.close(); }
});

test('P2 resume reuses participant; new/fork identity stays independent and records real parent', async t => {
  const base = fixture(t);
  const a = harness(base, 'a');
  await a.call('memory_update_progress', { summary: 'before resume', status: 'waiting' });
  await a.dispose();
  const resumed = harness(base, 'a', 'resume');
  assert.match(resumed.recovery(), /before resume/);
  await resumed.call('memory_update_progress', { summary: 'after resume', status: 'working' });
  const fork = harness(base, 'fork-real-id', 'startup', 'a');
  await fork.call('memory_use_task', { task_id: 'task' });
  await fork.call('memory_update_progress', { summary: 'fork summary', status: 'working' });
  const rows = list(base.root).participants;
  assert.equal(rows.filter(row => row.participantId === 'a').length, 1);
  assert.equal(rows.find(row => row.participantId === 'a').summary, 'after resume');
  assert.equal(rows.find(row => row.participantId === 'fork-real-id').parentSessionId, 'a');
  assert.equal(rows.find(row => row.participantId === 'b').parentSessionId, null, 'do not infer a parent from any ID');
});

// Identity-only coverage of repeated provider reads and supplied source labels.
// Real compaction/request reinjection is covered in p2-compaction-reinjection.
// Supplying source=clear here does not establish Desktop /clear ID behavior.
test('P2 repeated recovery reads and source labels preserve identity (not compaction evidence)', t => {
  const base = fixture(t); const a = harness(base, 'a');
  const before = list(base.root).participants.length;
  for (let i = 0; i < 3; i++) assert.match(a.recovery(), /Current participant: a/);
  assert.equal(list(base.root).participants.length, before);
  const same = harness(base, 'a', 'compact');
  assert.match(same.recovery(), /Current participant: a/);
  const cleared = harness(base, 'a', 'clear');
  assert.match(cleared.recovery(), /Current participant: a/);
  assert.equal(list(base.root).participants.filter(row => row.participantId === 'a').length, 1);
});

test('P2 dispose marks inactive/disposed and releases only its own lease', async t => {
  const base = fixture(t); const a = harness(base, 'a');
  await a.call('memory_commit', { progress: 'held', next_action: 'next' });
  await a.dispose();
  const row = list(base.root, 'b').participants.find(p => p.participantId === 'a');
  assert.equal(row.active, false); assert.equal(row.presence, 'disposed'); assert.ok(row.disposedAt);
  const store = openProjectStore(base.root);
  try { assert.equal(store.getTask(base.scope.projectId, 'task').leaseOwner, null); } finally { store.close(); }
  assert.equal(operations.readProjectSnapshot({ cwd: base.root, sessionId: 'b' }).task.state, 'active');
});

test('P2 crash derives stale with injected time, without inventing a disposal', t => {
  const { root } = fixture(t);
  update(root, 'a', 'crashed work', { now: 1000 });
  const fresh = list(root, 'a', 1001).participants.find(p => p.participantId === 'a');
  assert.equal(fresh.presence, 'active');
  const stale = list(root, 'a', 301001).participants.find(p => p.participantId === 'a');
  assert.equal(stale.presence, 'stale'); assert.equal(stale.active, false); assert.equal(stale.disposedAt, null);
  const text = renderRecoveryPackage(operations.readProjectSnapshot({ cwd: root, sessionId: 'a', now: 301001 }));
  assert.match(text, /stale/); assert.doesNotMatch(text, /presence=disposed/);
});

test('P2 old instance disposal cannot deactivate a resumed instance', async t => {
  const base = fixture(t); const old = harness(base, 'a'); const current = harness(base, 'a', 'resume');
  await current.call('memory_update_progress', { summary: 'current instance', status: 'working' });
  await old.dispose();
  assert.equal(list(base.root).participants.find(row => row.participantId === 'a').presence, 'active');
});

test('P2 recovery prioritizes self and bounds other participants deterministically', t => {
  const { root, scope } = fixture(t);
  update(root, 'a', 'self summary', { nextAction: 'self next' });
  update(root, 'b', 'peer summary', { nextAction: 'peer next' });
  const store = openProjectStore(root);
  try { for (let i = 0; i < 70; i++) store.updateParticipant({ ...scope, sessionId: `p-${i}`, participantId: `p-${i}`, expectedVersion: 0,
    patch: { summary: '中文😀'.repeat(500), status: 'working', nextAction: 'large next' }, now: 1000 + i }); }
  finally { store.close(); }
  const snap = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' });
  const text = renderRecoveryPackage(snap);
  assert.match(text, /Current participant: a/); assert.match(text, /Current state: self summary/);
  assert.match(text, /Next action: self next/); assert.match(text, /Other participants/);
  assert.doesNotMatch(text, /Current state: peer summary|Next action: peer next/);
  assert.ok(Buffer.byteLength(text) <= 6000);
  assert.equal(text, renderRecoveryPackage(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' })));
  const overview = list(root);
  assert.equal(overview.participants[0].participantId, 'a');
  assert.ok(Buffer.byteLength(JSON.stringify(overview, null, 2)) <= 8192);
  assert.equal(overview.truncated, true);
});

test('P2 project/task/workspace scope cannot leak participant summaries', t => {
  const { root, scope } = fixture(t); const store = openProjectStore(root);
  try {
    store.createTask({ projectId: scope.projectId, id: 'other-task' });
    const other = store.ensureProject({ id: 'other-project', rootPath: path.join(root, 'other') });
    store.createTask({ projectId: other.id, id: 'project-task' });
    for (const [projectId, taskId, workspace] of [[scope.projectId, 'other-task', scope.workspace], [other.id, 'project-task', scope.workspace], [scope.projectId, 'task', 'peer-workspace']]) {
      store.updateParticipant({ projectId, taskId, workspace, branch: scope.branch, sessionId: `peer-${taskId}-${workspace}`, expectedVersion: 0, patch: { summary: 'secret peer scope' }, now: 1000 });
    }
  } finally { store.close(); }
  assert.doesNotMatch(JSON.stringify(list(root)), /secret peer scope/);
  assert.doesNotMatch(renderRecoveryPackage(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' })), /secret peer scope/);
});

test('P2 memory_commit records caller progress/checkpoint without overwriting a peer', async t => {
  const base = fixture(t);
  update(base.root, 'a', 'A independent', { nextAction: 'A independent next' });
  const b = harness(base, 'b');
  const saved = await b.call('memory_commit', { progress: 'B committed', next_action: 'B next' });
  assert.equal(saved.ok, true);
  const rows = list(base.root).participants;
  assert.equal(rows.find(row => row.participantId === 'a').summary, 'A independent');
  assert.equal(rows.find(row => row.participantId === 'b').lastCheckpointSeq, saved.checkpoint.eventSeq);
  assert.match(renderRecoveryPackage(operations.readProjectSnapshot({ cwd: base.root, sessionId: 'a' })), /Current state: A independent/);
});

test('P2 queued/conflict deferred block completion with actionable counts', async t => {
  const { root, scope } = fixture(t); const store = openProjectStore(root);
  try { store.enqueueDeferredCommit({ ...scope, id: 'pending', sessionId: 'b', baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: { progress: 'not merged' } }); }
  finally { store.close(); }
  for (const status of ['queued', 'conflict']) {
    const result = operations.completeTask({ cwd: root, sessionId: 'a', summary: 'finish', evidenceRefs: [] });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'DEFERRED_COMPLETION_BLOCKED');
    assert.match(result.error.message, /review|flush|discard/i);
    assert.equal(result.error[status === 'queued' ? 'queuedCount' : 'conflictCount'], 1);
    if (status === 'queued') { const s = openProjectStore(root); try { s.updateDeferredCommit({ id: 'pending', status: 'conflict' }); } finally { s.close(); } }
  }
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).task.state, 'active');
  assert.equal((await operations.commit({ cwd: root, sessionId: 'a', progress: 'legacy completion', state: 'completed' })).error.code, 'DEFERRED_COMPLETION_BLOCKED');
});

test('P2 foreign live lease refuses completion without owner/fence leakage', async t => {
  const { root } = fixture(t);
  await operations.commit({ cwd: root, sessionId: 'a', progress: 'held' });
  const result = operations.completeTask({ cwd: root, sessionId: 'b', summary: 'must fail' });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'LEASE_CONFLICT');
  assert.equal(result.error.heldBy, 'other-session'); assert.ok(result.error.retryAfterSeconds > 0);
  assert.doesNotMatch(JSON.stringify(result), /project-memory:a|owner|fence/i);
});

test('P2 terminal checkpoint, task event, lease release and binding invalidation are atomic', async t => {
  const { root, scope } = fixture(t);
  await operations.commit({ cwd: root, sessionId: 'a', progress: 'before complete' });
  const result = operations.completeTask({ cwd: root, sessionId: 'a', summary: 'terminal handshake', evidenceRefs: ['test:passed'], idempotencyKey: 'finish' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.state, 'completed'); assert.equal(result.leaseReleased, true);
  const store = openProjectStore(root);
  try {
    assert.equal(store.getTask(scope.projectId, 'task').state, 'completed');
    assert.equal(store.getTask(scope.projectId, 'task').leaseOwner, null);
    const checkpoint = store.latestCheckpoint(scope.projectId, scope);
    assert.equal(checkpoint.payload.terminal, true); assert.equal(checkpoint.payload.summary, 'terminal handshake');
    assert.ok(store.listEvents(scope.projectId).some(event => event.type === 'task.completed'));
    assert.ok(store.listParticipants({ ...scope, now: Date.now() }).every(p => !p.active));
  } finally { store.close(); }
  const recovery = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' });
  assert.equal(recovery.task, null);
  assert.match(renderRecoveryPackage(recovery), /completed/);
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'new-session' }).task, null);
  assert.ok(operations.search({ cwd: root, taskId: 'task', query: 'terminal handshake', scope: 'task', mode: 'phrase' }).results.length > 0);
  assert.ok(operations.search({ cwd: root, query: 'terminal handshake', scope: 'project', mode: 'phrase' }).results.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) < 2048);
});

test('P2 completion replay is idempotent after invalidation and payload reuse conflicts', t => {
  const { root } = fixture(t);
  const options = { cwd: root, sessionId: 'a', summary: 'finish once', idempotencyKey: 'once' };
  const first = operations.completeTask(options);
  assert.equal(first.ok, true, JSON.stringify(first));
  const seq = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq;
  assert.deepEqual(operations.completeTask(options), first);
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq, seq);
  assert.equal(operations.completeTask({ ...options, summary: 'changed' }).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('P2 unbound sole-task completion persists its invalidated binding for an idempotent retry', t => {
  const { root, scope } = fixture(t);
  const options = { cwd: root, sessionId: 'unbound-completer', summary: 'complete sole task', idempotencyKey: 'sole-complete' };
  const first = operations.completeTask(options);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq;
  assert.deepEqual(operations.completeTask(options), first);
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'unbound-completer' }).task, null);
  const store = openProjectStore(root);
  try {
    assert.equal(store.getSessionBinding({ projectId: scope.projectId, sessionId: 'unbound-completer', workspaceId: scope.workspace }).taskId, 'task');
    assert.equal(store.getProject(scope.projectId).eventSeq, before);
  } finally { store.close(); }
});

test('P2 failed terminal indexing rolls back lifecycle, participant, checkpoint and lease', t => {
  const { root, scope } = fixture(t); const store = openProjectStore(root);
  try {
    const before = store.getProject(scope.projectId).eventSeq;
    const participant = store.getParticipant({ ...scope, participantId: 'a' });
    store.db.exec("CREATE TRIGGER p2_fail BEFORE INSERT ON checkpoints WHEN json_extract(NEW.payload_json,'$.terminal')=1 BEGIN SELECT RAISE(ABORT,'terminal failed'); END");
    assert.throws(() => store.completeTask({ ...scope, sessionId: 'a', summary: 'cannot commit', evidenceRefs: [], idempotencyKey: 'fail' }), /terminal failed/);
    assert.equal(store.getProject(scope.projectId).eventSeq, before);
    assert.deepEqual(store.getParticipant({ ...scope, participantId: 'a' }), participant);
    assert.equal(store.getTask(scope.projectId, 'task').state, 'active');
    assert.equal(store.getTask(scope.projectId, 'task').leaseOwner, null);
  } finally { store.close(); }
});

function legacy(t, failure = false) {
  const base = directory(t); const state = path.join(base.root, '.deepseek-memory'); fs.mkdirSync(state);
  const file = path.join(state, 'memory.sqlite'); const db = new DatabaseSync(file);
  configureSearchFunctions(db);
  db.exec(fs.readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO schema_meta VALUES ('schema_version','4'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const stamp = '2026-10-25T00:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES (?,?,?,1,?,?)').run('old', path.resolve(base.root), 'old', stamp, stamp);
  db.prepare('INSERT INTO tasks(id,project_id,title,state,data_json,contract_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('old-task', 'old', 'preserve v4', 'active', '{}', '{}', stamp, stamp);
  db.prepare('INSERT INTO events VALUES (?,1,?,NULL,?,NULL,?,?)').run('old', 'old-task', 'task.created', '{"title":"preserve v4"}', stamp);
  if (failure) db.exec('CREATE VIEW participants AS SELECT 1 AS broken');
  fs.writeFileSync(path.join(state, 'project.json'), '{"schema_version":4,"project_id":"old"}');
  return { ...base, db, file, state };
}

test('P2 v4→v5 backs up WAL state and preserves source history without invented participants', t => {
  const { root, db, file, state } = legacy(t);
  let store;
  try {
    const events = db.prepare('SELECT * FROM events').all();
    store = openProjectStore(root);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'project.json'))).schema_version, 5);
    const backup = new DatabaseSync(`${file}.v4-backup`, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '4');
      assert.deepEqual(backup.prepare('SELECT * FROM events').all(), events);
    } finally { backup.close(); }
    assert.deepEqual(store.db.prepare('SELECT * FROM events').all(), events);
    assert.equal(store.db.prepare('SELECT count(*) n FROM participants').get().n, 0);
    assert.ok(store.search({ projectId: 'old', taskId: 'old-task', scope: 'task', query: 'preserve' }).length);
  } finally { store?.close(); db.close(); }
});

test('P2 failed v5 migration leaves v4 reopenable and retry preserves the old backup', t => {
  const { root, db, file, state } = legacy(t, true); db.close();
  assert.throws(() => openProjectStore(root), /participants.*exists|already exists/i);
  const reader = new ProjectMemoryStore(file, { readOnly: true });
  try {
    assert.equal(reader.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '4');
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'project.json'))).schema_version, 4);
    assert.ok(reader.search({ projectId: 'old', taskId: 'old-task', scope: 'task', query: 'preserve' }).length);
  } finally { reader.close(); }
  const before = fs.readFileSync(`${file}.v4-backup`);
  const fix = new DatabaseSync(file); fix.exec('DROP VIEW participants'); fix.close();
  const store = openProjectStore(root);
  try { assert.equal(store.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '5'); }
  finally { store.close(); }
  assert.deepEqual(fs.readFileSync(`${file}.v4-backup`), before);
});

test('P2 all new tools cross real ToolRuntime with strict JSON and bounded responses', async t => {
  const { root } = directory(t); const host = new Context();
  const fiber = host.plugin({ name: 'p2-native', apply(ctx) {
    ctx.provide('systemPrompt', { tools() {}, getContextOrder() { return 1; }, context() { return () => {}; } });
    new ToolRuntime(ctx, { mode: 'native' });
  } }); await fiber;
  const dispose = registerAgent({ id: 'native', ctx: fiber.ctx }, root, { warn() {} }, {});
  let seq = 0;
  const call = async (name, args, max = 2048) => {
    const out = await fiber.ctx.tools.execute({ name, arguments: args, callId: `p2-${++seq}`, signal: new AbortController().signal });
    assert.equal(out.isError, false, JSON.stringify(out));
    assert.equal(isRemoteJsonValue(out.value), true);
    assert.deepEqual(JSON.parse(out.content[0].text), out.value);
    assert.ok(Buffer.byteLength(out.content[0].text) <= max);
    return out.value;
  };
  try {
    const boot = await call('memory_start_task', { objective: 'native participants' }, 8192);
    for (const [name, args] of [
      ['memory_update_progress', { summary: 'spoof', participant_id: 'peer' }],
      ['memory_participants', { session_id: 'peer' }],
      ['memory_complete_task', { summary: 'force attempt', force: true }],
    ]) {
      const rejected = await fiber.ctx.tools.execute({ name, arguments: args, callId: `p2-invalid-${++seq}`, signal: new AbortController().signal });
      assert.equal(rejected.isError, false, 'tool contract errors use the public JSON error envelope');
      assert.equal(rejected.value.ok, false, `${name} must reject ownership/force overrides`);
      assert.equal(rejected.value.error.code, 'INVALID_ARGUMENT');
      assert.doesNotMatch(JSON.stringify(rejected), /value is not lossless JSON/);
    }
    const progress = await call('memory_update_progress', { summary: 'native summary', status: 'done', idempotency_key: 'update' });
    assert.equal(progress.ok, true);
    const view = await call('memory_participants', {}, 8192);
    assert.equal(view.participants[0].status, 'done');
    const stale = await call('memory_update_progress', { summary: 'stale', expected_version: 0 });
    assert.equal(stale.error.code, 'PARTICIPANT_REVISION_CONFLICT');
    await call('memory_commit', { progress: 'native holds lease' });
    const queued = await operations.commit({ cwd: root, sessionId: 'peer', progress: 'unsynced native draft' });
    assert.equal(queued.synced, false);
    const blocked = await call('memory_complete_task', { summary: 'premature' });
    assert.equal(blocked.error.code, 'DEFERRED_COMPLETION_BLOCKED'); assert.equal(blocked.error.queuedCount, 1);
    await call('memory_commit', { progress: 'native flushes' });
    const service = Object.create(ProjectMemoryService.prototype);
    assert.equal(service.participants({ cwd: root, session_id: 'native' }).participants[0].summary, 'native flushes');
    const done = await call('memory_complete_task', { summary: 'native complete', evidence_refs: ['native:test'], idempotency_key: 'finish' });
    assert.equal(done.taskId, boot.task.id); assert.equal(done.state, 'completed');
    assert.doesNotMatch(JSON.stringify(done), /owner|fence|payload/);
  } finally { await dispose(); await fiber.dispose(); }
});

test('P2 resumed session disposal releases its persisted own lease even before another commit', async t => {
  const base = fixture(t);
  await operations.commit({ cwd: base.root, sessionId: 'a', progress: 'persisted before crash' });
  const resumed = harness(base, 'a', 'resume');
  await resumed.dispose();
  const store = openProjectStore(base.root);
  try { assert.equal(store.getTask(base.scope.projectId, 'task').leaseOwner, null); } finally { store.close(); }
  assert.equal(list(base.root).participants.find(row => row.participantId === 'a').presence, 'disposed');
});

test('P2 participant reads are read-only and progress succeeds under a peer task lease', async t => {
  const { root, scope } = fixture(t);
  await operations.commit({ cwd: root, sessionId: 'a', progress: 'holder' });
  const before = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq;
  list(root, 'b'); list(root, 'a');
  assert.equal(operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq, before);
  const updated = update(root, 'b', 'independent under foreign lease', { idempotencyKey: 'p' });
  assert.equal(updated.ok, true);
  assert.deepEqual(operations.updateProgress({ cwd: root, sessionId: 'b', summary: 'independent under foreign lease', status: 'working', idempotencyKey: 'p' }), updated);
  assert.equal(operations.updateProgress({ cwd: root, sessionId: 'b', summary: 'changed', idempotencyKey: 'p' }).error.code, 'IDEMPOTENCY_CONFLICT');
  const store = openProjectStore(root);
  try { assert.equal(store.getTask(scope.projectId, 'task').leaseOwner, 'project-memory:a'); } finally { store.close(); }
});

test('P2 completed tasks reject late enqueues from stale writers', t => {
  const { root, scope } = fixture(t);
  assert.equal(operations.completeTask({ cwd: root, sessionId: 'a', summary: 'done' }).ok, true);
  const store = openProjectStore(root);
  try { assert.throws(() => store.enqueueDeferredCommit({ ...scope, sessionId: 'b', baseTaskVersion: 1, baseContractVersion: 1,
    kind: 'append', payload: { progress: 'late' } }), error => error.code === 'TASK_TERMINAL'); } finally { store.close(); }
});

test('P2 deferred flush records its author checkpoint without reviving a disposed peer', async t => {
  const base = fixture(t); const a = harness(base, 'a'); const b = harness(base, 'b');
  await a.call('memory_commit', { progress: 'lease held' });
  await b.call('memory_commit', { progress: 'B durable deferred' });
  await b.dispose();
  await a.call('memory_commit', { progress: 'flush B' });
  const peer = list(base.root).participants.find(row => row.participantId === 'b');
  assert.equal(peer.summary, 'B durable deferred');
  assert.equal(peer.presence, 'disposed');
  assert.ok(peer.lastCheckpointSeq > 0);
});

test('P2 legacy state completed uses terminal semantics and releases its lease', async t => {
  const base = fixture(t); const a = harness(base, 'a');
  const result = await a.call('memory_commit', { state: 'completed', progress: 'compat complete' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const store = openProjectStore(base.root);
  try { assert.equal(store.latestCheckpoint(base.scope.projectId, base.scope).payload.terminal, true);
    assert.equal(store.getTask(base.scope.projectId, 'task').leaseOwner, null); } finally { store.close(); }
});

test('P2 flushing older deferred content never overwrites newer independent author progress', async t => {
  const base = fixture(t); const a = harness(base, 'a'); const b = harness(base, 'b');
  await a.call('memory_commit', { progress: 'A holds lease' });
  const queued = await b.call('memory_commit', { progress: 'B older draft' });
  assert.equal(queued.synced, false);
  await b.call('memory_update_progress', { summary: 'B newer report', status: 'blocked', next_action: 'resolve' });
  await a.call('memory_commit', { progress: 'A flushes draft' });
  const row = list(base.root, 'b').participants[0];
  assert.equal(row.summary, 'B newer report'); assert.equal(row.status, 'blocked');
  assert.equal(row.nextAction, 'resolve'); assert.ok(row.lastCheckpointSeq > 0);
});

test('P2 late checkpoint cannot revive a participant on a completed task', t => {
  const { root, scope } = fixture(t);
  assert.equal(operations.completeTask({ cwd: root, sessionId: 'a', summary: 'done' }).ok, true);
  const store = openProjectStore(root);
  try {
    const task = store.getTask(scope.projectId, 'task');
    const lease = store.acquireLease({ ...scope, owner: 'project-memory:b', ttlMs: 60000 });
    const before = store.getProject(scope.projectId).eventSeq;
    assert.throws(() => store.commitCheckpoint({ ...scope, expectedTaskVersion: task.taskVersion,
      expectedContractVersion: task.contractVersion, lease, checkpointPayload: { summary: 'late' },
      participantUpdate: { sessionId: 'b', patch: { summary: 'revive', status: 'working' } } }), error => error.code === 'TASK_TERMINAL');
    assert.equal(store.getProject(scope.projectId).eventSeq, before);
    assert.equal(store.getParticipant({ ...scope, participantId: 'b' }).active, false);
  } finally { store.close(); }
});

test('P2 oversized receipt identity fails before progress or completion mutation', t => {
  const { root } = directory(t); const taskId = '"'.repeat(2200);
  assert.equal(operations.startTask({ cwd: root, sessionId: 'a', taskId, objective: 'legacy large identity' }).ok, true);
  const before = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' }).project.eventSeq;
  const progress = operations.updateProgress({ cwd: root, sessionId: 'a', summary: 'must not persist' });
  assert.equal(progress.ok, false); assert.equal(progress.error.code, 'PARTICIPANT_RESPONSE_TOO_LARGE');
  const done = operations.completeTask({ cwd: root, sessionId: 'a', summary: 'must not complete' });
  assert.equal(done.ok, false); assert.equal(done.error.code, 'PARTICIPANT_RESPONSE_TOO_LARGE');
  const after = operations.readProjectSnapshot({ cwd: root, sessionId: 'a' });
  assert.equal(after.project.eventSeq, before); assert.equal(after.task.state, 'active');
});

test('P2 recovery budget preserves self and lifecycle under maximum historical and peer content', t => {
  const huge = '中文\"\\\n'.repeat(10000);
  const current = { participantId: 'self', summary: huge, nextAction: huge, status: 'blocked', presence: 'active', lastSeenAt: huge };
  const output = renderRecoveryPackage({ initialized: true, project: { id: huge }, task: { id: huge, state: 'blocked', title: huge,
    contract: { objective: huge, constraints: [huge], acceptanceCriteria: [huge] }, taskVersion: 1, contractVersion: 1 },
    currentParticipant: current, participantCount: 51, participants: [current, ...Array.from({ length: 50 }, (_, i) => ({ ...current, participantId: `peer-${i}${huge}`, presence: 'stale' }))],
    workspaceId: huge, branch: huge, codeRevision: huge, checkpoint: { id: huge, payload: { summary: huge, nextAction: huge, evidenceRefs: [huge] } },
    toolOperations: [{ status: 'pending', toolName: huge }] });
  assert.ok(Buffer.byteLength(output) <= 6000, `recovery bytes=${Buffer.byteLength(output)}`);
  assert.match(output, /Task lifecycle: blocked/); assert.match(output, /Current participant: self/);
  assert.match(output, /Current state:/); assert.match(output, /Conflict\/write rule:/);
});

test('P2 separate SQLite connections retain independent CAS while rejecting a stale own revision', t => {
  const { root, scope } = fixture(t); const one = openProjectStore(root); const two = openProjectStore(root);
  try {
    const a = one.getParticipant({ ...scope, participantId: 'a' });
    const b = two.getParticipant({ ...scope, participantId: 'b' });
    one.updateParticipant({ ...scope, sessionId: 'a', expectedVersion: a.version, patch: { summary: 'connection one' } });
    two.updateParticipant({ ...scope, sessionId: 'b', expectedVersion: b.version, patch: { summary: 'connection two' } });
    assert.throws(() => two.updateParticipant({ ...scope, sessionId: 'a', expectedVersion: a.version, patch: { summary: 'stale connection' } }), error => error.code === 'PARTICIPANT_REVISION_CONFLICT');
    assert.equal(two.getParticipant({ ...scope, participantId: 'a' }).summary, 'connection one');
    assert.equal(one.getParticipant({ ...scope, participantId: 'b' }).summary, 'connection two');
  } finally { one.close(); two.close(); }
});
