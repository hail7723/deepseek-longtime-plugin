export const PARTICIPANT_TTL_MS = 300000;
export const PARTICIPANTS_MAX_BYTES = 8192;
const STATUSES = new Set(['working', 'waiting', 'blocked', 'done']);

export function validateProgress(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('progress must be an object');
  for (const key of Object.keys(patch)) if (!['summary', 'status', 'nextAction', 'blockers'].includes(key)) throw new TypeError(`Unknown progress field: ${key}`);
  for (const [key, max] of [['summary', 8192], ['nextAction', 2048]]) {
    const value = patch[key];
    if (value !== undefined && !(key === 'nextAction' && value === null)
      && (typeof value !== 'string' || Buffer.byteLength(value) > max)) throw new TypeError(`${key} must be a string of at most ${max} bytes`);
  }
  if (patch.status !== undefined && !STATUSES.has(patch.status)) throw new TypeError('status must be working, waiting, blocked or done');
  if (patch.blockers !== undefined && (!Array.isArray(patch.blockers) || patch.blockers.length > 16
    || !patch.blockers.every(item => typeof item === 'string' && Buffer.byteLength(item) <= 512))) throw new TypeError('blockers must contain at most 16 strings of at most 512 bytes');
}

export function validateNow(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - PARTICIPANT_TTL_MS) throw new TypeError('now must be a valid non-negative millisecond timestamp');
}

export function participantSchema(db) {
  db.exec(`CREATE TABLE participants (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, participant_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('working','waiting','blocked','done')),
    summary TEXT NOT NULL, next_action TEXT, blockers_json TEXT NOT NULL,
    branch TEXT NOT NULL, workspace TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0), last_seen_at INTEGER NOT NULL,
    last_checkpoint_seq INTEGER, last_progress_seq INTEGER, active INTEGER NOT NULL CHECK(active IN (0,1)),
    disposed_at INTEGER, inactive_reason TEXT, parent_session_id TEXT,
    last_start_source TEXT, instance_id TEXT,
    PRIMARY KEY(project_id,task_id,participant_id),
    FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id)
  ) STRICT;
  CREATE INDEX participants_scope ON participants(project_id,task_id,workspace,branch,last_seen_at);`);
}

export function mapParticipant(row) {
  return row ? { projectId: row.project_id, taskId: row.task_id, participantId: row.participant_id,
    status: row.status, summary: row.summary, nextAction: row.next_action, blockers: JSON.parse(row.blockers_json),
    branch: row.branch, workspace: row.workspace, version: row.version, lastSeenAt: row.last_seen_at,
    lastCheckpointSeq: row.last_checkpoint_seq, active: Boolean(row.active), disposedAt: row.disposed_at,
    lastProgressSeq: row.last_progress_seq,
    inactiveReason: row.inactive_reason, parentSessionId: row.parent_session_id,
    lastStartSource: row.last_start_source, instanceId: row.instance_id } : null;
}

export function clipUtf8(value, max) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= max) return text;
  let out = ''; let used = 0;
  for (const ch of text) { const n = Buffer.byteLength(ch); if (used + n > max - 3) break; used += n; out += ch; }
  return out + '…';
}

export function participantView(row, now) {
  validateNow(now);
  const presence = row.disposedAt !== null ? 'disposed' : !row.active ? 'inactive'
    : now - row.lastSeenAt >= PARTICIPANT_TTL_MS ? 'stale' : 'active';
  return { participantId: row.participantId, status: row.status, summary: clipUtf8(row.summary, 512),
    nextAction: row.nextAction === null ? null : clipUtf8(row.nextAction, 256),
    blockers: row.blockers.slice(0, 5).map(item => clipUtf8(item, 128)),
    branch: row.branch, workspace: row.workspace, version: row.version,
    lastSeenAt: new Date(row.lastSeenAt).toISOString(), lastCheckpointSeq: row.lastCheckpointSeq,
    presence, active: presence === 'active', disposedAt: row.disposedAt === null ? null : new Date(row.disposedAt).toISOString(),
    inactiveReason: row.inactiveReason, parentSessionId: row.parentSessionId,
    lastStartSource: row.lastStartSource };
}

export function participantEnvelope({ projectId, taskId, branch, workspace, rows, total, now }) {
  const result = { ok: true, projectId, taskId, filters: { branch, workspace },
    participants: rows, total, truncated: total > rows.length,
    staleAfterSeconds: PARTICIPANT_TTL_MS / 1000, maxBytes: PARTICIPANTS_MAX_BYTES };
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) > PARTICIPANTS_MAX_BYTES && result.participants.length) {
    result.participants.pop(); result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > PARTICIPANTS_MAX_BYTES) {
    const error = new Error('Participant metadata exceeds the response budget'); error.code = 'PARTICIPANT_RESPONSE_TOO_LARGE'; throw error;
  }
  return result;
}
