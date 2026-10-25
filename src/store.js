import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mergeAcceptanceUpdates } from './acceptance.js';
import { configureSearchFunctions, detectSearchCapabilities, installSearchIndex } from './search-index.js';
import { searchPage } from './search.js';

const SCHEMA_VERSION = 4;
const TASK_STATES = new Set(['active', 'paused', 'blocked', 'completed', 'archived']);
const TRANSITIONS = Object.freeze({
  active: new Set(['paused', 'blocked', 'completed', 'archived']),
  paused: new Set(['active', 'blocked', 'completed', 'archived']),
  blocked: new Set(['active', 'paused', 'completed', 'archived']),
  completed: new Set(['archived']),
  archived: new Set([]),
});
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
    displayOrder: Number(row.display_order ?? 0),
    lastCheckpointAt: row.last_checkpoint_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    supersededByTaskId: row.superseded_by_task_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBinding(row) {
  if (!row) return null;
  return { sessionId: row.session_id, projectId: row.project_id, taskId: row.task_id,
    workspaceId: row.workspace_id, boundAt: row.bound_at, lastSeenAt: row.last_seen_at,
    bindingSource: row.binding_source };
}

function mapCandidate(row) {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, taskId: row.task_id,
    baseContractVersion: Number(row.base_contract_version), diff: decode(row.diff_json),
    sourceRef: decode(row.source_ref_json), status: row.status, createdAt: row.created_at,
    decidedAt: row.decided_at, decidedBy: row.decided_by };
}

function mapToolOperation(row) {
  if (!row) return null;
  return { callId: row.call_id, sessionId: row.session_id, taskId: row.task_id,
    toolName: row.tool_name, status: row.status, startedAt: row.started_at,
    finishedAt: row.finished_at, resultSummary: decode(row.result_summary_json), evidenceRef: row.evidence_ref };
}

function mapDeferredCommit(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    baseTaskVersion: Number(row.base_task_version),
    baseContractVersion: Number(row.base_contract_version),
    kind: row.kind,
    payload: decode(row.payload_json),
    status: row.status,
    branch: row.branch ?? null,
    workspace: row.workspace ?? null,
    createdAt: row.created_at,
    flushedAt: row.flushed_at,
    reason: row.reason,
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
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec(`PRAGMA busy_timeout = ${Number(options.timeout ?? 5000)}`);
      configureSearchFunctions(this.db);
      this.searchCapabilities = detectSearchCapabilities(this.db);
      const meta = this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get();
      const version = meta ? Number(this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value ?? 1) : null;
      if (version > SCHEMA_VERSION) throw new StoreError('Database schema is newer than this plugin', 'SCHEMA_TOO_NEW', { version });
      if (!(options.readOnly ?? false)) {
        if (version !== null && version < SCHEMA_VERSION && databasePath !== ':memory:') {
          // Snapshot committed WAL data consistently before schema changes.
          let backup = `${databasePath}.v${version}-backup`;
          if (fs.existsSync(backup)) backup += `.${randomUUID()}`;
          this.db.prepare('VACUUM INTO ?').run(backup);
          this.migrationBackup = backup;
        }
        this.db.exec('PRAGMA journal_mode = WAL');
        this.#migrate();
      }
    } catch (error) {
      this.close(); throw error;
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
        schema_version: 1,
        project_id: options.projectId ?? randomUUID(),
        created_at: nowIso(),
      };
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      try {
        fs.renameSync(temporaryPath, markerPath);
      } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        // Some Windows sandbox mounts prohibit atomic rename inside Temp.  A
        // direct exclusive create still preserves the no-overwrite invariant
        // and lets the test/runtime report a normal filesystem error if it
        // cannot create the marker.
        if (!fs.existsSync(markerPath)) {
          try { fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' }); }
          catch (writeError) { if (!fs.existsSync(markerPath)) throw writeError; }
        }
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      }
    }

    const markerSchemaVersion = marker.schema_version ?? marker.schemaVersion;
    const markerProjectId = marker.project_id ?? marker.projectId;
    if (![1, 2, 3, SCHEMA_VERSION].includes(markerSchemaVersion) || typeof markerProjectId !== 'string') {
      throw new StoreError(`Invalid project marker at ${markerPath}`, 'INVALID_PROJECT_MARKER', { markerPath });
    }
    const databasePath = options.databasePath ?? path.join(stateDirectory, DEFAULT_DATABASE_FILE);
    // The constructor backs up the actual database schema before migrating,
    // including direct database-path callers and projects with a stale marker.
    const store = new ProjectMemoryStore(databasePath, options);
    const project = store.ensureProject({
      id: markerProjectId,
      rootPath,
      markerId: markerProjectId,
    });
    if (markerSchemaVersion !== SCHEMA_VERSION && !(options.readOnly ?? false)) {
      const upgraded = { ...marker, schema_version: SCHEMA_VERSION, migrated_from: markerSchemaVersion, migrated_at: nowIso() };
      fs.writeFileSync(markerPath, `${JSON.stringify(upgraded, null, 2)}\n`);
    }
    return { store, project, markerPath, databasePath };
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');

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
    const version = Number(this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value ?? 1);
    if (version > SCHEMA_VERSION) throw new StoreError('Database schema is newer than this plugin', 'SCHEMA_TOO_NEW', { version });
    if (version < 2) {
      // All changes are additive or value-preserving.  The surrounding constructor
      // has already made the v1 backup; this transaction makes a failed migration
      // reopenable as v1.
      this.#transaction(() => {
        const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name));
        if (!columns.has('display_order')) this.db.exec('ALTER TABLE tasks ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
        if (!columns.has('last_checkpoint_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN last_checkpoint_at TEXT');
        if (!columns.has('last_activity_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN last_activity_at TEXT');
        if (!columns.has('superseded_by_task_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN superseded_by_task_id TEXT');
        this.db.exec(`
          UPDATE tasks SET state = 'paused' WHERE state NOT IN ('active', 'paused', 'blocked', 'completed', 'archived');
          UPDATE tasks SET display_order = rowid WHERE display_order = 0;
          CREATE TABLE IF NOT EXISTS session_bindings (
            session_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL, workspace_id TEXT NOT NULL, bound_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL, binding_source TEXT NOT NULL,
            PRIMARY KEY(session_id, project_id, workspace_id),
            FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS session_bindings_lookup ON session_bindings(project_id, workspace_id, last_seen_at);
          CREATE TABLE IF NOT EXISTS contract_candidates (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL, base_contract_version INTEGER NOT NULL, diff_json TEXT NOT NULL,
            source_ref_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
            created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
            FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS contract_candidates_pending ON contract_candidates(project_id, task_id, status);
          CREATE TABLE IF NOT EXISTS tool_operations (
            call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
            tool_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
            started_at TEXT NOT NULL, finished_at TEXT, result_summary_json TEXT, evidence_ref TEXT
          ) STRICT;
          CREATE INDEX IF NOT EXISTS tool_operations_task ON tool_operations(task_id, status, started_at);
        `);
        // Preserve v1 candidate events as auditable v2 records. Duplicate bodies are
        // retained and marked superseded instead of silently discarded.
        for (const event of this.db.prepare("SELECT * FROM events WHERE type = 'contract.change-proposed' ORDER BY project_id, seq").all()) {
          const payload = decode(event.payload_json) ?? {};
          const duplicate = this.db.prepare('SELECT id FROM contract_candidates WHERE project_id = ? AND task_id = ? AND diff_json = ? LIMIT 1')
            .get(event.project_id, event.task_id, encode(payload.proposal ?? payload.diff ?? {}));
          this.db.prepare(`INSERT OR IGNORE INTO contract_candidates(
            id, project_id, task_id, base_contract_version, diff_json, source_ref_json, status, created_at, decided_at, decided_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(`legacy-event-${event.project_id}-${event.seq}`, event.project_id, event.task_id,
              Number(payload.expectedContractRevision ?? 1), encode(payload.proposal ?? payload.diff ?? {}),
              payload.sourceRef == null ? null : encode(payload.sourceRef), duplicate ? 'superseded' : 'pending',
              event.created_at, duplicate ? event.created_at : null, duplicate ? 'migration:duplicate' : null);
        }
        this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run('2');
      });
    }
    if (version < 3) {
      // Additive only: durable queue for commits deferred behind another
      // session's live lease.  Nothing existing is rewritten.
      this.#transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS deferred_commits (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            base_task_version INTEGER NOT NULL,
            base_contract_version INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','flushed','conflict','discarded')),
            created_at TEXT NOT NULL,
            flushed_at TEXT,
            reason TEXT,
            FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS deferred_commits_task ON deferred_commits(project_id, task_id, status, created_at);
        `);
        this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run('3');
      });
    }
    if (version < 4) {
      this.#transaction(() => {
        const columns = new Set(this.db.prepare('PRAGMA table_info(deferred_commits)').all().map(row => row.name));
        // Unknown legacy origins must not be guessed from current task state.
        if (!columns.has('branch')) this.db.exec('ALTER TABLE deferred_commits ADD COLUMN branch TEXT');
        if (!columns.has('workspace')) this.db.exec('ALTER TABLE deferred_commits ADD COLUMN workspace TEXT');
        installSearchIndex(this.db);
        this.db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
      });
    }
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
    state = 'active',
    data = {},
    contract = {},
    branch = null,
    workspace = null,
    idempotencyKey,
  }) {
    requireString(projectId, 'projectId');
    requireString(id, 'id');
    if (!TASK_STATES.has(state)) throw new TypeError(`Invalid task state: ${state}`);
    return this.#writeIdempotent(projectId, 'create-task', idempotencyKey, () => {
      const timestamp = nowIso();
      const displayOrder = Number(this.db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 AS next FROM tasks WHERE project_id = ?').get(projectId).next);
      this.db.prepare(`
        INSERT INTO tasks(
          id, project_id, title, state, data_json, contract_json,
          branch, workspace, display_order, last_activity_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, title, state, encode(data), encode(contract), branch, workspace, displayOrder, timestamp, timestamp, timestamp);
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
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY display_order, created_at, id').all(projectId)
      : this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND state = ? ORDER BY display_order, created_at, id').all(projectId, options.state);
    return rows.map(mapTask);
  }

  getSessionBinding({ sessionId, projectId, workspaceId }) {
    requireString(sessionId, 'sessionId'); requireString(projectId, 'projectId'); requireString(workspaceId, 'workspaceId');
    return mapBinding(this.db.prepare(`SELECT * FROM session_bindings
      WHERE session_id = ? AND project_id = ? AND workspace_id = ?`).get(sessionId, projectId, workspaceId));
  }

  bindSession({ sessionId, projectId, taskId, workspaceId, source = 'explicit' }) {
    requireString(sessionId, 'sessionId'); requireString(projectId, 'projectId'); requireString(taskId, 'taskId'); requireString(workspaceId, 'workspaceId');
    if (!['explicit', 'sole-open-task', 'migrated'].includes(source)) throw new TypeError('Invalid binding source');
    return this.#transaction(() => {
      const task = this.#requireTask(projectId, taskId);
      if (task.state === 'archived') throw new StoreError('Archived tasks cannot be bound', 'TASK_ARCHIVED', { taskId });
      const timestamp = nowIso();
      this.db.prepare(`INSERT INTO session_bindings(session_id, project_id, task_id, workspace_id, bound_at, last_seen_at, binding_source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, project_id, workspace_id) DO UPDATE SET task_id=excluded.task_id, last_seen_at=excluded.last_seen_at, binding_source=excluded.binding_source`)
        .run(sessionId, projectId, taskId, workspaceId, timestamp, timestamp, source);
      this.#appendEvent(projectId, taskId, 'session.bound', { sessionId, workspaceId, source });
      return this.getSessionBinding({ sessionId, projectId, workspaceId });
    });
  }

  touchSessionBinding({ sessionId, projectId, workspaceId }) {
    const binding = this.getSessionBinding({ sessionId, projectId, workspaceId });
    if (!binding) return null;
    const task = this.getTask(projectId, binding.taskId);
    if (!task || task.state === 'archived') return null;
    this.db.prepare('UPDATE session_bindings SET last_seen_at = ? WHERE session_id = ? AND project_id = ? AND workspace_id = ?')
      .run(nowIso(), sessionId, projectId, workspaceId);
    return this.getSessionBinding({ sessionId, projectId, workspaceId });
  }

  listContractCandidates({ projectId, taskId, status }) {
    const clauses = ['project_id = ?']; const params = [projectId];
    if (taskId !== undefined) { clauses.push('task_id = ?'); params.push(taskId); }
    if (status !== undefined) { clauses.push('status = ?'); params.push(status); }
    return this.db.prepare(`SELECT * FROM contract_candidates WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params).map(mapCandidate);
  }

  createContractCandidate({ projectId, taskId, baseContractVersion, diff, sourceRef, id = randomUUID(), idempotencyKey }) {
    requireString(projectId, 'projectId'); requireString(taskId, 'taskId'); requireString(id, 'id');
    if (!Number.isSafeInteger(baseContractVersion) || baseContractVersion < 1) throw new TypeError('baseContractVersion must be positive');
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) throw new TypeError('diff must be an object');
    return this.#writeIdempotent(projectId, 'create-contract-candidate', idempotencyKey, () => {
      const task = this.#requireTask(projectId, taskId);
      if (task.contractVersion !== baseContractVersion) this.#throwTaskConflict(projectId, taskId, baseContractVersion, 'contract');
      const timestamp = nowIso();
      this.db.prepare(`INSERT INTO contract_candidates(id, project_id, task_id, base_contract_version, diff_json, source_ref_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, projectId, taskId, baseContractVersion, encode(diff), sourceRef == null ? null : encode(sourceRef), timestamp);
      const event = this.#appendEvent(projectId, taskId, 'contract.change-proposed', { candidateId: id, diff, baseContractVersion });
      return { candidate: mapCandidate(this.db.prepare('SELECT * FROM contract_candidates WHERE id = ?').get(id)), event };
    });
  }

  decideContractCandidate({ projectId, candidateId, decision, decidedBy = 'user', idempotencyKey }) {
    if (!['accepted', 'rejected'].includes(decision)) throw new TypeError('decision must be accepted or rejected');
    return this.#writeIdempotent(projectId, 'decide-contract-candidate', idempotencyKey, () => {
      const row = this.db.prepare('SELECT * FROM contract_candidates WHERE id = ? AND project_id = ?').get(candidateId, projectId);
      const candidate = mapCandidate(row);
      if (!candidate) throw new StoreError('Contract candidate not found', 'NOT_FOUND', { candidateId });
      if (candidate.status !== 'pending') throw new ConflictError('Contract candidate was already decided', 'CANDIDATE_DECISION_CONFLICT', { candidateId, status: candidate.status });
      const task = this.#requireTask(projectId, candidate.taskId);
      if (decision === 'accepted' && task.contractVersion !== candidate.baseContractVersion) {
        this.#throwTaskConflict(projectId, task.id, candidate.baseContractVersion, 'contract');
      }
      const timestamp = nowIso();
      if (decision === 'accepted') {
        const contract = { ...task.contract, ...candidate.diff };
        this.db.prepare(`UPDATE tasks SET contract_json = ?, contract_version = contract_version + 1, updated_at = ?, last_activity_at = ?
          WHERE project_id = ? AND id = ? AND contract_version = ?`).run(encode(contract), timestamp, timestamp, projectId, task.id, task.contractVersion);
        this.db.prepare(`UPDATE contract_candidates SET status = 'superseded', decided_at = ?, decided_by = ?
          WHERE project_id = ? AND task_id = ? AND status = 'pending' AND id <> ?`).run(timestamp, 'candidate-accepted', projectId, task.id, candidateId);
      }
      this.db.prepare('UPDATE contract_candidates SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(decision, timestamp, decidedBy, candidateId);
      const updatedTask = this.#requireTask(projectId, task.id);
      const event = this.#appendEvent(projectId, task.id, `contract.candidate-${decision}`, { candidateId, decidedBy, contractVersion: updatedTask.contractVersion });
      return { candidate: mapCandidate(this.db.prepare('SELECT * FROM contract_candidates WHERE id = ?').get(candidateId)), task: updatedTask, event };
    });
  }

  beginToolOperation({ callId, sessionId, taskId, toolName }) {
    requireString(callId, 'callId'); requireString(sessionId, 'sessionId'); requireString(taskId, 'taskId'); requireString(toolName, 'toolName');
    this.db.prepare(`INSERT INTO tool_operations(call_id, session_id, task_id, tool_name, status, started_at)
      VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(call_id) DO NOTHING`).run(callId, sessionId, taskId, toolName, nowIso());
    return mapToolOperation(this.db.prepare('SELECT * FROM tool_operations WHERE call_id = ?').get(callId));
  }

  finishToolOperation({ callId, status, resultSummary = null, evidenceRef = null }) {
    if (!['succeeded', 'failed', 'unknown'].includes(status)) throw new TypeError('Invalid tool operation status');
    this.db.prepare(`UPDATE tool_operations SET status = ?, finished_at = ?, result_summary_json = ?, evidence_ref = ?
      WHERE call_id = ? AND status = 'pending'`).run(status, nowIso(), resultSummary == null ? null : encode(resultSummary), evidenceRef, callId);
    return mapToolOperation(this.db.prepare('SELECT * FROM tool_operations WHERE call_id = ?').get(callId));
  }

  listToolOperations({ taskId, statuses = undefined }) {
    const params = [taskId]; let suffix = '';
    if (statuses?.length) { suffix = ` AND status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
    return this.db.prepare(`SELECT * FROM tool_operations WHERE task_id = ?${suffix} ORDER BY started_at, call_id`).all(...params).map(mapToolOperation);
  }

  markPendingOperationsUnknown({ sessionId, taskId }) {
    this.db.prepare(`UPDATE tool_operations SET status = 'unknown', finished_at = ? WHERE session_id = ? AND task_id = ? AND status = 'pending'`)
      .run(nowIso(), sessionId, taskId);
  }

  enqueueDeferredCommit({ projectId, taskId, sessionId, baseTaskVersion, baseContractVersion, kind, payload, branch = null, workspace = null, id = randomUUID(), now = Date.now() }) {
    requireString(projectId, 'projectId');
    requireString(taskId, 'taskId');
    requireString(sessionId, 'sessionId');
    requireString(kind, 'kind');
    if (!Number.isSafeInteger(baseTaskVersion) || baseTaskVersion < 1) throw new TypeError('baseTaskVersion must be positive');
    if (!Number.isSafeInteger(baseContractVersion) || baseContractVersion < 1) throw new TypeError('baseContractVersion must be positive');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
    return this.#transaction(() => {
      this.#requireTask(projectId, taskId);
      const timestamp = nowIso();
      this.db.prepare(`INSERT INTO deferred_commits(
          id, project_id, task_id, session_id, base_task_version, base_contract_version,
          kind, payload_json, status, created_at, branch, workspace
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, projectId, taskId, sessionId, baseTaskVersion, baseContractVersion, kind, encode(payload), timestamp, branch, workspace);
      return mapDeferredCommit(this.db.prepare('SELECT * FROM deferred_commits WHERE id = ?').get(id));
    });
  }

  listDeferredCommits({ projectId, taskId, sessionId, statuses } = {}) {
    const clauses = ['project_id = ?'];
    const params = [projectId];
    if (taskId !== undefined) { clauses.push('task_id = ?'); params.push(taskId); }
    if (sessionId !== undefined) { clauses.push('session_id = ?'); params.push(sessionId); }
    if (statuses?.length) { clauses.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    return this.db.prepare(`SELECT * FROM deferred_commits WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params).map(mapDeferredCommit);
  }

  updateDeferredCommit({ id, status, reason = null, now = Date.now() }) {
    if (!['queued', 'flushed', 'conflict', 'discarded'].includes(status)) throw new TypeError('Invalid deferred commit status');
    const flushedAt = status === 'flushed' ? nowIso() : null;
    const result = this.db.prepare('UPDATE deferred_commits SET status = ?, reason = ?, flushed_at = ? WHERE id = ? AND status = \'queued\'').run(status, reason, flushedAt, id);
    if (Number(result.changes) !== 1) {
      const existing = this.db.prepare('SELECT status FROM deferred_commits WHERE id = ?').get(id);
      if (!existing) throw new StoreError('Deferred commit not found', 'NOT_FOUND', { id });
      throw new StoreError('Deferred commit is not queued', 'DEFERRED_STATE_CONFLICT', { id, status: existing.status });
    }
    return mapDeferredCommit(this.db.prepare('SELECT * FROM deferred_commits WHERE id = ?').get(id));
  }

  readLeaseStatus({ projectId, taskId, owner, now = Date.now() }) {
    const task = this.#requireTask(projectId, taskId);
    const live = task.leaseOwner !== null && task.leaseExpiresAt > now;
    const remainingSeconds = live ? Math.max(0, Math.ceil((task.leaseExpiresAt - now) / 1000)) : 0;
    return {
      live,
      heldByCurrentSession: live && task.leaseOwner === owner,
      heldByOtherSession: live && task.leaseOwner !== owner,
      remainingSeconds,
      canRetryAt: live ? new Date(task.leaseExpiresAt + 1).toISOString() : new Date(now).toISOString(),
      retryAfterSeconds: live ? Math.max(0, Math.ceil((task.leaseExpiresAt + 1 - now) / 1000)) : 0,
      diagnostics: {
        owner: task.leaseOwner,
        fence: task.leaseFence,
        expiresAt: task.leaseExpiresAt,
        taskId: task.id,
        taskVersion: task.taskVersion,
        contractVersion: task.contractVersion,
      },
    };
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
      this.#assertTransition(current.state, next.state);
      const result = this.db.prepare(`
        UPDATE tasks SET title = ?, state = ?, data_json = ?, branch = ?, workspace = ?,
          task_version = task_version + 1, last_activity_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND task_version = ?
      `).run(next.title, next.state, encode(next.data), next.branch, next.workspace, nowIso(), nowIso(), projectId, taskId, expectedVersion);
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
      this.#assertTransition(current.state, next.state);
      const updated = this.db.prepare(`
        UPDATE tasks SET title = ?, state = ?, data_json = ?, branch = ?, workspace = ?,
          task_version = task_version + 1, last_activity_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND task_version = ? AND contract_version = ?
      `).run(
        next.title,
        next.state,
        encode(next.data),
        next.branch,
        next.workspace,
        nowIso(),
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
      this.db.prepare('UPDATE tasks SET last_checkpoint_at = ?, last_activity_at = ?, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(checkpoint.createdAt, checkpoint.createdAt, checkpoint.createdAt, projectId, taskId);
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

  readAcceptanceUpdates({ projectId, taskId, branch, workspace }) {
    const task = this.#requireTask(projectId, taskId);
    const current = Array.isArray(task.data?.acceptanceUpdates) ? task.data.acceptanceUpdates : [];
    // Older builds wrote [] on ordinary checkpoints (and on task.data). Read
    // the newest non-empty observation in this workspace without rewriting DBs.
    const row = this.db.prepare(`SELECT payload_json FROM checkpoints
      WHERE project_id = ? AND task_id = ? AND branch = ? AND workspace = ?
        AND json_type(payload_json, '$.acceptanceUpdates') = 'array'
        AND json_array_length(payload_json, '$.acceptanceUpdates') > 0
      ORDER BY event_seq DESC LIMIT 1`).get(projectId, taskId, branch, workspace);
    // Legacy deferred flushes only wrote the checkpoint. Its observation must
    // supersede an older task observation for the same criterion.
    return row ? mergeAcceptanceUpdates(current, decode(row.payload_json).acceptanceUpdates)
      : current.length ? current : null;
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

  searchPage(options) {
    // Keep counts, queued shadowing and returned rows in one read snapshot.
    if (this.db.isTransaction) return searchPage(this.db, options);
    this.db.exec('BEGIN');
    try {
      const result = searchPage(this.db, options);
      this.db.exec('COMMIT'); return result;
    } catch (error) {
      this.db.exec('ROLLBACK'); throw error;
    }
  }

  search(options) {
    // Retain the low-level array API; Agent and Remote use the same query
    // implementation with a metadata envelope and explicitly resolved filters.
    const scope = options.scope ?? (options.branch !== undefined && options.workspace !== undefined ? 'current' : options.taskId ? 'task' : 'current');
    return this.searchPage({ ...options, scope }).results;
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

  #assertTransition(previous, next) {
    if (!TASK_STATES.has(next)) throw new StoreError(`Invalid task state: ${next}`, 'INVALID_TASK_STATE', { state: next });
    if (previous !== next && !TRANSITIONS[previous]?.has(next)) {
      throw new ConflictError(`Task cannot transition from ${previous} to ${next}`, 'INVALID_TASK_TRANSITION', { previous, next });
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
