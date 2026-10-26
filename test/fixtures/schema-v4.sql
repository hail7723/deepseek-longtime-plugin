-- Pre-P2 schema-only snapshot; no user data.
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
            reason TEXT, branch TEXT, workspace TEXT,
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
CREATE TABLE memory_search_documents (
      rowid INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT, branch TEXT, workspace TEXT,
      event_seq INTEGER, created_at TEXT NOT NULL, kind TEXT NOT NULL,
      body TEXT NOT NULL, visibility TEXT NOT NULL, deferred_item_id TEXT,
      UNIQUE(source, project_id, source_id)
    ) STRICT;
CREATE VIRTUAL TABLE memory_search_fts USING fts5(body,
      content='memory_search_documents', content_rowid='rowid', tokenize='trigram');
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
CREATE INDEX memory_search_deferred ON memory_search_documents(project_id, deferred_item_id) WHERE deferred_item_id IS NOT NULL;
CREATE INDEX memory_search_scope ON memory_search_documents(project_id, task_id, branch, workspace, visibility);
CREATE INDEX session_bindings_lookup ON session_bindings(project_id, workspace_id, last_seen_at);
CREATE INDEX tasks_project_state ON tasks(project_id, state);
CREATE INDEX tool_operations_task ON tool_operations(task_id, status, started_at);
CREATE TRIGGER memory_search_ad AFTER DELETE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(memory_search_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body);
    END;
CREATE TRIGGER memory_search_ai AFTER INSERT ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(rowid,body) VALUES (NEW.rowid,NEW.body);
    END;
CREATE TRIGGER memory_search_au AFTER UPDATE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(memory_search_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body);
      INSERT INTO memory_search_fts(rowid,body) VALUES (NEW.rowid,NEW.body);
    END;
CREATE TRIGGER memory_search_checkpoints_ad AFTER DELETE ON checkpoints BEGIN
        DELETE FROM memory_search_documents WHERE source='checkpoint' AND project_id=OLD.project_id AND source_id=CAST(OLD.id AS TEXT);
      END;
CREATE TRIGGER memory_search_checkpoints_ai AFTER INSERT ON checkpoints WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'checkpoint', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NEW.event_seq, NEW.created_at,
      'checkpoint', memory_search_normalize(memory_search_text(NEW.payload_json)), 'confirmed', json_extract(NEW.payload_json,'$.deferredItemId') WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_checkpoints_au AFTER UPDATE ON checkpoints WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'checkpoint', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NEW.event_seq, NEW.created_at,
      'checkpoint', memory_search_normalize(memory_search_text(NEW.payload_json)), 'confirmed', json_extract(NEW.payload_json,'$.deferredItemId') WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_deferred_commits_ad AFTER DELETE ON deferred_commits BEGIN
        DELETE FROM memory_search_documents WHERE source='deferred' AND project_id=OLD.project_id AND source_id=CAST(OLD.id AS TEXT);
      END;
CREATE TRIGGER memory_search_deferred_commits_ai AFTER INSERT ON deferred_commits WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'deferred', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NULL, NEW.created_at,
      'deferred', memory_search_normalize(memory_search_text(NEW.payload_json)), NEW.status, NEW.id WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_deferred_commits_au AFTER UPDATE ON deferred_commits WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'deferred', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NULL, NEW.created_at,
      'deferred', memory_search_normalize(memory_search_text(NEW.payload_json)), NEW.status, NEW.id WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_events_ad AFTER DELETE ON events BEGIN
        DELETE FROM memory_search_documents WHERE source='task-history' AND project_id=OLD.project_id AND source_id=CAST(OLD.seq AS TEXT);
      END;
CREATE TRIGGER memory_search_events_ai AFTER INSERT ON events WHEN NEW.type IN ('task.created','task.updated','contract.updated','contract.candidate-accepted') BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'task-history', CAST(NEW.seq AS TEXT), NEW.project_id, NEW.task_id,
      coalesce(json_extract(NEW.payload_json,'$.branch'),json_extract(NEW.payload_json,'$.patch.branch'),(SELECT branch FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)), coalesce(json_extract(NEW.payload_json,'$.workspace'),json_extract(NEW.payload_json,'$.patch.workspace'),(SELECT workspace FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)), NEW.seq, NEW.created_at,
      NEW.type, memory_search_normalize(memory_search_text(CASE WHEN NEW.type = 'contract.candidate-accepted' THEN coalesce((SELECT diff_json FROM contract_candidates WHERE id=json_extract(NEW.payload_json,'$.candidateId') AND project_id=NEW.project_id AND task_id=NEW.task_id),'{}') ELSE NEW.payload_json END)), 'confirmed', NULL WHERE NEW.type IN ('task.created','task.updated','contract.updated','contract.candidate-accepted')
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_events_au AFTER UPDATE ON events WHEN NEW.type IN ('task.created','task.updated','contract.updated','contract.candidate-accepted') BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'task-history', CAST(NEW.seq AS TEXT), NEW.project_id, NEW.task_id,
      coalesce(json_extract(NEW.payload_json,'$.branch'),json_extract(NEW.payload_json,'$.patch.branch'),(SELECT branch FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)), coalesce(json_extract(NEW.payload_json,'$.workspace'),json_extract(NEW.payload_json,'$.patch.workspace'),(SELECT workspace FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)), NEW.seq, NEW.created_at,
      NEW.type, memory_search_normalize(memory_search_text(CASE WHEN NEW.type = 'contract.candidate-accepted' THEN coalesce((SELECT diff_json FROM contract_candidates WHERE id=json_extract(NEW.payload_json,'$.candidateId') AND project_id=NEW.project_id AND task_id=NEW.task_id),'{}') ELSE NEW.payload_json END)), 'confirmed', NULL WHERE NEW.type IN ('task.created','task.updated','contract.updated','contract.candidate-accepted')
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_evidence_ad AFTER DELETE ON evidence BEGIN
        DELETE FROM memory_search_documents WHERE source='evidence' AND project_id=OLD.project_id AND source_id=CAST(OLD.id AS TEXT);
      END;
CREATE TRIGGER memory_search_evidence_ai AFTER INSERT ON evidence WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'evidence', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NEW.event_seq, NEW.created_at,
      NEW.kind, memory_search_normalize(memory_search_text(NEW.payload_json)), 'confirmed', NULL WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
CREATE TRIGGER memory_search_evidence_au AFTER UPDATE ON evidence WHEN 1 BEGIN INSERT INTO memory_search_documents(source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id) SELECT 'evidence', CAST(NEW.id AS TEXT), NEW.project_id, NEW.task_id,
      NEW.branch, NEW.workspace, NEW.event_seq, NEW.created_at,
      NEW.kind, memory_search_normalize(memory_search_text(NEW.payload_json)), 'confirmed', NULL WHERE 1
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id; END;
