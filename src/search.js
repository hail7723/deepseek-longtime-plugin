export const MAX_SEARCH_BYTES = 16384;
export const MAX_SEARCH_LIMIT = 100;
const MAX_QUERY_BYTES = 512;
const MAX_TERMS = 16;

export function normalizeSearchText(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function parseSearchQuery({ query, mode = 'any', scope = 'current', includeDeferred = true, limit = 20 }) {
  if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > MAX_QUERY_BYTES || query.includes('\0')) {
    throw new TypeError(`query must be a non-empty string of at most ${MAX_QUERY_BYTES} UTF-8 bytes without NUL`);
  }
  if (!['any', 'all', 'phrase'].includes(mode)) throw new TypeError('mode must be any, all or phrase');
  if (!['current', 'task', 'project'].includes(scope)) throw new TypeError('scope must be current, task or project');
  if (typeof includeDeferred !== 'boolean') throw new TypeError('include_deferred must be a boolean');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  const normalizedQuery = normalizeSearchText(query);
  // Punctuation has no operator meaning. Phrase mode retains it literally.
  const terms = [...new Set(normalizedQuery.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [normalizedQuery])];
  if (terms.length > MAX_TERMS) throw new TypeError(`query must contain at most ${MAX_TERMS} distinct terms`);
  return { mode, scope, includeDeferred, limit: Math.min(limit, MAX_SEARCH_LIMIT), normalizedQuery, terms, limitClamped: limit > MAX_SEARCH_LIMIT };
}

function matchPredicate(terms, mode) {
  const args = [];
  const parts = terms.map(term => {
    // Binding the expression is not sufficient: quoting each term also keeps
    // user quotes, OR, NOT, NEAR and column selectors out of the FTS grammar.
    if ([...term].length >= 3) {
      args.push(`"${term.replaceAll('"', '""')}"`, term);
      return '(d.rowid IN (SELECT rowid FROM memory_search_fts WHERE memory_search_fts MATCH ?) AND instr(d.body, ?) > 0)';
    }
    args.push(term);
    return 'instr(d.body, ?) > 0';
  });
  return { sql: `(${parts.join(mode === 'all' ? ' AND ' : ' OR ')})`, args };
}

function filterPredicate({ taskId, branch, workspace }) {
  const clauses = []; const args = [];
  for (const [column, value] of [['task_id', taskId], ['branch', branch], ['workspace', workspace]]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${column} must be a non-empty string`);
    clauses.push(`d.${column} IS ?`); args.push(value);
  }
  return { sql: clauses.length ? `(${clauses.join(' AND ')})` : '1', args };
}

function clip(text, bytes) {
  let out = ''; let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) break;
    out += character; used += size;
  }
  return out;
}

function snippet(body, terms) {
  const positions = terms.map(term => body.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, Math.min(...positions) - 48);
  // body is normalized Unicode; slicing from a code-point boundary avoids
  // producing unpaired surrogates around astral characters.
  const safeStart = start > 0 && /[\uDC00-\uDFFF]/u.test(body[start]) ? start - 1 : start;
  return (safeStart ? '…' : '') + clip(body.slice(safeStart), 640);
}

function measure(result) {
  // This covers the actual pretty-printed Agent text as well as compact wire
  // JSON. Only remove complete result rows; never truncate serialized JSON.
  for (let pass = 0; pass < 4; pass++) result.budget.bytes = Buffer.byteLength(JSON.stringify(result, null, 2));
  return result.budget.bytes;
}

export function searchPage(db, options) {
  const parsed = parseSearchQuery(options);
  const { projectId, taskId, branch, workspace } = options;
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('projectId must be a non-empty string');
  const { mode, scope, includeDeferred, limit, normalizedQuery, terms } = parsed;
  if (scope === 'current' && (typeof branch !== 'string' || !branch || typeof workspace !== 'string' || !workspace)) {
    throw new TypeError('current scope requires explicit branch and workspace filters');
  }
  if (scope === 'task' && (typeof taskId !== 'string' || !taskId)) throw new TypeError('task scope requires a taskId');
  const filters = { taskId: taskId ?? null, branch: scope === 'current' ? branch ?? null : null, workspace: scope === 'current' ? workspace ?? null : null };
  const filter = filterPredicate(filters);
  const matchTerms = mode === 'phrase' ? [normalizedQuery] : terms;
  const match = matchPredicate(matchTerms, mode);
  const any = matchPredicate(terms, 'any');
  const notShadowed = `(d.source <> 'deferred' OR NOT EXISTS (
    SELECT 1 FROM memory_search_documents c WHERE c.project_id = d.project_id
      AND c.source = 'checkpoint' AND c.deferred_item_id = d.source_id))`;
  const visible = `(d.visibility IN ('confirmed', 'queued') AND ${notShadowed})`;
  // Counts include only this project. Diagnostics may report the number of
  // filtered matches, never text/IDs from another task or workspace.
  const count = (where, args) => Number(db.prepare(`SELECT count(*) n FROM memory_search_documents d WHERE d.project_id = ? AND ${where}`).get(projectId, ...args).n);
  const scoped = `${filter.sql} AND ${visible}`;
  const scopedArgs = filter.args;
  const matchedCount = count(`${scoped} AND ${match.sql} AND (d.visibility = 'confirmed' OR ?)`, [...scopedArgs, ...match.args, Number(includeDeferred)]);
  const queuedDeferredCount = count(`${scoped} AND d.visibility = 'queued'`, scopedArgs);
  const queuedMatchCount = count(`${scoped} AND d.visibility = 'queued' AND ${match.sql}`, [...scopedArgs, ...match.args]);
  const scopeFilteredMatches = count(`${visible} AND NOT ${filter.sql} AND ${match.sql}`, [...filter.args, ...match.args]);
  const anyCount = mode === 'any' ? matchedCount : count(`${scoped} AND ${any.sql} AND (d.visibility = 'confirmed' OR ?)`, [...scopedArgs, ...any.args, Number(includeDeferred)]);
  const diagnostics = {
    matchedCount, scopeFilteredMatches, queuedMatchCount,
    conflictCount: count(`${filter.sql} AND d.visibility = 'conflict'`, filter.args),
    discardedCount: count(`${filter.sql} AND d.visibility = 'discarded'`, filter.args),
    unscopedDeferredCount: count(`d.source = 'deferred' AND d.visibility = 'queued' AND ${notShadowed} AND (d.branch IS NULL OR d.workspace IS NULL)` + (taskId ? ' AND d.task_id = ?' : ''), taskId ? [taskId] : []),
    queryModeMismatch: matchedCount === 0 && anyCount > 0,
    deferredExcluded: !includeDeferred,
    limitClamped: parsed.limitClamped,
    message: matchedCount ? 'Historical matches; freshness is unknown. Queued drafts are not confirmed.'
      : 'No matches within these filters; this does not prove nothing was saved. Check queued counts, try mode:any, or explicitly request scope:task/project.',
  };
  // Transparent relevance: distinct term coverage, then exact phrase bonus.
  // Event/time/id/source break all ties, independently of SQLite row order.
  const score = terms.map(() => '(CASE WHEN instr(d.body, ?) > 0 THEN 100 ELSE 0 END)').join(' + ') + ' + (CASE WHEN instr(d.body, ?) > 0 THEN 25 ELSE 0 END)';
  const rows = db.prepare(`SELECT d.*, ${score} AS relevance FROM memory_search_documents d
    WHERE d.project_id = ? AND ${scoped} AND ${match.sql} AND (d.visibility = 'confirmed' OR ?)
    ORDER BY CASE d.visibility WHEN 'confirmed' THEN 0 ELSE 1 END, relevance DESC,
      d.event_seq DESC, d.created_at DESC, d.source_id COLLATE BINARY, d.source COLLATE BINARY LIMIT ?`)
    .all(...terms, normalizedQuery, projectId, ...scopedArgs, ...match.args, Number(includeDeferred), limit);
  const results = rows.map(row => {
    const text = snippet(row.body, terms);
    return {
      id: row.source_id, source: row.source, kind: row.kind,
      taskId: row.task_id, branch: row.branch, workspace: row.workspace,
      eventSeq: row.event_seq, createdAt: row.created_at,
      snippet: text, ...(row.source === 'checkpoint' ? { summary: text } : {}),
      matchedTerms: terms.filter(term => row.body.includes(term)), relevance: row.relevance,
      freshness: 'unknown', visibility: row.visibility,
      synced: row.visibility === 'confirmed', confirmed: row.visibility === 'confirmed',
    };
  });
  const response = {
    ok: true, projectId, scope, filters, mode, normalizedTerms: terms, matchedTerms: [],
    searchedSources: ['checkpoint', 'evidence', 'task-history', ...(includeDeferred ? ['deferred'] : [])],
    queuedDeferredCount, limit, results, groups: { confirmed: 0, queued: 0 }, diagnostics,
    backend: { fts5: true, tokenizer: 'trigram', shortTermFallback: matchTerms.some(term => [...term].length < 3) },
    budget: { maxBytes: MAX_SEARCH_BYTES, bytes: 0, truncated: matchedCount > results.length },
  };
  function updateGroups() {
    response.groups.confirmed = results.filter(row => row.confirmed).length;
    response.groups.queued = results.length - response.groups.confirmed;
    response.matchedTerms = terms.filter(term => results.some(row => row.matchedTerms.includes(term)));
  }
  updateGroups();
  while (measure(response) > MAX_SEARCH_BYTES && results.length) {
    results.pop(); response.budget.truncated = true; updateGroups();
  }
  if (measure(response) > MAX_SEARCH_BYTES) {
    const error = new Error('Search metadata exceeds the response budget; use shorter identifiers or a narrower query');
    error.code = 'SEARCH_RESPONSE_TOO_LARGE'; throw error;
  }
  return response;
}
