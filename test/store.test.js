import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProjectMemoryStore,
  openProjectStore,
} from '../src/store.js';

function temporaryProject(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'deepseek-memory-store-'));
  const store = openProjectStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, projectId: store.project.id };
}

test('openProjectStore persists marker identity and enables WAL', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'deepseek-memory-marker-'));
  const first = openProjectStore(root);
  const firstId = first.project.id;
  assert.equal(first.journalMode(), 'wal');
  assert.equal(first.project.rootPath, path.resolve(root));
  const marker = JSON.parse(readFileSync(first.markerPath, 'utf8'));
  assert.equal(marker.project_id, firstId);
  assert.equal(marker.schema_version, 1);
  assert.equal('projectId' in marker, false);
  assert.equal(path.basename(first.databasePath), 'memory.sqlite');
  first.close();

  const second = openProjectStore(root);
  t.after(() => {
    second.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(second.project.id, firstId);
  assert.equal(second.project.markerId, firstId);
});

test('explicit marker boundary does not inherit identity from a parent .git', (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'deepseek-memory-boundary-'));
  const child = path.join(parent, 'packages', 'child');
  mkdirSync(path.join(parent, '.git'), { recursive: true });
  mkdirSync(child, { recursive: true });
  const parentStore = openProjectStore(parent);
  const childStore = openProjectStore(child);
  t.after(() => {
    parentStore.close();
    childStore.close();
    rmSync(parent, { recursive: true, force: true });
  });

  assert.notEqual(childStore.project.id, parentStore.project.id);
  assert.equal(childStore.project.rootPath, path.resolve(child));
  assert.equal(path.dirname(path.dirname(childStore.markerPath)), path.resolve(child));
});

test('project event sequence is monotonic and task/contract revisions are independent', (t) => {
  const { store, projectId } = temporaryProject(t);
  const created = store.createTask({
    projectId,
    id: 'task-1',
    title: 'Implement persistence',
    data: { priority: 1 },
    contract: { tests: ['unit'] },
  });
  assert.equal(created.event.seq, 1);
  assert.equal(created.task.taskVersion, 1);
  assert.equal(created.task.contractVersion, 1);

  const taskUpdate = store.updateTask({
    projectId,
    taskId: 'task-1',
    expectedVersion: 1,
    patch: { state: 'active' },
  });
  assert.equal(taskUpdate.event.seq, 2);
  assert.equal(taskUpdate.task.taskVersion, 2);
  assert.equal(taskUpdate.task.contractVersion, 1);

  const contractUpdate = store.proposeContractChange({
    projectId,
    taskId: 'task-1',
    expectedContractRevision: 1,
    contract: { tests: ['unit', 'integration'] },
  });
  assert.equal(contractUpdate.event.seq, 3);
  assert.equal(contractUpdate.task.taskVersion, 2);
  assert.equal(contractUpdate.task.contractVersion, 2);

  assert.throws(
    () => store.updateTask({
      projectId,
      taskId: 'task-1',
      expectedVersion: 1,
      patch: { state: 'done' },
    }),
    (error) => error.code === 'TASK_REVISION_CONFLICT' && error.actualVersion === 2,
  );
  assert.throws(
    () => store.proposeContractChange({
      projectId,
      taskId: 'task-1',
      expectedContractRevision: 1,
      contract: {},
    }),
    (error) => error.code === 'CONTRACT_REVISION_CONFLICT' && error.actualVersion === 2,
  );
  assert.deepEqual(store.listEvents(projectId).map((event) => event.seq), [1, 2, 3]);
});

test('idempotent writes return the original result without advancing event_seq', (t) => {
  const { store, projectId } = temporaryProject(t);
  const input = {
    projectId,
    id: 'task-idempotent',
    title: 'Only once',
    idempotencyKey: 'request-1',
  };
  const first = store.createTask(input);
  const replay = store.createTask({ ...input, title: 'Ignored on replay' });
  assert.deepEqual(replay, first);
  assert.equal(store.listTasks(projectId).length, 1);
  assert.equal(store.getProject(projectId).eventSeq, 1);

  assert.throws(
    () => store.appendEvent({
      projectId,
      type: 'wrong.operation',
      idempotencyKey: 'request-1',
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(store.getProject(projectId).eventSeq, 1);
});

test('appendEvent records tool boundaries without changing task revisions', (t) => {
  const { store, projectId } = temporaryProject(t);
  store.createTask({ projectId, id: 'tool-task' });
  const event = store.appendEvent({
    projectId,
    taskId: 'tool-task',
    sessionId: 'session-1',
    kind: 'tool.pending',
    payload: { tool: 'shell' },
    sourceRef: { callId: 'call-7' },
    idempotencyKey: 'tool-call-7-pending',
  });
  const replay = store.appendEvent({
    projectId,
    taskId: 'tool-task',
    sessionId: 'session-1',
    kind: 'tool.pending',
    payload: { ignored: true },
    sourceRef: { callId: 'call-7' },
    idempotencyKey: 'tool-call-7-pending',
  });

  assert.deepEqual(replay, event);
  assert.equal(event.seq, 2);
  assert.equal(event.sessionId, 'session-1');
  assert.deepEqual(event.sourceRef, { callId: 'call-7' });
  assert.equal(store.readTask({ projectId, taskId: 'tool-task' }).taskVersion, 1);
  assert.equal(store.getProject(projectId).eventSeq, 2);
});

test('lease reacquisition advances fence and rejects stale writers', (t) => {
  const { store, projectId } = temporaryProject(t);
  store.createTask({ projectId, id: 'leased-task' });
  const base = Date.now();
  const first = store.claimTask({
    projectId,
    taskId: 'leased-task',
    owner: 'worker-a',
    ttlMs: 10,
    now: base,
  });
  const second = store.claimTask({
    projectId,
    taskId: 'leased-task',
    owner: 'worker-b',
    ttlMs: 60000,
    now: base + 11,
  });
  assert.equal(first.fence, 1);
  assert.equal(second.fence, 2);

  assert.throws(
    () => store.updateTask({
      projectId,
      taskId: 'leased-task',
      expectedVersion: 1,
      patch: { state: 'active' },
      lease: first,
    }),
    (error) => error.code === 'LEASE_CONFLICT' && error.actualFence === 2,
  );

  const update = store.updateTask({
    projectId,
    taskId: 'leased-task',
    expectedVersion: 1,
    patch: { state: 'active' },
    lease: second,
  });
  assert.equal(update.task.state, 'active');
});

test('evidence is isolated by branch and workspace and searchable in scope', (t) => {
  const { store, projectId } = temporaryProject(t);
  store.createTask({ projectId, id: 'task-evidence' });
  store.addEvidence({
    projectId,
    taskId: 'task-evidence',
    id: 'evidence-main',
    kind: 'test',
    payload: { summary: 'alpha passed' },
    branch: 'main',
    workspace: 'workspace-a',
  });
  store.addEvidence({
    projectId,
    taskId: 'task-evidence',
    id: 'evidence-feature',
    kind: 'test',
    payload: { summary: 'alpha failed' },
    branch: 'feature',
    workspace: 'workspace-b',
  });

  assert.deepEqual(
    store.listEvidence({
      projectId,
      taskId: 'task-evidence',
      branch: 'main',
      workspace: 'workspace-a',
    }).map((item) => item.id),
    ['evidence-main'],
  );
  assert.deepEqual(
    store.search({ projectId, query: 'alpha', branch: 'feature', workspace: 'workspace-b' })
      .map((item) => item.id),
    ['evidence-feature'],
  );
  assert.throws(
    () => store.listEvidence({ projectId, taskId: 'task-evidence', branch: 'main' }),
    /workspace must be a non-empty string/,
  );
});

test('commitCheckpoint atomically validates both revisions and fences the snapshot', (t) => {
  const { store, projectId } = temporaryProject(t);
  store.createTask({
    projectId,
    id: 'task-commit',
    state: 'pending',
    contract: { command: 'node --test' },
  });
  const leaseA = store.claimTask({
    projectId,
    taskId: 'task-commit',
    owner: 'worker-a',
    ttlMs: 60000,
  });
  const committed = store.commitCheckpoint({
    projectId,
    taskId: 'task-commit',
    expectedTaskVersion: 1,
    expectedContractVersion: 1,
    lease: leaseA,
    taskPatch: { state: 'verified' },
    evidence: [
      { id: 'commit-evidence-1', kind: 'test', payload: { command: 'node --test' } },
      { id: 'commit-evidence-2', kind: 'result', payload: { passed: true } },
    ],
    checkpointPayload: { phase: 'verified' },
    branch: 'main',
    workspace: 'workspace-a',
    idempotencyKey: 'commit-a',
  });

  assert.equal(committed.taskVersion, 2);
  assert.equal(committed.contractVersion, 1);
  assert.equal(committed.coveredEventSeq, 4);
  assert.equal(committed.checkpoint.eventSeq, 5);
  assert.deepEqual(committed.checkpoint.payload, {
    phase: 'verified',
    taskVersion: 2,
    contractVersion: 1,
    coveredEventSeq: 4,
  });
  assert.deepEqual(committed.evidence.map((item) => item.eventSeq), [3, 4]);
  assert.equal(store.getProject(projectId).eventSeq, 5);

  const replay = store.commitCheckpoint({
    projectId,
    taskId: 'task-commit',
    expectedTaskVersion: 1,
    expectedContractVersion: 1,
    lease: leaseA,
    branch: 'main',
    workspace: 'workspace-a',
    idempotencyKey: 'commit-a',
  });
  assert.deepEqual(replay, committed);
  assert.equal(store.getProject(projectId).eventSeq, 5);

  assert.throws(
    () => store.commitCheckpoint({
      projectId,
      taskId: 'task-commit',
      expectedTaskVersion: 1,
      expectedContractVersion: 1,
      lease: leaseA,
      branch: 'main',
      workspace: 'workspace-a',
    }),
    (error) => error.code === 'TASK_REVISION_CONFLICT' && error.actualVersion === 2,
  );
  assert.throws(
    () => store.commitCheckpoint({
      projectId,
      taskId: 'task-commit',
      expectedTaskVersion: 2,
      expectedContractVersion: 2,
      lease: leaseA,
      branch: 'main',
      workspace: 'workspace-a',
    }),
    (error) => error.code === 'CONTRACT_REVISION_CONFLICT' && error.actualVersion === 1,
  );
  assert.equal(store.getProject(projectId).eventSeq, 5);

  const leaseB = store.claimTask({
    projectId,
    taskId: 'task-commit',
    owner: 'worker-a',
    ttlMs: 60000,
  });
  assert.equal(leaseB.fence, leaseA.fence + 1);
  assert.throws(
    () => store.commitCheckpoint({
      projectId,
      taskId: 'task-commit',
      expectedTaskVersion: 2,
      expectedContractVersion: 1,
      lease: leaseA,
      branch: 'main',
      workspace: 'workspace-a',
    }),
    (error) => error.code === 'LEASE_CONFLICT' && error.actualFence === leaseB.fence,
  );
  assert.equal(store.getProject(projectId).eventSeq, 6);

  const emptyCommit = store.commitCheckpoint({
    projectId,
    taskId: 'task-commit',
    expectedTaskVersion: 2,
    expectedContractVersion: 1,
    lease: leaseB,
    branch: 'main',
    workspace: 'workspace-a',
  });
  assert.equal(emptyCommit.taskVersion, 3);
  assert.equal(emptyCommit.coveredEventSeq, 6);
  assert.equal(emptyCommit.checkpoint.eventSeq, 7);
});

test('checkpoint and recovery package preserve replay order and scope', (t) => {
  const { store, projectId } = temporaryProject(t);
  store.createTask({ projectId, id: 'task-recovery', contract: { command: 'node --test' } });
  store.addEvidence({
    projectId,
    taskId: 'task-recovery',
    kind: 'output',
    payload: { text: 'ok' },
    branch: 'main',
    workspace: 'workspace-a',
  });
  const checkpoint = store.checkpoint({
    projectId,
    taskId: 'task-recovery',
    payload: { resumeFrom: 'verification' },
    branch: 'main',
    workspace: 'workspace-a',
  });
  assert.equal(store.latestCheckpoint(projectId, {
    taskId: 'task-recovery',
    branch: 'main',
    workspace: 'workspace-a',
  }).id, checkpoint.id);

  const recovery = store.renderRecoveryPackage({
    projectId,
    branch: 'main',
    workspace: 'workspace-a',
  });
  assert.equal(recovery.schemaVersion, 1);
  assert.equal(recovery.project.eventSeq, 3);
  assert.equal(recovery.tasks.length, 1);
  assert.deepEqual(recovery.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(recovery.evidence.length, 1);
  assert.equal(recovery.checkpoints.length, 1);
});

test('ProjectMemoryStore can bootstrap a project against an explicit database', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'deepseek-memory-explicit-'));
  const store = new ProjectMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.bootstrapProject({ projectId: 'project-explicit', rootPath: root });
  assert.equal(project.id, 'project-explicit');
  assert.equal(store.readTask({ projectId: project.id, taskId: 'missing' }), null);
});
