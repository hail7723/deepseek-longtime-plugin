import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { openProjectStore } from './store.js';

const MARKER_DIRECTORY = '.deepseek-memory';
const MARKER_FILE = 'project.json';
const DEFAULT_EVENT_LIMIT = 100;

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
    'actualFence',
    'owner',
    'expiresAt',
    'markerPath',
  ]) {
    const value = error?.[key];
    if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = value;
    }
  }
  return { ok: false, error: result };
}

function execute(operation) {
  try {
    return operation();
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
    const binding = store.touchSessionBinding({ sessionId, projectId, workspaceId });
    if (binding) return { task: store.getTask(projectId, binding.taskId), source: binding.bindingSource, selectionRequired: false };
  }
  const candidates = openTasks(store, projectId);
  if (candidates.length === 1) {
    const task = candidates[0];
    if (sessionId) store.bindSession({ sessionId, projectId, taskId: task.id, workspaceId, source: 'sole-open-task' });
    return { task, source: 'sole-open-task', selectionRequired: false };
  }
  return { task: null, source: null, selectionRequired: candidates.length > 1, candidates };
}

function readProjectSnapshot({ cwd, taskId, sessionId, sinceEventSeq = 0, eventLimit = DEFAULT_EVENT_LIMIT } = {}) {
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
      return {
        ok: true,
        initialized: true,
        cwd: currentDirectory,
        projectRoot,
        project: store.getProject(projectId),
        tasks,
        task,
        selectionRequired: resolution.selectionRequired,
        taskCandidates: resolution.candidates ?? [],
        bindingSource: resolution.source,
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

// The public model API intentionally does not accept revisions or fencing
// tokens.  It acquires a fresh lease, reads the current versions, and lets the
// store's single transaction reject a concurrent semantic overwrite.
function commit({ cwd, sessionId, progress = '', nextAction = null, blockers = [], acceptanceUpdates = [], evidenceRefs = [], state, idempotencyKey } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd); requireString(sessionId, 'sessionId');
    if (!Array.isArray(blockers) || !Array.isArray(acceptanceUpdates) || !Array.isArray(evidenceRefs)) throw new TypeError('commit lists must be arrays');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, store => {
      const projectId = store.project.id; const facts = workspaceFacts(projectRoot, currentDirectory);
      const resolution = resolveTask(store, projectId, { sessionId, workspaceId: facts.workspaceId });
      if (!resolution.task) {
        const error = new Error(resolution.selectionRequired ? 'Choose a task before committing' : 'No open task is available');
        error.code = resolution.selectionRequired ? 'TASK_SELECTION_REQUIRED' : 'NOT_FOUND';
        error.candidates = resolution.candidates?.map(item => ({ id: item.id, title: item.title, state: item.state }));
        throw error;
      }
      const task = resolution.task;
      const lease = store.acquireLease({ projectId, taskId: task.id, owner: `project-memory:${sessionId}`, ttlMs: 300000 });
      const latest = store.getTask(projectId, task.id);
      const data = { ...latest.data, blockers, acceptanceUpdates, nextAction };
      const result = store.commitCheckpoint({
        projectId, taskId: latest.id, expectedTaskVersion: latest.taskVersion, expectedContractVersion: latest.contractVersion,
        lease, taskPatch: { ...(state ? { state } : {}), data },
        evidence: evidenceRefs.map(ref => ({ kind: 'reference', payload: { ref } })),
        checkpointPayload: { summary: String(progress), nextAction, blockers, acceptanceUpdates, evidenceRefs, sessionId },
        branch: facts.branch, workspace: facts.workspaceId, idempotencyKey: idempotencyKey ?? `commit:${sessionId}:${latest.id}:${latest.taskVersion}`,
      });
      return { ok: true, projectId, taskId: latest.id, ...result };
    });
  });
}

function search({ cwd, taskId, query = '', limit = 20 } = {}) {
  return execute(() => {
    const currentDirectory = resolvedCwd(cwd);
    if (typeof query !== 'string') throw new TypeError('query must be a string');
    requirePositiveInteger(limit, 'limit');
    const projectRoot = requireProjectRoot(currentDirectory);
    return withStore(projectRoot, (store) => {
      const projectId = store.project.id;
      if (taskId !== undefined && taskId !== null) selectTask(store, projectId, taskId);
      const facts = workspaceFacts(projectRoot, currentDirectory);
      return {
        ok: true,
        projectId,
        results: store.search({
          projectId,
          ...(taskId === undefined || taskId === null ? {} : { taskId }),
          query,
          branch: facts.branch,
          workspace: facts.workspaceId,
          limit,
        }),
      };
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
  search,
  proposeContractChange,
  startTask,
  useTask,
  listTasks,
  setTaskState,
  decideContractChange,
};
