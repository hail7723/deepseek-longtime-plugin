import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { openProjectStore } from './store.js';
import { publicJson } from './public-json.js';
import { validateAcceptanceUpdates, mergeAcceptanceUpdates } from './acceptance.js';
import { parseSearchQuery } from './search.js';

const MARKER_DIRECTORY = '.deepseek-memory';
const MARKER_FILE = 'project.json';
const DEFAULT_EVENT_LIMIT = 100;
// A committing session holds a short, implicitly renewable lease: writes are
// single transactions, and a crashed holder must not block a resumed session
// for the old five minutes.
const COMMIT_LEASE_TTL_MS = 60000;
// When the foreign lease is about to expire anyway, one backed-off retry is
// cheaper than failing the write and queueing it.
const RETRY_WINDOW_SECONDS = 2;

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolvedCwd(cwd) {
  return path.resolve(requireString(cwd, 'cwd'));
}

function findProjectRoot(cwd) {
  let current = resolvedCwd(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, MARKER_DIRECTORY, MARKER_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitHead(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  if (!fs.existsSync(dotGit)) return { branch: 'no-git', codeRevision: null };
  let gitDirectory = dotGit;
  if (fs.statSync(dotGit).isFile()) {
    const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return { branch: 'unknown', codeRevision: null };
    gitDirectory = path.resolve(projectRoot, match[1].trim());
  }
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) {
    return { branch: `detached:${head.slice(0, 12)}`, codeRevision: head };
  }
  const ref = head.slice(5);
  const looseRef = path.join(gitDirectory, ...ref.split('/'));
  let codeRevision = fs.existsSync(looseRef) ? fs.readFileSync(looseRef, 'utf8').trim() : null;
  if (codeRevision === null) {
    const packedRefs = path.join(gitDirectory, 'packed-refs');
    if (fs.existsSync(packedRefs)) {
      const line = fs.readFileSync(packedRefs, 'utf8')
        .split(/\r?\n/)
        .find((entry) => entry.endsWith(` ${ref}`));
      codeRevision = line?.split(' ')[0] ?? null;
    }
  }
  return { branch: ref.replace(/^refs\/heads\//, ''), codeRevision };
}

function workspaceFacts(projectRoot, cwd) {
  let git;
  try {
    git = readGitHead(projectRoot);
  } catch {
    git = { branch: 'unknown', codeRevision: null };
  }
  // A workspace is the checked-out project, not the directory from which an
  // agent happened to start.  realpath also folds symlink aliases on Windows.
  let canonical;
  try { canonical = fs.realpathSync.native(projectRoot); } catch { canonical = path.resolve(projectRoot); }
  canonical = canonical.toLowerCase();
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return { workspaceId: `local:${digest}`, ...git };
}

function operationError(error) {
  const result = {
    code: typeof error?.code === 'string'
      ? error.code
      : error instanceof TypeError
        ? 'INVALID_ARGUMENT'
        : 'PROJECT_MEMORY_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
  for (const key of [
    'projectId',
    'taskId',
    'expectedVersion',
    'actualVersion',
    'versionKind',
    'markerPath',
  ]) {
    const value = error?.[key];
    if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = value;
    }
  }
  // Readable lease information is copied for UI rendering; owner/fence stay in
  // diagnostics only.
  for (const key of ['heldBy', 'retryAfterSeconds', 'canRetryAt']) {
    const value = error?.[key];
    if (value !== undefined && value !== null) result[key] = value;
  }
  if (error?.requested !== undefined) result.requested = error.requested;
  if (result.code === 'LEASE_CONFLICT') result.message = 'Task lease is unavailable or the write token is stale; retry after checking lease status';
  return publicJson({ ok: false, error: result });
}

function execute(operation) {
  try {
    return operation();
  } catch (error) {
    return operationError(error);
  }
}

// The backed-off lease retry makes the operation async; errors must still
// resolve to the readable `{ ok: false, error }` shape.
async function executeAsync(operation) {
  try {
    return await operation();
  } catch (error) {
    return operationError(error);
  }
}

function withStore(projectRoot, operation) {
  const store = openProjectStore(projectRoot);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

// Backed-off retry sleeps with the store open; the connection is closed only
// after the awaited operation settles.
async function withStoreAsync(projectRoot, operation) {
  const store = openProjectStore(projectRoot);
  try {
    return await operation(store);
  } finally {
    store.close();
  }
}

function requireProjectRoot(cwd) {
  const root = findProjectRoot(cwd);
  if (root === null) {
    const error = new Error(`No ${MARKER_DIRECTORY}/${MARKER_FILE} marker was found from ${path.resolve(cwd)}`);
    error.code = 'PROJECT_MEMORY_NOT_INITIALIZED';
    throw error;
  }
  return root;
}

function openTasks(store, projectId) {
  return store.listTasks(projectId).filter(task => !['completed', 'archived'].includes(task.state));
}

function deferredCountsOf(items) {
  const counts = { queued: 0, flushed: 0, conflict: 0, discarded: 0 };
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  }
  return counts;
}

function selectTask(store, projectId, taskId) {
  if (taskId !== undefined && taskId !== null) {
    requireString(taskId, 'taskId');
    const task = store.getTask(projectId, taskId);
    if (task === null) {
      const error = new Error(`Task ${taskId} was not found in the project`);
      error.code = 'NOT_FOUND';
      error.projectId = projectId;
      error.taskId = taskId;
      throw error;
    }
    return task;
  }
  const tasks = openTasks(store, projectId);
  return tasks.length === 1 ? tasks[0] : null;
}

function resolveTask(store, projectId, { taskId, sessionId, workspaceId }) {
  if (taskId !== undefined && taskId !== null) return { task: selectTask(store, projectId, taskId), source: 'explicit', selectionRequired: false };
  if (sessionId) {
    const binding = store.getSessionBinding({ sessionId, projectId, workspaceId });
    if (binding) {
      const bound = store.getTask(projectId, binding.taskId);
      if (bound && !['completed', 'archived'].includes(bound.state)) {
        store.touchSessionBinding({ sessionId, projectId, workspaceId });
        return { task: bound, source: binding.bindingSource, selectionRequired: false };
      }
      // The bound task reached a terminal state.  This session must choose
      // again explicitly — it never silently adopts the remaining open task.
      const stale = openTasks(store, projectId);
      return { task: null, source: 'invalidated-binding', selectionRequired: stale.length > 0, candidates: stale };
    }
  }
  const candidates = openTasks(store, projectId);
  if (candidates.length === 1) {
    const task = candidates[0];
    if (sessionId) store.bindSession({ sessionId, projectId, taskId: task.id, workspaceId, source: 'sole-open-task' });
    return { task, source: 'sole-open-task', selectionRequired: false };
  }
  return { task: null, source: null, selectionRequired: candidates.length > 1, candidates };
}

function readProjectSnapshot({ cwd, taskId, sessionId, owner, sinceEventSeq = 0, eventLimit = DEFAULT_EVENT_LIMIT } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    if (!Number.isSafeInteger(sinceEventSeq) || sinceEventSeq < 0) {
      throw new TypeError('sinceEventSeq must be a non-negative safe integer');
    }
    requirePositiveInteger(eventLimit, 'eventLimit');
    const projectRoot = findProjectRoot(currentDirectory);
    if (projectRoot === null) {
      return { ok: true, initialized: false, cwd: currentDirectory, projectRoot: null };
    }
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const facts = workspaceFacts(projectRoot, currentDirectory);
      const resolution = resolveTask(store, projectId, { taskId, sessionId, workspaceId: facts.workspaceId });
      const task = resolution.task;
      const tasks = store.listTasks(projectId);
      // The panel renders the save state from the viewer's perspective; the
      // agent flow passes its own session-derived owner.
      const viewer = owner ?? (sessionId ? `project-memory:${sessionId}` : null);
      const deferredItems = task ? store.listDeferredCommits({ projectId, taskId: task.id }) : [];
      const deferredCounts = task === null ? null : deferredCountsOf(deferredItems);
      const leaseStatus = task === null || viewer === null ? null : store.readLeaseStatus({ projectId, taskId: task.id, owner: viewer, now: Date.now() });
      return {
        ok: true,
        initialized: true,
        cwd: currentDirectory,
        projectRoot,
        project: store.getProject(projectId),
        tasks,
        task,
        acceptanceUpdates: task === null ? null : store.readAcceptanceUpdates({ projectId, taskId: task.id, branch: facts.branch, workspace: facts.workspaceId }),
        selectionRequired: resolution.selectionRequired,
        taskCandidates: resolution.candidates ?? [],
        bindingSource: resolution.source,
        leaseStatus: leaseStatus === null ? null : {
          heldBy: leaseStatus.heldByCurrentSession ? 'current-session' : leaseStatus.heldByOtherSession ? 'other-session' : 'none',
          remainingSeconds: leaseStatus.remainingSeconds,
          canRetryAt: leaseStatus.canRetryAt,
          retryAfterSeconds: leaseStatus.retryAfterSeconds,
          diagnostics: leaseStatus.diagnostics,
        },
        deferredCounts,
        deferredItems: deferredItems.map(({ payload, ...item }) => ({ ...item, summary: payload.progress ?? '' })),
        checkpoint: task === null ? null : store.latestCheckpoint(projectId, {
          taskId: task.id,
          branch: facts.branch,
          workspace: facts.workspaceId,
        }),
        evidence: task === null ? [] : store.listEvidence({
          projectId,
          taskId: task.id,
          branch: facts.branch,
          workspace: facts.workspaceId,
        }),
        recentEvents: store.listEvents(projectId, { afterSeq: sinceEventSeq, limit: eventLimit }),
        contractCandidates: task ? store.listContractCandidates({ projectId, taskId: task.id }) : [],
        toolOperations: task ? store.listToolOperations({ taskId: task.id }) : [],
        ...facts,
      };
    });
  });
}

function bootstrap({
  cwd,
  taskId,
  objective,
  acceptanceCriteria = [],
  constraints = [],
  nextAction = null,
  sourceRef = null,
  idempotencyKey,
  sessionId,
} = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    requireString(taskId, 'taskId');
    requireString(objective, 'objective');
    if (!Array.isArray(acceptanceCriteria)) throw new TypeError('acceptanceCriteria must be an array');
    if (!Array.isArray(constraints)) throw new TypeError('constraints must be an array');
    const projectRoot = findProjectRoot(currentDirectory) ?? currentDirectory;
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const facts = workspaceFacts(projectRoot, currentDirectory);
      let task = store.getTask(projectId, taskId);
      if (task === null) {
        task = store.createTask({
          projectId,
          id: taskId,
          title: objective,
          state: 'active',
          data: { nextAction, blockers: [] },
          contract: {
            objective,
            acceptanceCriteria,
            constraints,
            confirmed: true,
            sourceRef,
          },
          branch: facts.branch,
          workspace: facts.workspaceId,
          idempotencyKey,
        }).task;
      }
      if (sessionId) store.bindSession({ sessionId, projectId, taskId: task.id, workspaceId: facts.workspaceId, source: 'explicit' });
      return {
        ok: true,
        initialized: true,
        projectId,
        projectRoot,
        task,
        ...facts,
      };
    });
  });
}

function startTask({ cwd, sessionId, objective, acceptanceCriteria = [], constraints = [], nextAction = null, sourceRef = null, idempotencyKey, taskId = randomUUID() } = {}) {
  return bootstrap({ cwd, sessionId, taskId, objective, acceptanceCriteria, constraints, nextAction, sourceRef, idempotencyKey });
}

function useTask({ cwd, sessionId, taskId } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(sessionId, 'sessionId'); requireString(taskId, 'taskId');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const facts = workspaceFacts(projectRoot, currentDirectory); const projectId = store.project.id;
      const binding = store.bindSession({ sessionId, projectId, taskId, workspaceId: facts.workspaceId, source: 'explicit' });
      return { ok: true, projectId, task: store.getTask(projectId, taskId), binding, ...facts };
    });
  });
}

function listTasks({ cwd } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => ({ ok: true, projectId: store.project.id, tasks: store.listTasks(store.project.id) }));
  });
}

function setTaskState({ cwd, taskId, state, owner = 'project-memory-admin', expectedRevision } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(taskId, 'taskId'); requireString(state, 'state');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => {
      const projectId = store.project.id; const task = selectTask(store, projectId, taskId);
      const revision = expectedRevision ?? task.taskVersion; requireNonNegativeInteger(revision, 'expectedRevision');
      const lease = store.acquireLease({ projectId, taskId, owner, ttlMs: 300000 });
      const result = store.updateTask({ projectId, taskId, expectedVersion: revision, patch: { state }, lease, idempotencyKey: `state:${taskId}:${revision}:${state}` });
      if (['paused', 'completed', 'archived'].includes(state)) store.releaseLease({ projectId, taskId, owner, fence: lease.fence });
      return { ok: true, projectId, ...result };
    });
  });
}

function claim({ cwd, taskId, expectedRevision, owner, leaseSeconds = 300 } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    requireNonNegativeInteger(expectedRevision, 'expectedRevision');
    requireString(owner, 'owner');
    requirePositiveInteger(leaseSeconds, 'leaseSeconds');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const task = selectTask(store, projectId, taskId);
      if (task === null) {
        const error = new Error('No task has been bootstrapped in the project');
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (task.taskVersion !== expectedRevision) {
        const error = new Error('Task version changed before the lease claim');
        error.code = 'TASK_REVISION_CONFLICT';
        error.expectedVersion = expectedRevision;
        error.actualVersion = task.taskVersion;
        error.projectId = projectId;
        error.taskId = task.id;
        throw error;
      }
      const leaseToken = store.claimTask({
        projectId,
        taskId: task.id,
        owner,
        ttlMs: leaseSeconds * 1000,
      });
      return {
        ok: true,
        projectId,
        taskId: task.id,
        leaseToken,
        taskRevision: task.taskVersion,
        contractRevision: task.contractVersion,
      };
    });
  });
}

function checkpoint({
  cwd,
  taskId,
  expectedRevision,
  expectedContractRevision,
  owner,
  leaseToken,
  patch = {},
  evidence = [],
  summary = '',
  nextAction = null,
  pendingOperations = [],
  idempotencyKey,
} = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    requireNonNegativeInteger(expectedRevision, 'expectedRevision');
    requireNonNegativeInteger(expectedContractRevision, 'expectedContractRevision');
    requireString(owner, 'owner');
    requirePositiveInteger(leaseToken, 'leaseToken');
    if (!Array.isArray(evidence)) throw new TypeError('evidence must be an array');
    if (!Array.isArray(pendingOperations)) throw new TypeError('pendingOperations must be an array');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const task = selectTask(store, projectId, taskId);
      if (task === null) {
        const error = new Error('No task has been bootstrapped in the project');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const facts = workspaceFacts(projectRoot, currentDirectory);
      const result = store.commitCheckpoint({
        projectId,
        taskId: task.id,
        expectedTaskVersion: expectedRevision,
        expectedContractVersion: expectedContractRevision,
        lease: { owner, fence: leaseToken },
        taskPatch: patch,
        evidence: evidence.map((item) => ({
          ...item,
          kind: item?.kind ?? 'verification',
          payload: item?.payload ?? { ...item, codeRevision: facts.codeRevision },
        })),
        checkpointPayload: {
          summary,
          nextAction,
          pendingOperations,
          owner,
          codeRevision: facts.codeRevision,
        },
        branch: facts.branch,
        workspace: facts.workspaceId,
        idempotencyKey,
      });
      return { ok: true, projectId, taskId: task.id, ...result };
    });
  });
}

function leaseError(task, requested, status) {
  const error = new Error('Task lease is held by another session');
  error.code = 'LEASE_CONFLICT';
  error.projectId = task.projectId;
  error.taskId = task.id;
  error.heldBy = 'other-session';
  error.retryAfterSeconds = status.retryAfterSeconds;
  error.canRetryAt = status.canRetryAt;
  error.requested = requested;
  return error;
}

function replayDeferredItem(store, { projectId, taskId, item, owner, lease, facts, sessionId }) {
  facts = { ...facts, branch: item.branch ?? facts.branch, workspaceId: item.workspace ?? facts.workspaceId };
  const latest = store.getTask(projectId, taskId);
  validateAcceptanceUpdates(item.payload.acceptanceUpdates);
  if (item.baseContractVersion !== latest.contractVersion && (item.payload.acceptanceUpdates?.length)) {
    const error = new Error('Deferred acceptance observation is based on an older contract revision');
    error.reason = `contract revision moved from ${item.baseContractVersion} to ${latest.contractVersion} while queued`;
    throw error;
  }
  return store.commitCheckpoint({
    projectId,
    taskId,
    expectedTaskVersion: latest.taskVersion,
    expectedContractVersion: latest.contractVersion,
    lease,
    taskPatch: item.payload.acceptanceUpdates?.length ? { data: { ...latest.data,
      acceptanceUpdates: mergeAcceptanceUpdates(store.readAcceptanceUpdates({ projectId, taskId, branch: facts.branch, workspace: facts.workspaceId }), item.payload.acceptanceUpdates),
    } } : {},
    evidence: (item.payload.evidenceRefs ?? []).map(ref => ({ kind: 'reference', payload: { ref, deferredFrom: item.sessionId } })),
    checkpointPayload: {
      summary: String(item.payload.progress ?? ''),
      nextAction: null,
      blockers: [],
      ...(item.payload.acceptanceUpdates === undefined ? {} : { acceptanceUpdates: item.payload.acceptanceUpdates }),
      evidenceRefs: item.payload.evidenceRefs ?? [],
      sessionId: item.sessionId,
      deferredFlush: true,
      deferredItemId: item.id,
      ...sessionId === undefined ? {} : { flushedBy: sessionId },
    },
    branch: facts.branch,
    workspace: facts.workspaceId,
    idempotencyKey: `deferred:${item.id}`,
  });
}

// The public model API intentionally does not accept revisions or fencing
// tokens.  Strict fields (state, next action, blockers) are rejected readably
// while another session holds the lease; provably independent appends defer
// into a durable queue that the next lease holder flushes at most once.
function commit(options = {}) {
  const { cwd, sessionId, progress = '', nextAction = null, blockers = [], acceptanceUpdates, evidenceRefs = [], state, idempotencyKey } = options;
  return executeAsync(async () => {
    const currentDirectory = resolvedCwd(cwd); requireString(sessionId, 'sessionId');
    if (!Array.isArray(blockers) || !Array.isArray(evidenceRefs)) throw new TypeError('commit lists must be arrays');
    validateAcceptanceUpdates(acceptanceUpdates);
    const projectRoot = requireProjectRoot(currentDirectory);
    const owner = `project-memory:${sessionId}`;
    return withStoreAsync(projectRoot, async store => {
      const projectId = store.project.id; const facts = workspaceFacts(projectRoot, currentDirectory);
      const resolution = resolveTask(store, projectId, { sessionId, workspaceId: facts.workspaceId });
      if (!resolution.task) {
        const error = new Error(resolution.selectionRequired ? 'Choose a task before committing' : 'No open task is available');
        error.code = resolution.selectionRequired ? 'TASK_SELECTION_REQUIRED' : 'NOT_FOUND';
        error.candidates = resolution.candidates?.map(item => ({ id: item.id, title: item.title, state: item.state }));
        throw error;
      }
      const task = resolution.task;
      const requested = Object.fromEntries(['progress', 'nextAction', 'blockers', 'acceptanceUpdates', 'evidenceRefs', 'state']
        .filter(key => options[key] !== undefined)
        .map(key => [{ nextAction: 'next_action', acceptanceUpdates: 'acceptance_updates', evidenceRefs: 'evidence_refs' }[key] ?? key, options[key]]));
      const hasStrictFields = state !== undefined || nextAction !== null || blockers.length > 0;

      const attempt = () => {
        const lease = store.acquireLease({ projectId, taskId: task.id, owner, ttlMs: COMMIT_LEASE_TTL_MS });
        const latest = store.getTask(projectId, task.id);
        const data = { ...latest.data, blockers, nextAction,
          ...(acceptanceUpdates?.length ? { acceptanceUpdates: mergeAcceptanceUpdates(
            store.readAcceptanceUpdates({ projectId, taskId: task.id, branch: facts.branch, workspace: facts.workspaceId }), acceptanceUpdates) } : {}),
        };
        const result = store.commitCheckpoint({
          projectId, taskId: latest.id, expectedTaskVersion: latest.taskVersion, expectedContractVersion: latest.contractVersion,
          lease, taskPatch: { ...(state ? { state } : {}), data },
          evidence: evidenceRefs.map(ref => ({ kind: 'reference', payload: { ref } })),
          checkpointPayload: { summary: String(progress), nextAction, blockers,
            ...(acceptanceUpdates === undefined ? {} : { acceptanceUpdates }), evidenceRefs, sessionId },
          branch: facts.branch, workspace: facts.workspaceId, idempotencyKey: idempotencyKey ?? `commit:${sessionId}:${latest.id}:${latest.taskVersion}`,
        });
        return { result, lease };
      };

      let attemptResult;
      try {
        attemptResult = attempt();
      } catch (error) {
        const retryable = error?.code === 'LEASE_CONFLICT' && error.expiresAt !== undefined;
        if (!retryable) throw error;
        const status = store.readLeaseStatus({ projectId, taskId: task.id, owner, now: Date.now() });
        // One backed-off retry when the foreign lease is about to expire.
        if (status.heldByOtherSession && status.retryAfterSeconds <= RETRY_WINDOW_SECONDS) {
          await delay((status.retryAfterSeconds + 0.05) * 1000);
          try {
            attemptResult = attempt();
          } catch (retryError) {
            return handleLeaseConflict(retryError);
          }
        } else {
          return handleLeaseConflict(error);
        }
      }
      function handleLeaseConflict(error) {
        if (error?.code !== 'LEASE_CONFLICT') throw error;
        if (hasStrictFields) {
          throw leaseError(task, requested, store.readLeaseStatus({ projectId, taskId: task.id, owner, now: Date.now() }));
        }
        const existing = store.listDeferredCommits({ projectId, taskId: task.id, sessionId, statuses: ['queued'] })
          .find(item => item.branch === facts.branch && item.workspace === facts.workspaceId
            && item.payload.progress === String(progress)
            && JSON.stringify(item.payload.evidenceRefs ?? []) === JSON.stringify(evidenceRefs)
            && JSON.stringify(item.payload.acceptanceUpdates) === JSON.stringify(acceptanceUpdates));
        const item = existing ?? store.enqueueDeferredCommit({
          projectId, taskId: task.id, sessionId,
          baseTaskVersion: task.taskVersion, baseContractVersion: task.contractVersion,
          kind: 'append',
          branch: facts.branch, workspace: facts.workspaceId,
          payload: { progress: String(progress), ...(acceptanceUpdates === undefined ? {} : { acceptanceUpdates }), evidenceRefs },
        });
        return {
          ok: true, projectId, taskId: task.id, synced: false,
          deferred: true, deferredItemId: item.id,
          deferredCount: store.listDeferredCommits({ projectId, taskId: task.id, statuses: ['queued'] }).length,
        };
      }

      const { result, lease } = attemptResult;
      let flushed = 0;
      let needsReview = 0;
      // The queue belongs to the task; the new lease holder flushes it at most once.
      for (const item of store.listDeferredCommits({ projectId, taskId: task.id, statuses: ['queued'] })) {
        try {
          replayDeferredItem(store, { projectId, taskId: task.id, item, owner, lease, facts, sessionId });
          store.updateDeferredCommit({ id: item.id, status: 'flushed' });
          flushed += 1;
        } catch (replayError) {
          store.updateDeferredCommit({ id: item.id, status: 'conflict', reason: replayError.reason ?? replayError.message });
          needsReview += 1;
        }
      }
      return { ok: true, projectId, taskId: task.id, synced: true, ...result, ...(lease === undefined ? {} : { lease }), flushed, needsReview };
    });
  });
}

function leaseStatus({ cwd, taskId, sessionId, owner } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(sessionId, 'sessionId');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => {
      const projectId = store.project.id;
      const facts = workspaceFacts(projectRoot, currentDirectory);
      const resolution = resolveTask(store, projectId, { taskId, sessionId, workspaceId: facts.workspaceId });
      if (!resolution.task) {
        const error = new Error(resolution.selectionRequired ? 'Choose a task first' : 'No open task is available');
        error.code = resolution.selectionRequired ? 'TASK_SELECTION_REQUIRED' : 'NOT_FOUND';
        throw error;
      }
      const viewer = owner ?? `project-memory:${sessionId}`;
      const status = store.readLeaseStatus({ projectId, taskId: resolution.task.id, owner: viewer, now: Date.now() });
      return {
        ok: true,
        projectId,
        taskId: resolution.task.id,
        heldBy: status.heldByCurrentSession ? 'current-session' : status.heldByOtherSession ? 'other-session' : 'none',
        remainingSeconds: status.remainingSeconds,
        canRetryAt: status.canRetryAt,
        retryAfterSeconds: status.retryAfterSeconds,
        diagnostics: status.diagnostics,
      };
    });
  });
}

function listDeferredCommits({ cwd, taskId, sessionId } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => {
      const projectId = store.project.id;
      const resolution = resolveTask(store, projectId, { taskId, sessionId: sessionId ?? undefined, workspaceId: workspaceFacts(projectRoot, currentDirectory).workspaceId });
      const task = resolution.task;
      if (!task) {
        const error = new Error(resolution.selectionRequired ? 'Choose a task first' : 'No open task is available');
        error.code = resolution.selectionRequired ? 'TASK_SELECTION_REQUIRED' : 'NOT_FOUND';
        throw error;
      }
      return {
        ok: true,
        projectId,
        taskId: task.id,
        items: store.listDeferredCommits({ projectId, taskId: task.id, ...(sessionId === undefined ? {} : { sessionId }) })
          .map(({ payload, ...item }) => ({ ...item, summary: payload.progress ?? '', evidenceRefs: payload.evidenceRefs ?? [], acceptanceUpdates: payload.acceptanceUpdates ?? [] })),
      };
    });
  });
}

function discardDeferredCommit({ cwd, id, sessionId } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(id, 'id');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => {
      const projectId = store.project.id;
      const items = store.listDeferredCommits({ projectId });
      const item = items.find(entry => entry.id === id);
      if (!item) {
        const error = new Error(`Deferred commit ${id} was not found`);
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (sessionId !== undefined && item.sessionId !== sessionId) {
        const error = new Error('Only the session that queued a draft can discard it');
        error.code = 'DEFERRED_OWNER_CONFLICT';
        throw error;
      }
      const updated = store.updateDeferredCommit({ id, status: 'discarded', reason: 'discarded by user request' });
      return { ok: true, projectId, item: updated };
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function search({ cwd, sessionId, taskId, query, mode = 'any', scope = 'current', includeDeferred = true, limit = 20 } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    parseSearchQuery({ query, mode, scope, includeDeferred, limit });
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const facts = workspaceFacts(projectRoot, currentDirectory);
      let selectedTaskId = taskId;
      if (scope !== 'project') {
        const resolution = resolveTask(store, projectId, { taskId, sessionId, workspaceId: facts.workspaceId });
        if (!resolution.task) {
          const error = new Error('Select a task for current/task search, or explicitly request scope:project');
          error.code = 'TASK_SELECTION_REQUIRED'; throw error;
        }
        selectedTaskId = resolution.task.id;
      } else if (taskId !== undefined && taskId !== null) selectTask(store, projectId, taskId);
      return store.searchPage({ projectId, taskId: selectedTaskId,
        query, mode, scope, includeDeferred, limit,
        ...(scope === 'current' ? { branch: facts.branch, workspace: facts.workspaceId } : {}),
      });
    });
  });
}

function proposeContractChange({
  cwd,
  taskId,
  expectedContractRevision,
  diff,
  sourceRef,
  idempotencyKey,
  owner = null,
} = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    requireNonNegativeInteger(expectedContractRevision, 'expectedContractRevision');
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
      throw new TypeError('diff must be an object');
    }
    requireString(sourceRef, 'sourceRef');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      const task = selectTask(store, projectId, taskId);
      if (task === null) {
        const error = new Error('No task has been bootstrapped in the project');
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (task.contractVersion !== expectedContractRevision) {
        const error = new Error('Contract version changed before the proposal');
        error.code = 'CONTRACT_REVISION_CONFLICT';
        error.expectedVersion = expectedContractRevision;
        error.actualVersion = task.contractVersion;
        error.projectId = projectId;
        error.taskId = task.id;
        throw error;
      }
      const { candidate, event } = store.createContractCandidate({
        projectId, taskId: task.id, baseContractVersion: expectedContractRevision,
        diff, sourceRef, idempotencyKey,
      });
      return {
        ok: true,
        projectId,
        taskId: task.id,
        status: 'candidate',
        contractRevision: task.contractVersion,
        candidate,
        event,
      };
    });
  });
}

function decideContractChange({ cwd, candidateId, decision, decidedBy = 'user', idempotencyKey } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(candidateId, 'candidateId');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => ({ ok: true, projectId: store.project.id,
      ...store.decideContractCandidate({ projectId: store.project.id, candidateId, decision, decidedBy, idempotencyKey }) }));
  });
}

const operations = Object.freeze({
  readProjectSnapshot,
  bootstrap,
  claim,
  checkpoint,
  commit,
  leaseStatus,
  listDeferredCommits,
  discardDeferredCommit,
  search,
  proposeContractChange,
  startTask,
  useTask,
  listTasks,
  setTaskState,
  decideContractChange,
});

export {
  operations,
  readProjectSnapshot,
  bootstrap,
  claim,
  checkpoint,
  commit,
  leaseStatus,
  listDeferredCommits,
  discardDeferredCommit,
  search,
  proposeContractChange,
  startTask,
  useTask,
  listTasks,
  setTaskState,
  decideContractChange,
};
