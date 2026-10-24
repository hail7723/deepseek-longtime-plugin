import assert from 'node:assert/strict';
import test from 'node:test';

import { presentSnapshot } from '../src/service.js';

test('presentSnapshot exposes the UI projection without losing canonical fields', () => {
  const snapshot = {
    ok: true,
    initialized: true,
    cwd: 'C:\\project',
    project: { id: 'project-1', eventSeq: 9 },
    task: {
      id: 'task-1',
      title: 'Task',
      state: 'active',
      taskVersion: 3,
      contractVersion: 2,
      data: { nextAction: 'run tests' },
      contract: {
        objective: 'Ship the panel',
        acceptanceCriteria: ['UI reads SQLite'],
        constraints: ['local only'],
      },
    },
    checkpoint: { payload: { pendingOperations: ['build'], nextAction: 'fallback' } },
    recentEvents: [
      { eventSeq: 8, type: 'task.updated', payload: {} },
      {
        seq: 9,
        taskId: 'task-1',
        type: 'contract.change-proposed',
        createdAt: '2026-10-24T00:00:00.000Z',
        payload: { status: 'candidate', proposal: { objective: 'Next' }, sourceRef: 'user:1' },
      },
    ],
  };

  const view = presentSnapshot(snapshot, { fence: 7 });
  assert.equal(view.projectId, 'project-1');
  assert.equal(view.eventSeq, 9);
  assert.equal(view.task.objective, 'Ship the panel');
  assert.deepEqual(view.task.acceptanceCriteria, ['UI reads SQLite']);
  assert.equal(view.task.nextAction, 'run tests');
  assert.equal(view.task.leaseToken, 7);
  assert.equal(view.contractRevision, 2);
  assert.deepEqual(view.pendingOperations, ['build']);
  assert.equal(view.contractCandidates.length, 1);
  assert.deepEqual(view.events, snapshot.recentEvents);
  assert.equal(JSON.stringify(view).includes('project-1'), true);
});

test('presentSnapshot preserves error and uninitialized results', () => {
  const error = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'cwd required' } };
  const empty = { ok: true, initialized: false, cwd: '', projectRoot: null };
  assert.equal(presentSnapshot(error), error);
  assert.equal(presentSnapshot(empty), empty);
});
