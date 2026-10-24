import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
  const canonical = path.resolve(cwd).toLowerCase();
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
  const tasks = store.listTasks(projectId);
  return tasks.find((task) => task.state === 'active') ?? tasks[0] ?? null;
}

function readProjectSnapshot({ cwd, taskId, sinceEventSeq = 0, eventLimit = DEFAULT_EVENT_LIMIT } = {}) {
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
      const task = selectTask(store, projectId, taskId);
      const tasks = store.listTasks(projectId);
      const facts = workspaceFacts(projectRoot, currentDirectory);
      return {
        ok: true,
        initialized: true,
        cwd: currentDirectory,
        projectRoot,
        project: store.getProject(projectId),
        tasks,
        task,
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
      const event = store.appendEvent({
        projectId,
        taskId: task.id,
        type: 'contract.change-proposed',
        payload: {
          proposal: diff,
          sourceRef,
          expectedContractRevision,
          status: 'candidate',
          owner,
        },
        idempotencyKey,
      });
      return {
        ok: true,
        projectId,
        taskId: task.id,
        status: 'candidate',
        contractRevision: task.contractVersion,
        event,
      };
    });
  });
}

const operations = Object.freeze({
  readProjectSnapshot,
  bootstrap,
  claim,
  checkpoint,
  search,
  proposeContractChange,
});

export {
  operations,
  readProjectSnapshot,
  bootstrap,
  claim,
  checkpoint,
  search,
  proposeContractChange,
};
