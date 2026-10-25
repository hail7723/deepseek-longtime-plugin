-- Snapshot of the pre-P1 schema, with no user records.
CREATE TABLE checkpoints (
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
CREATE TABLE contract_candidates (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL, base_contract_version INTEGER NOT NULL, diff_json TEXT NOT NULL,
            source_ref_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
            created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
            FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
          ) STRICT;
CREATE TABLE deferred_commits (
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
CREATE TABLE events (
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
CREATE TABLE evidence (
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
CREATE TABLE idempotency (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, idempotency_key)
      ) STRICT;
CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        marker_id TEXT NOT NULL UNIQUE,
        event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
CREATE TABLE session_bindings (
            session_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL, workspace_id TEXT NOT NULL, bound_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL, binding_source TEXT NOT NULL,
            PRIMARY KEY(session_id, project_id, workspace_id),
            FOREIGN KEY(project_id, task_id) REFERENCES tasks(project_id, id)
          ) STRICT;
CREATE TABLE tasks (
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
        updated_at TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, last_checkpoint_at TEXT, last_activity_at TEXT, superseded_by_task_id TEXT,
        UNIQUE(project_id, id)
      ) STRICT;
CREATE TABLE tool_operations (
            call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
            tool_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
            started_at TEXT NOT NULL, finished_at TEXT, result_summary_json TEXT, evidence_ref TEXT
          ) STRICT;
CREATE INDEX checkpoints_project_seq ON checkpoints(project_id, event_seq);
CREATE INDEX contract_candidates_pending ON contract_candidates(project_id, task_id, status);
CREATE INDEX deferred_commits_task ON deferred_commits(project_id, task_id, status, created_at);
CREATE INDEX events_project_task ON events(project_id, task_id, seq);
CREATE INDEX evidence_scope ON evidence(project_id, task_id, branch, workspace, event_seq);
CREATE INDEX session_bindings_lookup ON session_bindings(project_id, workspace_id, last_seen_at);
CREATE INDEX tasks_project_state ON tasks(project_id, state);
CREATE INDEX tool_operations_task ON tool_operations(task_id, status, started_at);
