import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import { registerAgent, renderRecoveryPackage, AgentMemoryBinding } from '../src/plugin.js';
import { commit, startTask, readProjectSnapshot } from '../src/operations.js';
import { openProjectStore } from '../src/store.js';
import ProjectMemoryService from '../src/service.js';

const passed = [{ criterion: 'unit tests', status: 'passed', evidence_refs: ['test:unit'], note: 'verified' }];
const cleanup = new Map();
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p0-'));
  cleanup.set(root, []);
  t.after(async () => {
    for (const close of cleanup.get(root).reverse()) await close();
    cleanup.delete(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function agent(t, root, id) {
  const tools = new Map();
  const ctx = {
    systemPrompt: { getContextOrder() { return 1; }, context() { return async () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return async () => {}; } },
    on() { return async () => {}; },
  };
  cleanup.get(root).push(registerAgent({ id, ctx }, root, { warn() {} }, { compatibilityTools: true, adminTools: true }));
  return async (name, args = {}) => {
    const definition = tools.get(name);
    const value = await definition.execute(args);
    assert.equal(isRemoteJsonValue(value), true, `${name} must return lossless JSON`);
    const content = definition.output.render(args, value);
    assert.deepEqual(JSON.parse(content[0].text), value);
    return value;
  };
}
function snapshot(root) { return readProjectSnapshot({ cwd: root, sessionId: 'a' }); }
function assertPassed(root) {
  assert.deepEqual(snapshot(root).task.data.acceptanceUpdates, passed);
  assert.match(renderRecoveryPackage(snapshot(root)), /Acceptance status:.*"status":"passed"/);
}

// Real Harness Agent execution pipeline: its snapshot rejects undefined before
// output.render. No stringify/parse is allowed before this strict boundary.
test('P0 real Agent ToolRuntime preserves LEASE_CONFLICT instead of invalid output', async t => {
  const root = directory(t);
  async function nativeAgent(id) {
    const host = new Context();
    const fiber = host.plugin({ name: `p0-agent-${id}`, apply(ctx) {
      ctx.provide('systemPrompt', { tools() {}, getContextOrder() { return 1; }, context() { return async () => {}; } });
      new ToolRuntime(ctx, { mode: 'native' });
    } });
    await fiber;
    cleanup.get(root).push(() => fiber.dispose());
    cleanup.get(root).push(registerAgent({ id, ctx: fiber.ctx }, root, { warn() {} }, {}));
    fiber.ctx.tools.register({ name: 'bad_output_control', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] },
      execute() { return { nested: { invalid: undefined } }; } });
    let seq = 0;
    return (name, args = {}) => fiber.ctx.tools.execute({ name, arguments: args, callId: `${id}:${++seq}`, signal: new AbortController().signal });
  }
  const a = await nativeAgent('a');
  const b = await nativeAgent('b');
  const control = await a('bad_output_control');
  assert.equal(control.isError, true);
  assert.match(control.error.message, /invalid output: value is not lossless JSON/);
  const boot = await a('memory_start_task', { objective: 'hold lease' });
  assert.equal(boot.value.ok, true, JSON.stringify(boot));
  const saved = await a('memory_commit', { progress: 'holding' });
  assert.equal(saved.value.synced, true, JSON.stringify(saved));
  assert.ok(Buffer.byteLength(JSON.stringify(saved.value)) < 2048);
  const output = await b('memory_commit', { next_action: 'continue' });
  assert.equal(output.isError, false, JSON.stringify(output));
  assert.equal(isRemoteJsonValue(output.value), true);
  assert.deepEqual(JSON.parse(output.content[0].text), output.value);
  const conflict = output.value;
  assert.equal(conflict.error.code, 'LEASE_CONFLICT');
  assert.equal(conflict.error.heldBy, 'other-session');
  assert.ok(conflict.error.retryAfterSeconds > 0);
  assert.ok(Number.isFinite(Date.parse(conflict.error.canRetryAt)));
  assert.deepEqual(conflict.error.requested, { next_action: 'continue' });
  assert.doesNotMatch(JSON.stringify(conflict), /project-memory:a|owner|fence/i);
});

test('P0 acceptance survives three ordinary commits and evidence-only commits', async t => {
  const root = directory(t);
  const call = agent(t, root, 'a');
  await call('memory_start_task', { objective: 'acceptance' });
  assert.equal((await call('memory_commit', { acceptance_updates: passed })).ok, true);
  for (const args of [{ progress: 'one' }, { next_action: 'two' }, { progress: 'three', next_action: 'four' }, { evidence_refs: ['another:ref'] }]) {
    assert.equal((await call('memory_commit', args)).ok, true);
    assertPassed(root);
    assert.equal(Object.hasOwn(snapshot(root).checkpoint.payload, 'acceptanceUpdates'), false, 'omitted updates must not be written');
  }
});

test('P0 explicit empty acceptance list is a no-op observation, never an implicit clear', async t => {
  const root = directory(t);
  startTask({ cwd: root, sessionId: 'a', objective: 'empty semantics' });
  await commit({ cwd: root, sessionId: 'a', acceptanceUpdates: passed });
  assert.equal((await commit({ cwd: root, sessionId: 'a', acceptanceUpdates: [] })).ok, true);
  assertPassed(root);
  assert.deepEqual(snapshot(root).checkpoint.payload.acceptanceUpdates, []);
  await commit({ cwd: root, sessionId: 'a', progress: 'after empty' });
  assertPassed(root);
});

test('P0 acceptance validation rejects malformed updates before any writes', async t => {
  const root = directory(t);
  startTask({ cwd: root, sessionId: 'a', objective: 'validate' });
  const before = snapshot(root).project.eventSeq;
  for (const acceptanceUpdates of [null, {}, [null], [{}], [{ criterion: ' ', status: 'passed' }], [{ criterion: 'x', status: 'unknown' }], [{ criterion: 'x', status: 'passed', evidence_refs: [3] }], [{ criterion: 'x', status: 'passed', note: 3 }]]) {
    const result = await commit({ cwd: root, sessionId: 'a', acceptanceUpdates });
    assert.equal(result.ok, false, JSON.stringify(acceptanceUpdates));
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(snapshot(root).project.eventSeq, before);
});

test('P0 deferred acceptance flush persists state through later commits and a new session', async t => {
  const root = directory(t);
  const a = agent(t, root, 'a');
  const b = agent(t, root, 'b');
  await a('memory_start_task', { objective: 'deferred acceptance' });
  await a('memory_commit', { progress: 'lease held' });
  const deferred = await b('memory_commit', { acceptance_updates: passed });
  assert.equal(deferred.synced, false);
  assert.equal(typeof deferred.deferredItemId, 'string');
  assert.equal(deferred.deferredCount, 1);
  const flushed = await a('memory_commit', { progress: 'flush observations' });
  assert.equal(flushed.flushed, 1);
  assertPassed(root);
  await a('memory_commit', { progress: 'later' });
  assertPassed(root);
  assert.match(renderRecoveryPackage(readProjectSnapshot({ cwd: root, sessionId: 'new-session' })), /Acceptance status:.*passed/);
});

test('P0 recovery reads legacy acceptance hidden by empty checkpoints without migrating', async t => {
  const root = directory(t);
  const started = startTask({ cwd: root, sessionId: 'a', objective: 'legacy' });
  const { projectId, task } = started;
  const store = openProjectStore(root);
  try {
    const scope = { projectId, taskId: task.id, branch: task.branch, workspace: task.workspace };
    store.createCheckpoint({ ...scope, payload: { acceptanceUpdates: passed } });
    for (let i = 0; i < 3; i++) store.createCheckpoint({ ...scope, payload: { acceptanceUpdates: [] } });
    store.updateTask({ projectId, taskId: task.id, expectedVersion: 1, patch: { data: { acceptanceUpdates: [] } } });
  } finally { store.close(); }
  assert.match(renderRecoveryPackage(snapshot(root)), /Acceptance status:.*passed/);
  await commit({ cwd: root, sessionId: 'a', progress: 'new commit' });
  assert.match(renderRecoveryPackage(snapshot(root)), /Acceptance status:.*passed/);
});

test('P0 newer legacy deferred checkpoint overrides an older non-empty task observation', t => {
  const root = directory(t);
  const started = startTask({ cwd: root, sessionId: 'a', objective: 'legacy deferred' });
  const store = openProjectStore(root);
  try {
    store.updateTask({ projectId: started.projectId, taskId: started.task.id, expectedVersion: 1,
      patch: { data: { acceptanceUpdates: [{ criterion: 'unit tests', status: 'pending' }] } } });
    store.createCheckpoint({ projectId: started.projectId, taskId: started.task.id, branch: started.task.branch,
      workspace: started.task.workspace, payload: { acceptanceUpdates: passed, deferredFlush: true } });
  } finally { store.close(); }
  assert.deepEqual(snapshot(root).acceptanceUpdates, passed);
  assert.match(renderRecoveryPackage(snapshot(root)), /Acceptance status:.*passed/);
});

test('P0 memory_commit public result stays below 2 KB and omits internal objects', async t => {
  const root = directory(t);
  const call = agent(t, root, 'a');
  await call('memory_start_task', { objective: 'long objective'.repeat(2000) });
  const result = await call('memory_commit', { progress: 'large payload'.repeat(2000), acceptance_updates: passed, evidence_refs: Array.from({ length: 40 }, (_, i) => `ref:${i}`) });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'synced', 'projectId', 'taskId', 'taskVersion', 'contractVersion', 'checkpoint', 'flushed', 'needsReview'].sort());
  assert.deepEqual(Object.keys(result.checkpoint).sort(), ['id', 'eventSeq', 'createdAt'].sort());
  assert.doesNotMatch(JSON.stringify(result), /owner|fence|payload|evidence|long objective|large payload/i);
  assert.equal(result.taskVersion, snapshot(root).task.taskVersion);
});

test('P0 all registered Agent tools sanitize nested undefined and reject non-JSON output', async t => {
  const root = directory(t);
  const call = agent(t, root, 'a');
  for (const method of ['startTask', 'useTask', 'commit', 'leaseStatus', 'deferredCommits', 'discardDeferredCommit', 'search', 'propose', 'listTasks', 'setTaskState', 'bootstrap', 'read', 'claim', 'checkpoint', 'updateProgress', 'participants', 'completeTask']) {
    const original = AgentMemoryBinding.prototype[method];
    const names = { startTask: 'start_task', useTask: 'use_task', leaseStatus: 'lease_status', deferredCommits: 'deferred_list', discardDeferredCommit: 'deferred_discard', propose: 'propose_contract_change', listTasks: 'list_tasks', setTaskState: 'set_task_state', updateProgress: 'update_progress', completeTask: 'complete_task' };
    try {
      AgentMemoryBinding.prototype[method] = () => ({ ok: true, nested: { missing: undefined, list: [1, undefined, { absent: undefined }] } });
      assert.deepEqual(await call(`memory_${names[method] ?? method}`), { ok: true, nested: { list: [1, {}] } });
      const cycle = {}; cycle.self = cycle;
      for (const invalid of [NaN, Infinity, -Infinity, -0, () => {}, 1n, Symbol('x'), new Date(), new Map(), cycle, { get value() { throw new Error('getter'); } }]) {
        AgentMemoryBinding.prototype[method] = () => ({ ok: true, nested: invalid });
        const result = await call(`memory_${names[method] ?? method}`);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'INVALID_TOOL_OUTPUT');
      }
    } finally { AgentMemoryBinding.prototype[method] = original; }
  }
});

test('P0 criterion updates merge without losing other acceptance observations', async t => {
  const root = directory(t);
  startTask({ cwd: root, sessionId: 'a', objective: 'partial acceptance' });
  await commit({ cwd: root, sessionId: 'a', acceptanceUpdates: passed });
  for (const status of ['pending', 'failed', 'blocked', 'observed', 'passed']) {
    const update = { criterion: 'integration', status };
    assert.equal((await commit({ cwd: root, sessionId: 'a', acceptanceUpdates: [update] })).ok, true);
    assert.deepEqual(snapshot(root).task.data.acceptanceUpdates, [...passed, update]);
  }
});

test('P0 deferred omitted/empty acceptance remain distinct and neither clears state', async t => {
  const root = directory(t);
  startTask({ cwd: root, sessionId: 'a', objective: 'deferred no-op' });
  await commit({ cwd: root, sessionId: 'a', acceptanceUpdates: passed });
  const omitted = await commit({ cwd: root, sessionId: 'b', progress: 'same' });
  const empty = await commit({ cwd: root, sessionId: 'b', progress: 'same', acceptanceUpdates: [] });
  assert.equal(omitted.synced, false);
  assert.equal(empty.synced, false);
  assert.notEqual(omitted.deferredItemId, empty.deferredItemId);
  const store = openProjectStore(root);
  try {
    const queued = store.listDeferredCommits({ projectId: store.project.id });
    assert.equal(Object.hasOwn(queued.find(item => item.id === omitted.deferredItemId).payload, 'acceptanceUpdates'), false);
    assert.deepEqual(queued.find(item => item.id === empty.deferredItemId).payload.acceptanceUpdates, []);
  } finally { store.close(); }
  const flushed = await commit({ cwd: root, sessionId: 'a', progress: 'flush' });
  assert.equal(flushed.flushed, 2);
  assertPassed(root);
});

test('P0 compatibility lease errors never expose owner or fencing details', async t => {
  const root = directory(t);
  const a = agent(t, root, 'a');
  const b = agent(t, root, 'b');
  await a('memory_start_task', { objective: 'error privacy' });
  await a('memory_commit', { progress: 'hold' });
  const result = await b('memory_claim', { expected_revision: snapshot(root).task.taskVersion });
  assert.equal(result.error.code, 'LEASE_CONFLICT');
  assert.doesNotMatch(JSON.stringify(result), /project-memory:a|owner|fence/i);
});

test('P0 service commit preserves omission for snake_case and camelCase requests', async t => {
  const root = directory(t);
  const service = Object.create(ProjectMemoryService.prototype);
  startTask({ cwd: root, sessionId: 'a', objective: 'service' });
  for (const key of ['acceptance_updates', 'acceptanceUpdates']) {
    assert.equal((await service.commit({ cwd: root, session_id: 'a', [key]: passed })).ok, true);
    await service.commit({ cwd: root, session_id: 'a', progress: 'ordinary' });
    assertPassed(root);
    assert.equal((await service.commit({ cwd: root, session_id: 'a', [key]: null })).error.code, 'INVALID_ARGUMENT');
  }
});
