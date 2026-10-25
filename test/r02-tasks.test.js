import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commit, listTasks, readProjectSnapshot, setTaskState, startTask, useTask,
} from '../src/operations.js';

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('distinct sessions bind distinct tasks and never fall back by ordering', (t) => {
  const root = temporaryDirectory(t, 'dsh-r02-bindings-');
  const first = startTask({ cwd: root, sessionId: 'session-a', objective: 'First task', idempotencyKey: 'a' });
  const readme = startTask({ cwd: root, sessionId: 'session-b', objective: 'README task', idempotencyKey: 'b' });
  assert.equal(first.ok, true); assert.equal(readme.ok, true);

  const forA = readProjectSnapshot({ cwd: root, sessionId: 'session-a' });
  const forB = readProjectSnapshot({ cwd: root, sessionId: 'session-b' });
  assert.equal(forA.task.id, first.task.id);
  assert.equal(forB.task.id, readme.task.id);

  // A third session with no binding must be told to choose — never resolved
  // by array order, recency, or display_order.
  const forC = readProjectSnapshot({ cwd: root, sessionId: 'session-c' });
  assert.equal(forC.task, null);
  assert.equal(forC.selectionRequired, true);
  assert.equal(forC.taskCandidates.length, 2);
});

test('completing one task invalidates only its own binding and forces re-selection', async (t) => {
  const root = temporaryDirectory(t, 'dsh-r02-complete-');
  const first = startTask({ cwd: root, sessionId: 'session-a', objective: 'First task', idempotencyKey: 'a' });
  const readme = startTask({ cwd: root, sessionId: 'session-b', objective: 'README task', idempotencyKey: 'b' });

  const done = setTaskState({ cwd: root, taskId: readme.task.id, state: 'completed' });
  assert.equal(done.ok, true, JSON.stringify(done));

  // Session A's binding is untouched.
  const forA = readProjectSnapshot({ cwd: root, sessionId: 'session-a' });
  assert.equal(forA.task.id, first.task.id);

  // Session B's binding is invalidated; with another open task it must
  // re-select explicitly instead of silently adopting the remaining one.
  const forB = readProjectSnapshot({ cwd: root, sessionId: 'session-b' });
  assert.equal(forB.selectionRequired, true);
  assert.equal(forB.task, null);
  const commitB = await commit({ cwd: root, sessionId: 'session-b', progress: 'should not write' });
  assert.equal(commitB.ok, false);
  assert.equal(commitB.error.code, 'TASK_SELECTION_REQUIRED');

  // An explicit useTask re-establishes the binding.
  const rebind = useTask({ cwd: root, sessionId: 'session-b', taskId: first.task.id });
  assert.equal(rebind.ok, true);
  assert.equal(readProjectSnapshot({ cwd: root, sessionId: 'session-b' }).task.id, first.task.id);
});

test('archived bindings invalidate the same way', (t) => {
  const root = temporaryDirectory(t, 'dsh-r02-archive-');
  const solo = startTask({ cwd: root, sessionId: 'session-a', objective: 'Only task', idempotencyKey: 'a' });
  setTaskState({ cwd: root, taskId: solo.task.id, state: 'archived' });
  const forA = readProjectSnapshot({ cwd: root, sessionId: 'session-a' });
  assert.equal(forA.task, null);
  assert.equal(forA.selectionRequired, false, 'no open candidates remain');
});

test('listTasks is administrative only and ordered for display', (t) => {
  const root = temporaryDirectory(t, 'dsh-r02-list-');
  const first = startTask({ cwd: root, sessionId: 'session-a', objective: 'First', idempotencyKey: 'a' });
  startTask({ cwd: root, sessionId: 'session-a', objective: 'Second', idempotencyKey: 'b' });
  const listed = listTasks({ cwd: root });
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks.length, 2);
  assert.equal(listed.tasks[0].id, first.task.id, 'display_order keeps insertion order for listing');
  // The list itself never selects: an unbound session still must choose.
  assert.equal(readProjectSnapshot({ cwd: root, sessionId: 'session-z' }).selectionRequired, true);
});
