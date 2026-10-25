import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import { openProjectStore, SCHEMA_VERSION } from '../src/store.js';
import { search, startTask, commit, readProjectSnapshot, proposeContractChange, decideContractChange } from '../src/operations.js';
import { registerAgent, renderRecoveryPackage, workspaceFacts } from '../src/plugin.js';
import ProjectMemoryService from '../src/service.js';
import { detectSearchCapabilities } from '../src/search-index.js';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t) {
  const root = directory(t);
  const store = openProjectStore(root);
  const projectId = store.project.id;
  const facts = workspaceFacts(root, root);
  const scope = { projectId, taskId: 'a', branch: facts.branch, workspace: facts.workspaceId };
  store.createTask({ ...scope, id: 'a', title: 'task a' });
  store.createTask({ ...scope, id: 'b', title: 'task b' });
  store.bindSession({ sessionId: 'session-a', projectId, taskId: 'a', workspaceId: facts.workspaceId });
  store.bindSession({ sessionId: 'session-b', projectId, taskId: 'b', workspaceId: facts.workspaceId });
  return { root, store, projectId, facts, scope };
}
function ids(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.results.map(row => row.id); }

test('P1 case, word order, CJK short/long and mixed-language retrieval', t => {
  const { root, store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'greeting', payload: { summary: 'Hello! Hi lead，今天打招呼 handshake 已实现' } });
  } finally { store.close(); }
  const run = (query, mode = 'any') => search({ cwd: root, sessionId: 'session-a', query, mode });
  for (const query of ['hello', 'Hello', 'Hi lead', 'lead Hi', '招呼', '打招呼', '打招呼 handshake']) {
    assert.ok(ids(run(query)).includes('greeting'), query);
  }
  const mixed = run('打招呼 handshake', 'all');
  assert.deepEqual(mixed.normalizedTerms, ['打招呼', 'handshake']);
  assert.deepEqual(mixed.results[0].matchedTerms, ['打招呼', 'handshake']);
  assert.equal(mixed.backend.tokenizer, 'trigram');
  assert.equal(run('招呼').backend.shortTermFallback, true);
  assert.deepEqual(ids(run('lead Hi', 'phrase')), []);
  assert.ok(ids(run('Hi lead', 'phrase')).includes('greeting'));
});

test('P1 any/all/phrase have distinct semantics and diagnose query mismatch', t => {
  const { root, store, scope } = fixture(t);
  try {
    for (const [id, summary] of [['one', 'handshake'], ['both', 'handshake before greeting'], ['phrase', 'greeting handshake']]) {
      store.createCheckpoint({ ...scope, id, payload: { summary } });
    }
  } finally { store.close(); }
  const run = mode => search({ cwd: root, taskId: 'a', query: 'greeting handshake', mode });
  assert.deepEqual(new Set(ids(run('any'))), new Set(['one', 'both', 'phrase']));
  assert.deepEqual(new Set(ids(run('all'))), new Set(['both', 'phrase']));
  assert.deepEqual(ids(run('phrase')), ['phrase']);
  const miss = search({ cwd: root, taskId: 'a', query: 'handshake nonexistent', mode: 'all' });
  assert.deepEqual(ids(miss), []);
  assert.equal(miss.diagnostics.queryModeMismatch, true);
  assert.match(miss.diagnostics.message, /does not prove|not.*saved/i);
});

test('P1 current/task/project scopes isolate peers and echo exact filters', t => {
  const { root, store, scope, facts } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'local', payload: { summary: 'scope needle' } });
    store.createCheckpoint({ ...scope, taskId: 'b', id: 'peer-task', payload: { summary: 'scope needle' } });
    store.createCheckpoint({ ...scope, workspace: 'peer-workspace', id: 'peer-workspace', payload: { summary: 'scope needle' } });
    store.createCheckpoint({ ...scope, branch: 'peer-branch', id: 'peer-branch', payload: { summary: 'scope needle' } });
    store.bindSession({ sessionId: 'session-peer', projectId: scope.projectId, taskId: 'b', workspaceId: 'peer-workspace' });
    const other = store.ensureProject({ id: 'another-project', rootPath: path.join(root, 'other') });
    store.createTask({ projectId: other.id, id: 'other-project-task' });
    store.createCheckpoint({ projectId: other.id, taskId: 'other-project-task', id: 'other-project', payload: { summary: 'scope needle' } });
  } finally { store.close(); }
  const run = options => search({ cwd: root, sessionId: 'session-a', query: 'scope needle', ...options });
  const current = run({});
  assert.deepEqual(ids(current), ['local']);
  assert.equal(current.scope, 'current');
  assert.deepEqual(current.filters, { taskId: 'a', branch: facts.branch, workspace: facts.workspaceId });
  assert.deepEqual(ids(run({ sessionId: 'session-b' })), ['peer-task']);
  assert.deepEqual(new Set(ids(run({ scope: 'task' }))), new Set(['local', 'peer-workspace', 'peer-branch']));
  assert.deepEqual(new Set(ids(run({ scope: 'project' }))), new Set(['local', 'peer-task', 'peer-workspace', 'peer-branch']));
  assert.deepEqual(new Set(ids(run({ scope: 'project', taskId: 'b' }))), new Set(['peer-task']));
  assert.deepEqual(ids(run({ taskId: 'b' })), ['peer-task'], 'legacy explicit task stays in current workspace');
  assert.equal(run({ sessionId: 'unbound' }).error.code, 'TASK_SELECTION_REQUIRED');
  const miss = run({ query: 'needle', taskId: 'b', mode: 'phrase' });
  assert.equal(miss.diagnostics.scopeFilteredMatches, 3);
  assert.equal(miss.filters.branch, facts.branch);
});

test('P1 queued drafts are searchable, labelled unconfirmed, and excluded after flush', async t => {
  const root = directory(t);
  startTask({ cwd: root, sessionId: 'a', objective: 'deferred' });
  await commit({ cwd: root, sessionId: 'a', progress: 'lease held' });
  const queued = await commit({ cwd: root, sessionId: 'b', progress: '待同步 handshake', acceptanceUpdates: [{ criterion: 'draft-only', status: 'passed' }] });
  assert.equal(queued.synced, false);
  const run = includeDeferred => search({ cwd: root, sessionId: 'a', query: '待同步 handshake', mode: 'all', includeDeferred });
  const before = run(true);
  assert.equal(before.queuedDeferredCount, 1);
  assert.equal(before.results.length, 1);
  assert.equal(before.results[0].source, 'deferred');
  assert.equal(before.results[0].visibility, 'queued');
  assert.equal(before.results[0].synced, false);
  assert.equal(before.results[0].confirmed, false);
  assert.equal(before.results[0].freshness, 'unknown');
  assert.deepEqual(ids(run(false)), []);
  assert.equal(run(false).diagnostics.queuedMatchCount, 1);
  assert.doesNotMatch(renderRecoveryPackage(readProjectSnapshot({ cwd: root, sessionId: 'a' })), /draft-only|待同步/);
  const flushed = await commit({ cwd: root, sessionId: 'a', progress: 'flush' });
  assert.equal(flushed.flushed, 1);
  const after = run(true);
  assert.equal(after.queuedDeferredCount, 0);
  assert.equal(after.results.length, 1);
  assert.equal(after.results[0].source, 'checkpoint');
  assert.equal(after.results[0].confirmed, true);
});

test('P1 queued scope comes from the writer, and conflict/discarded stay diagnostic-only', t => {
  const { root, store, scope } = fixture(t);
  try {
    for (const [id, workspace] of [['local-q', scope.workspace], ['peer-q', 'peer-workspace']]) {
      store.enqueueDeferredCommit({ ...scope, id, workspace, sessionId: 'peer', baseTaskVersion: 1, baseContractVersion: 1,
        kind: 'append', payload: { progress: 'draft needle' } });
    }
    for (const status of ['conflict', 'discarded']) {
      store.enqueueDeferredCommit({ ...scope, id: status, sessionId: 'peer', baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: { progress: 'draft needle' } });
      store.updateDeferredCommit({ id: status, status });
    }
  } finally { store.close(); }
  const current = search({ cwd: root, sessionId: 'session-a', query: 'draft needle' });
  assert.deepEqual(ids(current), ['local-q']);
  assert.equal(current.diagnostics.conflictCount, 1);
  assert.equal(current.diagnostics.discardedCount, 1);
  assert.deepEqual(new Set(ids(search({ cwd: root, scope: 'task', taskId: 'a', query: 'draft needle' }))), new Set(['local-q', 'peer-q']));
});

test('P1 a flushed checkpoint shadows a queued row even before its status update', t => {
  const { root, store, scope } = fixture(t);
  try {
    store.enqueueDeferredCommit({ ...scope, id: 'q', sessionId: 'peer', baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: { progress: 'crash-window needle' } });
    store.createCheckpoint({ ...scope, id: 'flushed', payload: { summary: 'crash-window needle', deferredFlush: true, deferredItemId: 'q' } });
  } finally { store.close(); }
  const result = search({ cwd: root, taskId: 'a', query: 'crash-window', mode: 'phrase' });
  assert.deepEqual(ids(result), ['flushed']);
  assert.equal(result.queuedDeferredCount, 0);
});

test('P1 ranking is relevant, grouped, stable and limited; JSON stays within 16 KB', t => {
  const { root, store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'relevant', payload: { summary: 'alpha beta' } });
    store.createCheckpoint({ ...scope, id: 'newer-less-relevant', payload: { summary: 'alpha' } });
    for (let i = 0; i < 60; i++) store.createCheckpoint({ ...scope, id: `bulk-${i}`, payload: { summary: 'x'.repeat(3000) + ' alpha ' + '中😀'.repeat(3000) } });
    store.enqueueDeferredCommit({ ...scope, id: 'queued', sessionId: 'peer', baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: { progress: 'alpha beta' } });
  } finally { store.close(); }
  const run = limit => search({ cwd: root, taskId: 'a', query: 'alpha beta', limit });
  const first = run(1000);
  assert.equal(first.limit, 100);
  assert.equal(first.results[0].id, 'relevant');
  assert.deepEqual(first, run(1000), 'identical DB/query must produce identical JSON');
  assert.equal(run(1).results.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2)) <= 16384);
  assert.equal(first.budget.maxBytes, 16384);
  assert.equal(first.budget.truncated, true);
  assert.ok(first.results.every(row => row.snippet.includes('alpha')));
  assert.ok(first.results.every(row => !row.snippet.includes('\ufffd')));
  assert.ok(first.results.every(row => row.freshness === 'unknown'));
  assert.equal(isRemoteJsonValue(first), true);
});

test('P1 searches observations, evidence and task history without exposing lease metadata', t => {
  const { root, store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'acceptance', payload: { acceptanceUpdates: [{ criterion: '中文验收', status: 'passed', note: 'handshake' }], owner: 'secret-owner' } });
    store.addEvidence({ ...scope, id: 'evidence', kind: 'verification', payload: { command: 'node hello.js', stdout: 'handshake' } });
    store.updateTask({ projectId: scope.projectId, taskId: 'a', expectedVersion: 1, patch: { data: { progress: 'historical-handshake' } } });
  } finally { store.close(); }
  const result = search({ cwd: root, taskId: 'a', query: 'handshake' });
  assert.deepEqual(new Set(result.results.map(row => row.source)), new Set(['checkpoint', 'evidence', 'task-history']));
  assert.deepEqual(result.searchedSources, ['checkpoint', 'evidence', 'task-history', 'deferred']);
  for (const row of result.results) {
    for (const key of ['source', 'taskId', 'branch', 'workspace', 'eventSeq', 'snippet', 'matchedTerms', 'freshness']) assert.ok(Object.hasOwn(row, key), key);
    assert.equal(row.freshness, 'unknown');
    assert.equal(Object.hasOwn(row, 'payload'), false);
  }
  assert.deepEqual(ids(search({ cwd: root, taskId: 'a', query: 'secret-owner', mode: 'phrase' })), []);
});

test('P1 rejects invalid queries and treats SQL/FTS operators as data', t => {
  const { root, store, scope } = fixture(t);
  try { store.createCheckpoint({ ...scope, id: 'safe', payload: { summary: 'hello' } }); } finally { store.close(); }
  for (const options of [{ query: '' }, { query: '  ' }, { query: null }, { query: 'a'.repeat(513) }, { query: 'hello', mode: 'invalid' }, { query: 'hello', scope: 'invalid' }, { query: 'hello', includeDeferred: 'false' }, { query: 'hello', limit: 0 }, { query: 'hello', limit: Infinity }]) {
    assert.equal(search({ cwd: root, taskId: 'a', ...options }).error.code, 'INVALID_ARGUMENT');
  }
  for (const query of ['" OR 1=1 --', '" NEAR(hello) NOT "', "'); DROP TABLE tasks; --", '%_*']) {
    const result = search({ cwd: root, taskId: 'a', query, mode: 'phrase' });
    assert.deepEqual(ids(result), []);
  }
  assert.deepEqual(ids(search({ cwd: root, taskId: 'a', query: 'hello' })), ['safe']);
});

test('P1 source and FTS index writes roll back together on an indexing failure', t => {
  const { store, scope } = fixture(t);
  try {
    store.db.exec(`CREATE TRIGGER p1_fail_index BEFORE INSERT ON memory_search_documents
      WHEN instr(NEW.body, 'rollback-needle') > 0 BEGIN SELECT RAISE(ABORT, 'index failed'); END`);
    const before = store.getProject(scope.projectId).eventSeq;
    assert.throws(() => store.commitCheckpoint({ ...scope, expectedTaskVersion: 1, expectedContractVersion: 1,
      evidence: [{ kind: 'test', payload: { summary: 'transaction evidence' } }], checkpointPayload: { summary: 'rollback-needle' } }), /index failed/);
    assert.equal(store.getTask(scope.projectId, 'a').taskVersion, 1);
    assert.equal(store.getProject(scope.projectId).eventSeq, before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM checkpoints').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 0);
    assert.equal(store.search({ ...scope, query: 'transaction' }).length, 0);
  } finally { store.close(); }
});

test('P1 migrates a genuine v3 fixture, backs up WAL state and leaves event contents intact', t => {
  const root = directory(t);
  const state = path.join(root, '.deepseek-memory'); fs.mkdirSync(state);
  const databasePath = path.join(state, 'memory.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(fs.readFileSync(new URL('./fixtures/schema-v3.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO schema_meta VALUES ('schema_version', '3'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const stamp = '2026-10-25T00:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, 2, ?, ?)').run('legacy', path.resolve(root), 'legacy', stamp, stamp);
  db.prepare('INSERT INTO tasks(id,project_id,title,state,data_json,contract_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy-task', 'legacy', '旧任务', 'active', '{}', '{}', stamp, stamp);
  const payload = JSON.stringify({ summary: 'Hello 旧记录 handshake', acceptanceUpdates: [{ criterion: '中文验收', status: 'passed' }] });
  db.prepare('INSERT INTO events VALUES (?, 1, ?, NULL, ?, NULL, ?, ?)').run('legacy', 'legacy-task', 'task.created', JSON.stringify({ title: '旧任务', branch: 'main', workspace: 'w' }), stamp);
  db.prepare('INSERT INTO events VALUES (?, 2, ?, NULL, ?, NULL, ?, ?)').run('legacy', 'legacy-task', 'checkpoint.created', '{"id":"old-cp"}', stamp);
  db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?)').run('old-cp', 'legacy', 'legacy-task', 2, payload, 'main', 'w', stamp);
  db.prepare('INSERT INTO deferred_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('old-q', 'legacy', 'legacy-task', 'peer', 1, 1, 'append', '{"progress":"legacy draft"}', 'queued', stamp, null, null);
  fs.writeFileSync(path.join(state, 'project.json'), JSON.stringify({ schema_version: 3, project_id: 'legacy' }));
  const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
  // The writer remains open so the latest checkpoint is only in the WAL.
  let store;
  try {
    store = openProjectStore(root);
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'project.json'))).schema_version, 4);
    assert.equal(fs.existsSync(`${databasePath}.v3-backup`), true);
    const backup = new DatabaseSync(`${databasePath}.v3-backup`, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '3');
      assert.equal(backup.prepare('SELECT payload_json FROM checkpoints').get().payload_json, payload);
    } finally { backup.close(); }
    assert.deepEqual(store.db.prepare('SELECT * FROM events ORDER BY seq').all(), before);
    assert.deepEqual(store.search({ projectId: 'legacy', taskId: 'legacy-task', branch: 'main', workspace: 'w', query: 'hello' }).map(row => row.id), ['old-cp']);
    assert.equal(store.searchCapabilities.trigram, true);
    assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_search_fts'").get().sql, /trigram/);
    assert.equal(store.searchPage({ projectId: 'legacy', scope: 'project', query: 'legacy draft' }).results[0].visibility, 'queued');
    assert.equal(store.searchPage({ projectId: 'legacy', scope: 'current', taskId: 'legacy-task', branch: 'main', workspace: 'w', query: 'legacy draft' }).results.length, 0, 'unknown legacy origin must not be guessed');
  } finally { store?.close(); db.close(); }
});

test('P1 Agent ToolRuntime, operations and Remote share the query contract and budget', async t => {
  const root = directory(t);
  const host = new Context();
  const fiber = host.plugin({ name: 'p1-agent', apply(ctx) {
    ctx.provide('systemPrompt', { tools() {}, getContextOrder() { return 1; }, context() { return async () => {}; } });
    new ToolRuntime(ctx, { mode: 'native' });
  } });
  await fiber;
  const dispose = registerAgent({ id: 'a', ctx: fiber.ctx }, root, { warn() {} }, {});
  let seq = 0;
  const call = (name, args) => fiber.ctx.tools.execute({ name, arguments: args, callId: `p1-${++seq}`, signal: new AbortController().signal });
  try {
    await call('memory_start_task', { objective: 'shared retrieval' });
    await call('memory_commit', { progress: '打招呼 handshake' });
    const args = { query: 'handshake 打招呼', mode: 'all', scope: 'project', include_deferred: false, limit: 5 };
    const output = await call('memory_search', args);
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.equal(output.value.mode, 'all');
    assert.equal(output.value.scope, 'project');
    assert.equal(isRemoteJsonValue(output.value), true);
    assert.ok(Buffer.byteLength(output.content[0].text) <= 16384);
    assert.deepEqual(JSON.parse(output.content[0].text), output.value);
    const service = Object.create(ProjectMemoryService.prototype);
    const remote = service.search({ cwd: root, session_id: 'a', ...args });
    assert.deepEqual(remote, output.value);
    assert.deepEqual(search({ cwd: root, sessionId: 'a', query: args.query, mode: args.mode, scope: args.scope, includeDeferred: false, limit: 5 }), remote);
  } finally { await dispose(); await fiber.dispose(); }
});

test('P1 capability detection fails explicitly when trigram is unavailable', () => {
  const statements = [];
  const unavailable = { exec(sql) {
    statements.push(sql);
    if (sql.startsWith('CREATE')) throw new Error('no such tokenizer: trigram');
  } };
  assert.throws(() => detectSearchCapabilities(unavailable), error => error.code === 'SEARCH_UNAVAILABLE');
  assert.ok(statements.some(sql => sql.startsWith('DROP')));
});

test('P1 updating and deleting a source keeps its FTS index consistent after reopen', t => {
  const { root, store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'cp', payload: { summary: 'oldneedle' } });
    store.db.prepare('UPDATE checkpoints SET payload_json = ? WHERE id = ?').run('{"summary":"newneedle"}', 'cp');
    assert.equal(store.search({ ...scope, query: 'oldneedle' }).length, 0);
    assert.equal(store.search({ ...scope, query: 'newneedle' }).length, 1);
    store.db.prepare('DELETE FROM checkpoints WHERE id = ?').run('cp');
    assert.equal(store.search({ ...scope, query: 'newneedle' }).length, 0);
  } finally { store.close(); }
  const reopened = openProjectStore(root);
  try {
    assert.equal(reopened.search({ ...scope, query: 'newneedle' }).length, 0);
    assert.equal(reopened.migrationBackup, undefined, 'v4 reopen must not migrate again');
    reopened.db.exec("INSERT INTO memory_search_fts(memory_search_fts,rank) VALUES ('integrity-check',1)");
  } finally { reopened.close(); }
});

test('P1 confirmed groups precede queued groups and timestamp ties use binary IDs', t => {
  const { store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'confirmed', payload: { summary: 'alpha' } });
    for (const id of ['z', 'a', 'm']) store.enqueueDeferredCommit({ ...scope, id, sessionId: 'peer', baseTaskVersion: 1,
      baseContractVersion: 1, kind: 'append', payload: { progress: 'alpha beta' } });
    store.db.prepare('UPDATE deferred_commits SET created_at = ?').run('2026-10-25T00:00:00.000Z');
    const page = store.searchPage({ ...scope, query: 'alpha beta', limit: 10 });
    assert.deepEqual(ids(page), ['confirmed', 'a', 'm', 'z']);
    assert.deepEqual(page.groups, { confirmed: 1, queued: 3 });
  } finally { store.close(); }
});

test('P1 flush preserves a peer draft origin rather than relabelling it current', async t => {
  const { root, store, scope } = fixture(t);
  try {
    store.enqueueDeferredCommit({ ...scope, id: 'peer-origin', branch: 'peer-branch', workspace: 'peer-workspace', sessionId: 'peer',
      baseTaskVersion: 1, baseContractVersion: 1, kind: 'append', payload: { progress: 'peer-origin needle' } });
  } finally { store.close(); }
  const flushed = await commit({ cwd: root, sessionId: 'session-a', progress: 'flush peer' });
  assert.equal(flushed.flushed, 1);
  assert.deepEqual(ids(search({ cwd: root, sessionId: 'session-a', query: 'peer-origin needle', mode: 'phrase' })), []);
  const taskWide = search({ cwd: root, sessionId: 'session-a', query: 'peer-origin needle', mode: 'phrase', scope: 'task' });
  assert.equal(taskWide.results.length, 1);
  assert.equal(taskWide.results[0].workspace, 'peer-workspace');
  assert.equal(taskWide.results[0].branch, 'peer-branch');
  assert.equal(taskWide.results[0].visibility, 'confirmed');
});

test('P1 zero results distinguish scope filtering, and normalized Unicode is searchable', t => {
  const { root, store, scope } = fixture(t);
  try { store.createCheckpoint({ ...scope, workspace: 'peer', id: 'unicode', payload: { summary: 'Ｈｅｌｌｏ ÉCOLE 打招呼' } }); }
  finally { store.close(); }
  const local = search({ cwd: root, taskId: 'a', query: 'hello école', mode: 'all' });
  assert.deepEqual(ids(local), []);
  assert.equal(local.diagnostics.scopeFilteredMatches, 1);
  assert.deepEqual(ids(search({ cwd: root, taskId: 'a', query: 'hello école', mode: 'all', scope: 'task' })), ['unicode']);
});

test('P1 a failed v3 backfill rolls back schema/index changes and preserves its backup', t => {
  const root = directory(t);
  const state = path.join(root, '.deepseek-memory'); fs.mkdirSync(state);
  const databasePath = path.join(state, 'memory.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(fs.readFileSync(new URL('./fixtures/schema-v3.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO schema_meta VALUES ('schema_version','3')");
  const stamp = '2026-10-25T00:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES (?,?,?,1,?,?)').run('broken', path.resolve(root), 'broken', stamp, stamp);
  db.prepare('INSERT INTO events VALUES (?,1,NULL,?, ?,NULL,?,?)').run('broken', null, 'checkpoint.created', '{}', stamp);
  db.prepare('INSERT INTO checkpoints VALUES (?,?,NULL,1,?,?,?,?)').run('bad', 'broken', '{broken-json', 'main', 'w', stamp);
  db.close();
  fs.writeFileSync(path.join(state, 'project.json'), '{"schema_version":3,"project_id":"broken"}');
  assert.throws(() => openProjectStore(root), /JSON/i);
  const after = new DatabaseSync(databasePath);
  try {
    assert.equal(after.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '3');
    assert.equal(after.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'memory_search_%'").get().n, 0);
    assert.equal(after.prepare('PRAGMA table_info(deferred_commits)').all().some(row => row.name === 'workspace'), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'project.json'))).schema_version, 3);
    assert.equal(fs.existsSync(`${databasePath}.v3-backup`), true);
    after.prepare('UPDATE checkpoints SET payload_json = ?').run('{"summary":"repaired"}');
  } finally { after.close(); }
  const backupBytes = fs.readFileSync(`${databasePath}.v3-backup`);
  const recovered = openProjectStore(root);
  try {
    assert.equal(recovered.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '4');
    assert.notEqual(recovered.migrationBackup, `${databasePath}.v3-backup`, 'retry must create a fresh snapshot without overwriting an older backup');
    assert.deepEqual(fs.readFileSync(`${databasePath}.v3-backup`), backupBytes);
  } finally { recovered.close(); }
});

test('P1 accepted contract history becomes searchable, while pending proposals do not', t => {
  const root = directory(t);
  const started = startTask({ cwd: root, sessionId: 'a', objective: 'base objective' });
  const proposed = proposeContractChange({ cwd: root, taskId: started.task.id, expectedContractRevision: 1,
    diff: { objective: 'updated-contract handshake' }, sourceRef: 'user:change' });
  assert.deepEqual(ids(search({ cwd: root, sessionId: 'a', query: 'updated-contract', mode: 'phrase' })), []);
  assert.equal(decideContractChange({ cwd: root, candidateId: proposed.candidate.id, decision: 'accepted' }).ok, true);
  const result = search({ cwd: root, sessionId: 'a', query: 'updated-contract', mode: 'phrase' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].source, 'task-history');
  assert.equal(result.results[0].confirmed, true);
});

test('P1 store envelopes enforce explicit scope semantics and cannot widen current implicitly', t => {
  const { store, scope } = fixture(t);
  try {
    store.createCheckpoint({ ...scope, id: 'local-scope', payload: { summary: 'scope-terms' } });
    store.createCheckpoint({ ...scope, id: 'other-scope', workspace: 'peer', payload: { summary: 'scope-terms' } });
    const options = { ...scope, query: 'scope-terms', mode: 'phrase' };
    assert.deepEqual(new Set(ids(store.searchPage({ ...options, scope: 'task' }))), new Set(['local-scope', 'other-scope']));
    assert.deepEqual(store.searchPage({ ...options, scope: 'project' }).filters, { taskId: 'a', branch: null, workspace: null });
    assert.throws(() => store.searchPage({ projectId: scope.projectId, query: 'scope-terms' }), /current scope requires/);
  } finally { store.close(); }
});

test('P1 identical deferred text from one session is not deduplicated across branches', async t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  startTask({ cwd: root, sessionId: 'a', objective: 'branch scope' });
  await commit({ cwd: root, sessionId: 'a', progress: 'lease' });
  const main = await commit({ cwd: root, sessionId: 'b', progress: 'identical draft' });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  const feature = await commit({ cwd: root, sessionId: 'b', progress: 'identical draft' });
  assert.notEqual(main.deferredItemId, feature.deferredItemId);
  const page = search({ cwd: root, sessionId: 'b', query: 'identical draft', mode: 'phrase' });
  assert.deepEqual(ids(page), [feature.deferredItemId]);
  assert.equal(page.results[0].branch, 'feature');
});
