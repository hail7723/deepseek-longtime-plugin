import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrap,
  checkpoint,
  claim,
  proposeContractChange,
  readProjectSnapshot,
  search,
} from '../src/operations.js';

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertJsonResult(value) {
  assert.doesNotThrow(() => JSON.stringify(value));
  return value;
}

function bootstrapTask(root, overrides = {}) {
  return bootstrap({
    cwd: root,
    taskId: 'task-1',
    objective: 'Share memory operations',
    acceptanceCriteria: ['Host and tools observe the same state'],
    constraints: ['Keep revision checks'],
    nextAction: 'claim task',
    sourceRef: 'test:bootstrap',
    idempotencyKey: 'bootstrap-1',
    ...overrides,
  });
}

test('readProjectSnapshot reports an uninitialized cwd without creating state', (t) => {
  const root = temporaryDirectory(t, 'deepseek-memory-operations-empty-');
  const result = assertJsonResult(readProjectSnapshot({ cwd: root }));

  assert.deepEqual(result, {
    ok: true,
    initialized: false,
    cwd: path.resolve(root),
    projectRoot: null,
  });
  assert.equal(fs.existsSync(path.join(root, '.deepseek-memory')), false);

  const failed = assertJsonResult(search({ cwd: root, query: 'anything' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'PROJECT_MEMORY_NOT_INITIALIZED');
  assert.match(failed.error.message, /project\.json marker/);
});

test('bootstrap, claim, checkpoint, search, and snapshot share explicit cwd state', (t) => {
  const root = temporaryDirectory(t, 'deepseek-memory-operations-flow-');
  const nested = path.join(root, 'src', 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const boot = assertJsonResult(bootstrapTask(root));
  assert.equal(boot.ok, true);
  assert.equal(boot.task.taskVersion, 1);
  assert.equal(boot.task.contractVersion, 1);

  const lease = assertJsonResult(claim({
    cwd: nested,
    taskId: 'task-1',
    expectedRevision: 1,
    owner: 'host-session-a',
    leaseSeconds: 600,
  }));
  assert.equal(lease.ok, true);
  assert.equal(lease.leaseToken.fence, 1);

  const committed = assertJsonResult(checkpoint({
    cwd: nested,
    taskId: 'task-1',
    expectedRevision: 1,
    expectedContractRevision: 1,
    owner: 'host-session-a',
    leaseToken: lease.leaseToken.fence,
    patch: { state: 'active', data: { nextAction: 'inspect snapshot' } },
    evidence: [{ kind: 'test', payload: { command: 'node --test', result: 'passed' } }],
    summary: 'Shared operation checkpoint committed',
    nextAction: 'inspect snapshot',
    pendingOperations: [],
    idempotencyKey: 'checkpoint-1',
  }));
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.taskVersion, 2);
  assert.equal(committed.contractVersion, 1);

  const replay = checkpoint({
    cwd: nested,
    taskId: 'task-1',
    expectedRevision: 1,
    expectedContractRevision: 1,
    owner: 'host-session-a',
    leaseToken: lease.leaseToken.fence,
    idempotencyKey: 'checkpoint-1',
  });
  assert.deepEqual(replay, committed);

  const found = assertJsonResult(search({
    cwd: nested,
    taskId: 'task-1',
    query: 'node --test',
  }));
  assert.equal(found.ok, true);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].taskId, 'task-1');

  const snapshot = assertJsonResult(readProjectSnapshot({ cwd: nested, taskId: 'task-1' }));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.projectRoot, path.resolve(root));
  assert.equal(snapshot.task.taskVersion, 2);
  assert.equal(snapshot.task.contractVersion, 1);
  assert.equal(snapshot.checkpoint.payload.summary, 'Shared operation checkpoint committed');
  assert.equal(snapshot.evidence.length, 1);
  assert.deepEqual(snapshot.tasks.map((task) => task.id), ['task-1']);
});

test('task CAS and fencing conflicts are returned with structured details', (t) => {
  const root = temporaryDirectory(t, 'deepseek-memory-operations-conflict-');
  assert.equal(bootstrapTask(root).ok, true);

  const staleClaim = assertJsonResult(claim({
    cwd: root,
    expectedRevision: 2,
    owner: 'host-session-a',
  }));
  assert.equal(staleClaim.ok, false);
  assert.deepEqual(
    { code: staleClaim.error.code, expected: staleClaim.error.expectedVersion, actual: staleClaim.error.actualVersion },
    { code: 'TASK_REVISION_CONFLICT', expected: 2, actual: 1 },
  );

  const first = claim({ cwd: root, expectedRevision: 1, owner: 'host-session-a', leaseSeconds: 600 });
  const second = claim({ cwd: root, expectedRevision: 1, owner: 'host-session-a', leaseSeconds: 600 });
  assert.equal(second.leaseToken.fence, first.leaseToken.fence + 1);

  const staleFence = assertJsonResult(checkpoint({
    cwd: root,
    expectedRevision: 1,
    expectedContractRevision: 1,
    owner: 'host-session-a',
    leaseToken: first.leaseToken.fence,
    idempotencyKey: 'stale-fence-checkpoint',
  }));
  assert.equal(staleFence.ok, false);
  assert.equal(staleFence.error.code, 'LEASE_CONFLICT');
  assert.equal(staleFence.error.actualFence, second.leaseToken.fence);

  const committed = checkpoint({
    cwd: root,
    expectedRevision: 1,
    expectedContractRevision: 1,
    owner: 'host-session-a',
    leaseToken: second.leaseToken.fence,
    idempotencyKey: 'valid-checkpoint',
  });
  assert.equal(committed.ok, true);

  const staleTask = assertJsonResult(checkpoint({
    cwd: root,
    expectedRevision: 1,
    expectedContractRevision: 1,
    owner: 'host-session-a',
    leaseToken: second.leaseToken.fence,
    idempotencyKey: 'stale-task-checkpoint',
  }));
  assert.equal(staleTask.ok, false);
  assert.equal(staleTask.error.code, 'TASK_REVISION_CONFLICT');
  assert.equal(staleTask.error.actualVersion, 2);
});

test('contract proposals remain candidates and preserve contract CAS', (t) => {
  const root = temporaryDirectory(t, 'deepseek-memory-operations-contract-');
  assert.equal(bootstrapTask(root).ok, true);

  const proposed = assertJsonResult(proposeContractChange({
    cwd: root,
    taskId: 'task-1',
    expectedContractRevision: 1,
    diff: { objective: 'Candidate objective' },
    sourceRef: 'test:user-message-2',
    owner: 'host-session-a',
    idempotencyKey: 'proposal-1',
  }));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.status, 'candidate');
  assert.equal(proposed.event.type, 'contract.change-proposed');

  const snapshot = readProjectSnapshot({ cwd: root, taskId: 'task-1' });
  assert.equal(snapshot.task.contractVersion, 1);
  assert.equal(snapshot.task.contract.objective, 'Share memory operations');

  const stale = assertJsonResult(proposeContractChange({
    cwd: root,
    taskId: 'task-1',
    expectedContractRevision: 2,
    diff: { objective: 'Stale candidate' },
    sourceRef: 'test:user-message-3',
    idempotencyKey: 'proposal-stale',
  }));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'CONTRACT_REVISION_CONFLICT');
  assert.equal(stale.error.expectedVersion, 2);
  assert.equal(stale.error.actualVersion, 1);
});

test('invalid inputs return JSON error codes instead of throwing', () => {
  for (const result of [
    readProjectSnapshot(),
    bootstrap({ cwd: '.', taskId: '', objective: 'x' }),
    claim({ cwd: '.', expectedRevision: -1, owner: 'host' }),
    checkpoint({ cwd: '.', expectedRevision: 1, expectedContractRevision: 1, owner: 'host', leaseToken: 0 }),
    proposeContractChange({ cwd: '.', expectedContractRevision: 1, diff: [], sourceRef: 'test' }),
  ]) {
    assertJsonResult(result);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(typeof result.error.message, 'string');
    assert.notEqual(result.error.message.length, 0);
  }
});
