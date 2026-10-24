import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const DEFAULT_MARKER_DIR = '.deepseek-memory';
const DEFAULT_MARKER_FILE = 'project.json';
const DEFAULT_DATABASE_FILE = 'memory.sqlite';

class StoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.assign(this, details);
  }
}

class ConflictError extends StoreError {
  constructor(message, code, details) {
    super(message, code, details);
  }
}

class LeaseError extends StoreError {
  constructor(message, code = 'LEASE_CONFLICT', details = {}) {
    super(message, code, details);
  }
}

class IdempotencyError extends StoreError {
  constructor(message, details) {
    super(message, 'IDEMPOTENCY_CONFLICT', details);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function encode(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function decode(value) {
  return value == null ? null : JSON.parse(value);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    rootPath: row.root_path,
    markerId: row.marker_id,
    eventSeq: Number(row.event_seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    data: decode(row.data_json),
    contract: decode(row.contract_json),
    taskVersion: Number(row.task_version),
    contractVersion: Number(row.contract_version),
    branch: row.branch,
    workspace: row.workspace,
    leaseOwner: row.lease_owner,
    leaseFence: Number(row.lease_fence),
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    seq: Number(row.seq),
    taskId: row.task_id,
    type: row.type,
    kind: row.type,
    sessionId: row.session_id,
    sourceRef: decode(row.source_ref_json),
    payload: decode(row.payload_json),
    createdAt: row.created_at,
  };
}

function mapEvidence(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    eventSeq: Number(row.event_seq),
    kind: row.kind,
    payload: decode(row.payload_json),
    branch: row.branch,
    workspace: row.workspace,
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    eventSeq: Number(row.event_seq),
    payload: decode(row.payload_json),
    branch: row.branch,
    workspace: row.workspace,
    createdAt: row.created_at,
  };
}

class ProjectMemoryStore {
  constructor(databasePath, options = {}) {
    requireString(databasePath, 'databasePath');
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath, {
      timeout: options.timeout ?? 5000,
      readOnly: options.readOnly ?? false,
    });
    this.closed = false;
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`PRAGMA busy_timeout = ${Number(options.timeout ?? 5000)}`);
    if (!(options.readOnly ?? false)) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.#migrate();
    }
  }

  static openProject(projectRoot, options = {}) {
    requireString(projectRoot, 'projectRoot');
    const rootPath = path.resolve(projectRoot);
    const stateDirectory = path.join(rootPath, options.markerDirectory ?? DEFAULT_MARKER_DIR);
    const markerPath = path.join(stateDirectory, DEFAULT_MARKER_FILE);
    fs.mkdirSync(stateDirectory, { recursive: true });

    let marker;
    if (fs.existsSync(markerPath)) {
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } else {
      marker = {
        schema_version: SCHEMA_VERSION,
        project_id: options.projectId ?? randomUUID(),
        created_at: nowIso(),
      };
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      try {
        fs.renameSync(temporaryPath, markerPath);
      } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        if (!fs.existsSync(markerPath)) throw error;
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      }
    }

    const markerSchemaVersion = marker.schema_version ?? marker.schemaVersion;
    const markerProjectId = marker.project_id ?? marker.projectId;
    if (markerSchemaVersion !== SCHEMA_VERSION || typeof markerProjectId !== 'string') {
      throw new StoreError(`Invalid project marker at ${markerPath}`, 'INVALID_PROJECT_MARKER', { markerPath });
    }
    const databasePath = options.databasePath ?? path.join(stateDirectory, DEFAULT_DATABASE_FILE);
    const store = new ProjectMemoryStore(databasePath, options);
    const project = store.ensureProject({
      id: markerProjectId,
      rootPath,
      markerId: markerProjectId,
    });
    return { store, project, markerPath, databasePath };
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        marker_id TEXT NOT NULL UNIQUE,
        event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        task_version INTEGER NOT NULL DEFAULT 1 CHECK(task_version >= 1),
        contract_version INTEGER NOT NULL DEFAULT 1 CHECK(contract_version >= 1),
        branch TEXT,
        workspace TEXT,
        lease_owner TEXT,
        lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
        lease_expires_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_project_state ON tasks(project_id, state);

      CREATE TABLE IF NOT EXISTS events (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK(seq > 0),
        task_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        source_ref_json TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_project_task ON events(project_id, task_id, seq);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        branch TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id, event_seq) REFERENCES events(project_id, seq),
        FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evidence_scope ON evidence(project_id, task_id, branch, workspace, event_seq);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT,
        event_seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        branch TEXT,
        workspace TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id, event_seq) REFERENCES events(project_id, seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS checkpoints_project_seq ON checkpoints(project_id, event_seq);

      CREATE TABLE IF NOT EXISTS idempotency (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, idempotency_key)
      ) STRICT;
    `);
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  journalMode() {
    return this.db.prepare('PRAGMA journal_mode').get().journal_mode;
  }

  ensureProject({ id = randomUUID(), rootPath, markerId = id }) {
    requireString(id, 'id');
    requireString(rootPath, 'rootPath');
    requireString(markerId, 'markerId');
    const resolvedRoot = path.resolve(rootPath);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects(id, root_path, marker_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(id, resolvedRoot, markerId, timestamp, timestamp);
    const project = this.getProject(id);
    if (!project || project.rootPath !== resolvedRoot || project.markerId !== markerId) {
      throw new StoreError('Project identity does not match its persisted marker', 'PROJECT_IDENTITY_CONFLICT', {
        projectId: id,
        rootPath: resolvedRoot,
        markerId,
      });
    }
    return project;
  }

  getProject(projectId) {
    return mapProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
  }

  createTask({
    projectId,
    id = randomUUID(),
    title = '',
    state = 'pending',
    data = {},
    contract = {},
    branch = null,
    workspace = null,
    idempotencyKey,
  }) {
    requireString(projectId, 'projectId');
    requireString(id, 'id');
    return this.#writeIdempotent(projectId, 'create-task', idempotencyKey, () => {
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO tasks(
          id, project_id, title, state, data_json, contract_json,
          branch, workspace, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, title, state, encode(data), encode(contract), branch, workspace, timestamp, timestamp);
      const event = this.#appendEvent(projectId, id, 'task.created', {
        title, state, data, contract, branch, workspace,
      });
      return { task: this.getTask(projectId, id), event };
    });
  }

  getTask(projectId, taskId) {
    return mapTask(this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId));
  }

  listTasks(projectId, options = {}) {
    const rows = options.state === undefined
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND state = ? ORDER BY created_at, id').all(projectId, options.state);
    return rows.map(mapTask);
  }

  updateTask({ projectId, taskId, expectedVersion, patch, idempotencyKey, lease }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError('expectedVersion must be a positive safe integer');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('patch must be an object');
    }
    const allowed = ['title', 'state', 'data', 'branch', 'workspace'];
    const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new TypeError(`Unknown task patch field: ${unknown[0]}`);

    return this.#writeIdempotent(projectId, 'update-task', idempotencyKey, () => {
      const current = this.#requireTask(projectId, taskId);
      this.#assertLease(current, lease);
      if (current.taskVersion !== expectedVersion) {
        throw new ConflictError('Task version changed', 'TASK_REVISION_CONFLICT', {
          projectId, taskId, expectedVersion, actualVersion: current.taskVersion, versionKind: 'task',
        });
      }
      const next = { ...current, ...patch };
      const result = this.db.prepare(`
        UPDATE tasks SET title = ?, state = ?, data_json = ?, branch = ?, workspace = ?,
          task_version = task_version + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND task_version = ?
      `).run(next.title, next.state, encode(next.data), next.branch, next.workspace, nowIso(), projectId, taskId, expectedVersion);
      if (Number(result.changes) !== 1) this.#throwTaskConflict(projectId, taskId, expectedVersion, 'task');
      const event = this.#appendEvent(projectId, taskId, 'task.updated', { patch, previousVersion: expectedVersion });
      return { task: this.getTask(projectId, taskId), event };
    });
  }

  updateContract({ projectId, taskId, expectedVersion, contract, idempotencyKey, lease }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError('expectedVersion must be a positive safe integer');
    }
    return this.#writeIdempotent(projectId, 'update-contract', idempotencyKey, () => {
      const current = this.#requireTask(projectId, taskId);
      this.#assertLease(current, lease);
      if (current.contractVersion !== expectedVersion) {
        throw new ConflictError('Contract version changed', 'CONTRACT_REVISION_CONFLICT', {
          projectId, taskId, expectedVersion, actualVersion: current.contractVersion, versionKind: 'contract',
        });
      }
      const result = this.db.prepare(`
        UPDATE tasks SET contract_json = ?, contract_version = contract_version + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND contract_version = ?
      `).run(encode(contract), nowIso(), projectId, taskId, expectedVersion);
      if (Number(result.changes) !== 1) this.#throwTaskConflict(projectId, taskId, expectedVersion, 'contract');
      const event = this.#appendEvent(projectId, taskId, 'contract.updated', {
        contract, previousVersion: expectedVersion,
      });
      return { task: this.getTask(projectId, taskId), event };
    });
  }

  appendEvent({
    projectId,
    taskId = null,
    sessionId = null,
    kind,
    type = kind,
    payload = {},
    idempotencyKey,
    sourceRef = null,
  }) {
    requireString(projectId, 'projectId');
    requireString(type, 'kind');
    return this.#writeIdempotent(projectId, 'append-event', idempotencyKey,
      () => this.#appendEvent(projectId, taskId, type, payload, { sessionId, sourceRef }));
  }

  listEvents(projectId, options = {}) {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('afterSeq must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
    return this.db.prepare(`
      SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(projectId, afterSeq, limit).map(mapEvent);
  }

  acquireLease({ projectId, taskId, owner, ttlMs, now = Date.now() }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    requireString(owner, 'owner');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive safe integer');
    return this.#transaction(() => {
      const current = this.#requireTask(projectId, taskId);
      if (current.leaseOwner !== null && current.leaseExpiresAt > now && current.leaseOwner !== owner) {
        throw new LeaseError('Task lease is held by another owner', 'LEASE_CONFLICT', {
          projectId, taskId, owner: current.leaseOwner, expiresAt: current.leaseExpiresAt,
        });
      }
      const expiresAt = now + ttlMs;
      const result = this.db.prepare(`
        UPDATE tasks SET lease_owner = ?, lease_fence = lease_fence + 1,
          lease_expires_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND lease_fence = ?
      `).run(owner, expiresAt, nowIso(), projectId, taskId, current.leaseFence);
      if (Number(result.changes) !== 1) {
        throw new LeaseError('Lease changed concurrently', 'LEASE_CONFLICT', { projectId, taskId });
      }
      const task = this.#requireTask(projectId, taskId);
      this.#appendEvent(projectId, taskId, 'lease.acquired', {
        owner, fence: task.leaseFence, expiresAt,
      });
      return { owner, fence: task.leaseFence, expiresAt };
    });
  }

  renewLease({ projectId, taskId, owner, fence, ttlMs, now = Date.now() }) {
    requireString(owner, 'owner');
    if (!Number.isSafeInteger(fence) || fence < 1) throw new TypeError('fence must be a positive safe integer');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive safe integer');
    return this.#transaction(() => {
      const current = this.#requireTask(projectId, taskId);
      if (current.leaseOwner !== owner || current.leaseFence !== fence || current.leaseExpiresAt <= now) {
        throw new LeaseError('Lease token is stale or expired', 'LEASE_CONFLICT', {
          projectId, taskId, owner, fence, actualFence: current.leaseFence,
        });
      }
      const expiresAt = now + ttlMs;
      this.db.prepare(`
        UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND lease_owner = ? AND lease_fence = ?
      `).run(expiresAt, nowIso(), projectId, taskId, owner, fence);
      this.#appendEvent(projectId, taskId, 'lease.renewed', { owner, fence, expiresAt });
      return { owner, fence, expiresAt };
    });
  }

  releaseLease({ projectId, taskId, owner, fence }) {
    return this.#transaction(() => {
      const current = this.#requireTask(projectId, taskId);
      if (current.leaseOwner !== owner || current.leaseFence !== fence) {
        throw new LeaseError('Lease token is stale', 'LEASE_CONFLICT', {
          projectId, taskId, owner, fence, actualFence: current.leaseFence,
        });
      }
      this.db.prepare(`
        UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE project_id = ? AND id = ? AND lease_owner = ? AND lease_fence = ?
      `).run(nowIso(), projectId, taskId, owner, fence);
      return this.#appendEvent(projectId, taskId, 'lease.released', { owner, fence });
    });
  }

  addEvidence({
    projectId,
    taskId,
    id = randomUUID(),
    kind,
    payload = {},
    branch,
    workspace,
    idempotencyKey,
    lease,
  }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    requireString(id, 'id');
    requireString(kind, 'kind');
    requireString(branch, 'branch');
    requireString(workspace, 'workspace');
    return this.#writeIdempotent(projectId, 'add-evidence', idempotencyKey, () => {
      const task = this.#requireTask(projectId, taskId);
      this.#assertLease(task, lease);
      const event = this.#appendEvent(projectId, taskId, 'evidence.added', { id, kind, branch, workspace });
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO evidence(
          id, project_id, task_id, event_seq, kind, payload_json, branch, workspace, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, taskId, event.seq, kind, encode(payload), branch, workspace, timestamp);
      return mapEvidence(this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id));
    });
  }

  listEvidence({ projectId, taskId, branch, workspace, afterSeq = 0 }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    requireString(branch, 'branch');
    requireString(workspace, 'workspace');
    return this.db.prepare(`
      SELECT * FROM evidence
      WHERE project_id = ? AND task_id = ? AND branch = ? AND workspace = ? AND event_seq > ?
      ORDER BY event_seq, id
    `).all(projectId, taskId, branch, workspace, afterSeq).map(mapEvidence);
  }

  commitCheckpoint({
    projectId,
    taskId,
    expectedTaskVersion,
    expectedContractVersion,
    lease,
    taskPatch = {},
    evidence = [],
    checkpointPayload = {},
    branch,
    workspace,
    idempotencyKey,
  }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    requireString(branch, 'branch');
    requireString(workspace, 'workspace');
    if (!Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 1) {
      throw new TypeError('expectedTaskVersion must be a positive safe integer');
    }
    if (!Number.isSafeInteger(expectedContractVersion) || expectedContractVersion < 1) {
      throw new TypeError('expectedContractVersion must be a positive safe integer');
    }
    if (!taskPatch || typeof taskPatch !== 'object' || Array.isArray(taskPatch)) {
      throw new TypeError('taskPatch must be an object');
    }
    if (!Array.isArray(evidence)) throw new TypeError('evidence must be an array');
    if (!checkpointPayload || typeof checkpointPayload !== 'object' || Array.isArray(checkpointPayload)) {
      throw new TypeError('checkpointPayload must be an object');
    }
    const allowed = ['title', 'state', 'data', 'branch', 'workspace'];
    const unknown = Object.keys(taskPatch).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new TypeError(`Unknown task patch field: ${unknown[0]}`);

    return this.#writeIdempotent(projectId, 'commit-checkpoint', idempotencyKey, () => {
      const current = this.#requireTask(projectId, taskId);
      if (current.taskVersion !== expectedTaskVersion) {
        throw new ConflictError('Task version changed', 'TASK_REVISION_CONFLICT', {
          projectId,
          taskId,
          expectedVersion: expectedTaskVersion,
          actualVersion: current.taskVersion,
          versionKind: 'task',
        });
      }
      if (current.contractVersion !== expectedContractVersion) {
        throw new ConflictError('Contract version changed', 'CONTRACT_REVISION_CONFLICT', {
          projectId,
          taskId,
          expectedVersion: expectedContractVersion,
          actualVersion: current.contractVersion,
          versionKind: 'contract',
        });
      }
      this.#assertLease(current, lease);

      const next = { ...current, ...taskPatch };
      const updated = this.db.prepare(`
        UPDATE tasks SET title = ?, state = ?, data_json = ?, branch = ?, workspace = ?,
          task_version = task_version + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND task_version = ? AND contract_version = ?
      `).run(
        next.title,
        next.state,
        encode(next.data),
        next.branch,
        next.workspace,
        nowIso(),
        projectId,
        taskId,
        expectedTaskVersion,
        expectedContractVersion,
      );
      if (Number(updated.changes) !== 1) {
        const actual = this.#requireTask(projectId, taskId);
        if (actual.taskVersion !== expectedTaskVersion) {
          this.#throwTaskConflict(projectId, taskId, expectedTaskVersion, 'task');
        }
        this.#throwTaskConflict(projectId, taskId, expectedContractVersion, 'contract');
      }

      const committedTask = this.#requireTask(projectId, taskId);
      const storedEvidence = [];
      let coveredEventSeq = this.getProject(projectId).eventSeq;
      for (const item of evidence) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new TypeError('each evidence item must be an object');
        }
        const id = item.id ?? randomUUID();
        const kind = item.kind;
        const itemBranch = item.branch ?? branch;
        const itemWorkspace = item.workspace ?? workspace;
        requireString(id, 'evidence.id');
        requireString(kind, 'evidence.kind');
        requireString(itemBranch, 'evidence.branch');
        requireString(itemWorkspace, 'evidence.workspace');
        const event = this.#appendEvent(projectId, taskId, 'evidence.added', {
          id,
          kind,
          branch: itemBranch,
          workspace: itemWorkspace,
        });
        this.db.prepare(`
          INSERT INTO evidence(
            id, project_id, task_id, event_seq, kind, payload_json, branch, workspace, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          projectId,
          taskId,
          event.seq,
          kind,
          encode(item.payload ?? {}),
          itemBranch,
          itemWorkspace,
          nowIso(),
        );
        storedEvidence.push(mapEvidence(this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)));
        coveredEventSeq = event.seq;
      }

      const checkpointId = randomUUID();
      const committedPayload = {
        ...checkpointPayload,
        taskVersion: committedTask.taskVersion,
        contractVersion: committedTask.contractVersion,
        coveredEventSeq,
      };
      const checkpointEvent = this.#appendEvent(projectId, taskId, 'checkpoint.created', {
        id: checkpointId,
        branch,
        workspace,
        taskVersion: committedTask.taskVersion,
        contractVersion: committedTask.contractVersion,
        coveredEventSeq,
      });
      this.db.prepare(`
        INSERT INTO checkpoints(id, project_id, task_id, event_seq, payload_json, branch, workspace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        projectId,
        taskId,
        checkpointEvent.seq,
        encode(committedPayload),
        branch,
        workspace,
        nowIso(),
      );
      const checkpoint = mapCheckpoint(this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId));
      return {
        task: committedTask,
        evidence: storedEvidence,
        checkpoint,
        taskVersion: committedTask.taskVersion,
        contractVersion: committedTask.contractVersion,
        coveredEventSeq,
      };
    });
  }

  createCheckpoint({
    projectId,
    taskId = null,
    id = randomUUID(),
    payload = {},
    branch = null,
    workspace = null,
    idempotencyKey,
  }) {
    requireString(projectId, 'projectId');
    requireString(id, 'id');
    return this.#writeIdempotent(projectId, 'create-checkpoint', idempotencyKey, () => {
      if (taskId !== null) this.#requireTask(projectId, taskId);
      const event = this.#appendEvent(projectId, taskId, 'checkpoint.created', { id, branch, workspace });
      this.db.prepare(`
        INSERT INTO checkpoints(id, project_id, task_id, event_seq, payload_json, branch, workspace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, taskId, event.seq, encode(payload), branch, workspace, nowIso());
      return mapCheckpoint(this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id));
    });
  }

  latestCheckpoint(projectId, options = {}) {
    const clauses = ['project_id = ?'];
    const parameters = [projectId];
    for (const [column, key] of [['task_id', 'taskId'], ['branch', 'branch'], ['workspace', 'workspace']]) {
      if (own(options, key)) {
        if (options[key] === null) clauses.push(`${column} IS NULL`);
        else {
          clauses.push(`${column} = ?`);
          parameters.push(options[key]);
        }
      }
    }
    return mapCheckpoint(this.db.prepare(`
      SELECT * FROM checkpoints WHERE ${clauses.join(' AND ')}
      ORDER BY event_seq DESC LIMIT 1
    `).get(...parameters));
  }

  exportRecoveryBundle(projectId, options = {}) {
    const project = this.getProject(projectId);
    if (!project) throw new StoreError('Project not found', 'NOT_FOUND', { projectId });
    const tasks = this.listTasks(projectId);
    const events = this.listEvents(projectId, { limit: options.eventLimit ?? 1000000 });

    const scope = [];
    const parameters = [projectId];
    if (own(options, 'branch')) {
      scope.push('branch = ?');
      parameters.push(options.branch);
    }
    if (own(options, 'workspace')) {
      scope.push('workspace = ?');
      parameters.push(options.workspace);
    }
    const suffix = scope.length > 0 ? ` AND ${scope.join(' AND ')}` : '';
    const evidence = this.db.prepare(`
      SELECT * FROM evidence WHERE project_id = ?${suffix} ORDER BY event_seq, id
    `).all(...parameters).map(mapEvidence);
    const checkpoints = this.db.prepare(`
      SELECT * FROM checkpoints WHERE project_id = ?${suffix} ORDER BY event_seq, id
    `).all(...parameters).map(mapCheckpoint);

    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      project,
      tasks,
      events,
      evidence,
      checkpoints,
    };
  }

  bootstrapProject({ projectId = randomUUID(), rootPath, markerId = projectId }) {
    return this.ensureProject({ id: projectId, rootPath, markerId });
  }

  readTask({ projectId, taskId }) {
    return this.getTask(projectId, taskId);
  }

  claimTask({ projectId, taskId, owner, ttlMs = 30000, now }) {
    return this.acquireLease({ projectId, taskId, owner, ttlMs, ...(now === undefined ? {} : { now }) });
  }

  checkpoint(options) {
    return this.createCheckpoint(options);
  }

  search({ projectId, taskId, query = '', branch, workspace, limit = 100 }) {
    requireString(projectId, 'projectId');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
    const clauses = ['project_id = ?', 'instr(payload_json, ?) > 0'];
    const parameters = [projectId, query];
    if (taskId !== undefined) {
      clauses.push('task_id = ?');
      parameters.push(taskId);
    }
    if (branch !== undefined) {
      clauses.push('branch = ?');
      parameters.push(branch);
    }
    if (workspace !== undefined) {
      clauses.push('workspace = ?');
      parameters.push(workspace);
    }
    parameters.push(limit);
    const where = clauses.join(' AND ');
    const evidence = this.db.prepare(`
      SELECT * FROM evidence WHERE ${where}
      ORDER BY event_seq DESC, id LIMIT ?
    `).all(...parameters).map(mapEvidence);
    const checkpoints = this.db.prepare(`
      SELECT * FROM checkpoints WHERE ${where}
      ORDER BY event_seq DESC, id LIMIT ?
    `).all(...parameters).map(row => {
      const checkpoint = mapCheckpoint(row);
      return { ...checkpoint, kind: 'checkpoint', summary: checkpoint.payload?.summary ?? '' };
    });
    return [...evidence, ...checkpoints]
      .sort((left, right) => right.eventSeq - left.eventSeq || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  proposeContractChange({
    projectId,
    taskId,
    expectedContractRevision,
    expectedVersion = expectedContractRevision,
    contract,
    idempotencyKey,
    lease,
  }) {
    return this.updateContract({
      projectId,
      taskId,
      expectedVersion,
      contract,
      idempotencyKey,
      lease,
    });
  }

  renderRecoveryPackage({ projectId, ...options }) {
    return this.exportRecoveryBundle(projectId, options);
  }

  #requireTask(projectId, taskId) {
    const task = this.getTask(projectId, taskId);
    if (!task) throw new StoreError('Task not found', 'NOT_FOUND', { projectId, taskId });
    return task;
  }

  #assertLease(task, lease) {
    if (task.leaseOwner === null) return;
    if (!lease || lease.owner !== task.leaseOwner || lease.fence !== task.leaseFence || task.leaseExpiresAt <= Date.now()) {
      throw new LeaseError('A current lease and fencing token are required', 'LEASE_CONFLICT', {
        projectId: task.projectId,
        taskId: task.id,
        actualFence: task.leaseFence,
      });
    }
  }

  #throwTaskConflict(projectId, taskId, expectedVersion, versionKind) {
    const task = this.#requireTask(projectId, taskId);
    const actualVersion = versionKind === 'task' ? task.taskVersion : task.contractVersion;
    const code = versionKind === 'task' ? 'TASK_REVISION_CONFLICT' : 'CONTRACT_REVISION_CONFLICT';
    throw new ConflictError(`${versionKind === 'task' ? 'Task' : 'Contract'} version changed`, code, {
      projectId, taskId, expectedVersion, actualVersion, versionKind,
    });
  }

  #appendEvent(projectId, taskId, type, payload, { sessionId = null, sourceRef = null } = {}) {
    const row = this.db.prepare(`
      UPDATE projects SET event_seq = event_seq + 1, updated_at = ?
      WHERE id = ? RETURNING event_seq
    `).get(nowIso(), projectId);
    if (!row) throw new StoreError('Project not found', 'NOT_FOUND', { projectId });
    const seq = Number(row.event_seq);
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO events(
        project_id, seq, task_id, session_id, type, source_ref_json, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, seq, taskId, sessionId, type,
      sourceRef === null ? null : encode(sourceRef), encode(payload), createdAt,
    );
    return { projectId, seq, taskId, sessionId, type, kind: type, sourceRef, payload, createdAt };
  }

  #writeIdempotent(projectId, operation, idempotencyKey, writer) {
    if (idempotencyKey !== undefined) requireString(idempotencyKey, 'idempotencyKey');
    return this.#transaction(() => {
      if (idempotencyKey !== undefined) {
        const existing = this.db.prepare(`
          SELECT operation, result_json FROM idempotency
          WHERE project_id = ? AND idempotency_key = ?
        `).get(projectId, idempotencyKey);
        if (existing) {
          if (existing.operation !== operation) {
            throw new IdempotencyError('Idempotency key was used for another operation', {
              projectId, idempotencyKey, operation, existingOperation: existing.operation,
            });
          }
          return decode(existing.result_json);
        }
      }
      const result = writer();
      if (idempotencyKey !== undefined) {
        this.db.prepare(`
          INSERT INTO idempotency(project_id, idempotency_key, operation, result_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(projectId, idempotencyKey, operation, encode(result), nowIso());
      }
      return result;
    });
  }

  #transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }
}

function openStore(databasePath, options) {
  return new ProjectMemoryStore(databasePath, options);
}

function openProjectStore(projectRoot, options = {}) {
  const opened = ProjectMemoryStore.openProject(projectRoot, options);
  opened.store.project = opened.project;
  opened.store.markerPath = opened.markerPath;
  opened.store.projectRoot = path.resolve(projectRoot);
  return opened.store;
}

export {
  ProjectMemoryStore,
  ProjectMemoryStore as SQLiteStateStore,
  ProjectMemoryStore as StateStore,
  openProjectStore,
  openStore,
  StoreError,
  ConflictError,
  LeaseError,
  IdempotencyError,
  SCHEMA_VERSION,
};
