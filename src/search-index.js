import { normalizeSearchText } from './search.js';

export function detectSearchCapabilities(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.memory_search_probe USING fts5(body, tokenize='trigram')");
    db.prepare('INSERT INTO temp.memory_search_probe(body) VALUES (?)').run('hello 打招呼');
    const row = db.prepare('SELECT count(*) n FROM temp.memory_search_probe WHERE memory_search_probe MATCH ?').get('"hello" AND "打招呼"');
    if (row.n !== 1) throw new Error('trigram probe did not match');
    return { fts5: true, trigram: true };
  } catch (cause) {
    const error = new Error('Search requires SQLite FTS5 with the trigram tokenizer', { cause });
    error.code = 'SEARCH_UNAVAILABLE'; throw error;
  } finally { db.exec('DROP TABLE IF EXISTS temp.memory_search_probe'); }
}

// Index human text values rather than JSON keys or private lease/session data.
// Source rows are kept intact. Registered on every store connection because
// source triggers execute these deterministic functions inside its transaction.
const PRIVATE_KEYS = new Set(['owner', 'fence', 'leaseowner', 'leasefence', 'leaseexpiresat', 'sessionid', 'flushedby', 'deferredfrom', 'id', 'projectid', 'taskid', 'workspace', 'branch', 'coderevision', 'sourceref', 'deferreditemid', 'taskversion', 'contractversion', 'coveredeventseq']);

function searchableText(json) {
  const values = [];
  function visit(value) {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) if (!PRIVATE_KEYS.has(key.toLowerCase().replaceAll('_', ''))) visit(item);
    }
  }
  visit(JSON.parse(json));
  return values.join(' ');
}

export function configureSearchFunctions(db) {
  db.function('memory_search_text', { deterministic: true }, searchableText);
  db.function('memory_search_normalize', { deterministic: true }, normalizeSearchText);
}

export function installSearchIndex(db) {
  db.exec(`
    CREATE TABLE memory_search_documents (
      rowid INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT, branch TEXT, workspace TEXT,
      event_seq INTEGER, created_at TEXT NOT NULL, kind TEXT NOT NULL,
      body TEXT NOT NULL, visibility TEXT NOT NULL, deferred_item_id TEXT,
      UNIQUE(source, project_id, source_id)
    ) STRICT;
    CREATE INDEX memory_search_scope ON memory_search_documents(project_id, task_id, branch, workspace, visibility);
    CREATE INDEX memory_search_deferred ON memory_search_documents(project_id, deferred_item_id) WHERE deferred_item_id IS NOT NULL;
    CREATE VIRTUAL TABLE memory_search_fts USING fts5(body,
      content='memory_search_documents', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER memory_search_ai AFTER INSERT ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(rowid,body) VALUES (NEW.rowid,NEW.body);
    END;
    CREATE TRIGGER memory_search_ad AFTER DELETE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(memory_search_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body);
    END;
    CREATE TRIGGER memory_search_au AFTER UPDATE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts(memory_search_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body);
      INSERT INTO memory_search_fts(rowid,body) VALUES (NEW.rowid,NEW.body);
    END;
  `);
  const historyTypes = "('task.created','task.updated','contract.updated','contract.candidate-accepted')";
  const sources = [
    { table: 'checkpoints', source: 'checkpoint', id: 'id', seq: 'event_seq', kind: "'checkpoint'", visibility: "'confirmed'", deferred: "json_extract(NEW.payload_json,'$.deferredItemId')" },
    { table: 'evidence', source: 'evidence', id: 'id', seq: 'event_seq', kind: 'NEW.kind', visibility: "'confirmed'", deferred: 'NULL' },
    { table: 'deferred_commits', source: 'deferred', id: 'id', seq: null, kind: "'deferred'", visibility: 'NEW.status', deferred: 'NEW.id' },
    { table: 'events', source: 'task-history', id: 'seq', seq: 'seq', kind: 'NEW.type', visibility: "'confirmed'", deferred: 'NULL', history: true },
  ];
  for (const source of sources) {
    const columns = 'source,source_id,project_id,task_id,branch,workspace,event_seq,created_at,kind,body,visibility,deferred_item_id';
    const branch = source.history ? "coalesce(json_extract(NEW.payload_json,'$.branch'),json_extract(NEW.payload_json,'$.patch.branch'),(SELECT branch FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id))" : 'NEW.branch';
    const workspace = source.history ? "coalesce(json_extract(NEW.payload_json,'$.workspace'),json_extract(NEW.payload_json,'$.patch.workspace'),(SELECT workspace FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id))" : 'NEW.workspace';
    const payload = source.history ? "CASE WHEN NEW.type = 'contract.candidate-accepted' THEN coalesce((SELECT diff_json FROM contract_candidates WHERE id=json_extract(NEW.payload_json,'$.candidateId') AND project_id=NEW.project_id AND task_id=NEW.task_id),'{}') ELSE NEW.payload_json END" : 'NEW.payload_json';
    const values = `'${source.source}', CAST(NEW.${source.id} AS TEXT), NEW.project_id, NEW.task_id,
      ${branch}, ${workspace}, ${source.seq ? `NEW.${source.seq}` : 'NULL'}, NEW.created_at,
      ${source.kind}, memory_search_normalize(memory_search_text(${payload})), ${source.visibility}, ${source.deferred}`;
    const condition = source.history ? `NEW.type IN ${historyTypes}` : '1';
    const upsert = `INSERT INTO memory_search_documents(${columns}) SELECT ${values} WHERE ${condition}
      ON CONFLICT(source,project_id,source_id) DO UPDATE SET
        task_id=excluded.task_id,branch=excluded.branch,workspace=excluded.workspace,event_seq=excluded.event_seq,
        created_at=excluded.created_at,kind=excluded.kind,body=excluded.body,visibility=excluded.visibility,deferred_item_id=excluded.deferred_item_id;`;
    // All identifiers/expressions here come from the fixed definitions above.
    db.exec(`CREATE TRIGGER memory_search_${source.table}_ai AFTER INSERT ON ${source.table} WHEN ${condition} BEGIN ${upsert} END;
      CREATE TRIGGER memory_search_${source.table}_au AFTER UPDATE ON ${source.table} WHEN ${condition} BEGIN ${upsert} END;
      CREATE TRIGGER memory_search_${source.table}_ad AFTER DELETE ON ${source.table} BEGIN
        DELETE FROM memory_search_documents WHERE source='${source.source}' AND project_id=OLD.project_id AND source_id=CAST(OLD.${source.id} AS TEXT);
      END;`);
    // Legacy history with no recorded scope stays unknown. Never guess its
    // past workspace from the task's current workspace during a backfill.
    let backfill = `INSERT INTO memory_search_documents(${columns}) SELECT ${values} FROM ${source.table} NEW WHERE ${condition}`;
    if (source.history) {
      backfill = backfill.replaceAll(',(SELECT branch FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)', '')
        .replaceAll(',(SELECT workspace FROM tasks WHERE project_id=NEW.project_id AND id=NEW.task_id)', '');
    }
    db.exec(backfill);
  }
}
