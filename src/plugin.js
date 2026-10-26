import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openProjectStore } from './store.js';
import { publicJson, publicCommitResult } from './public-json.js';
import { clipUtf8 } from './participants.js';
import {
  bootstrap as bootstrapOperation,
  checkpoint as checkpointOperation,
  claim as claimOperation,
  discardDeferredCommit as discardDeferredCommitOperation,
  leaseStatus as leaseStatusOperation,
  listDeferredCommits as listDeferredCommitsOperation,
  proposeContractChange as proposeContractChangeOperation,
  readProjectSnapshot,
  search as searchOperation,
  startTask as startTaskOperation,
  useTask as useTaskOperation,
  commit as commitOperation,
  listTasks as listTasksOperation,
  setTaskState as setTaskStateOperation,
  participants as participantsOperation,
  updateProgress as updateProgressOperation,
  completeTask as completeTaskOperation,
  activateSession,
} from './operations.js';

const MARKER_DIR = '.deepseek-memory';
const MARKER_FILE = 'project.json';
const MEMORY_TOOL_PREFIX = 'memory_';
const MAX_RECOVERY_BYTES = 6000;

function json(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeError(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : error instanceof TypeError ? 'INVALID_ARGUMENT' : 'PROJECT_MEMORY_ERROR',
      message: error?.code === 'LEASE_CONFLICT' ? 'Task lease is unavailable or the write token is stale' : error instanceof Error ? error.message : String(error),
      ...Number.isSafeInteger(error?.expectedVersion) ? { expectedVersion: error.expectedVersion } : {},
      ...Number.isSafeInteger(error?.actualVersion) ? { actualVersion: error.actualVersion } : {},
    },
  };
}

function outputDefinition() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: json(value) }];
    },
  };
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function truncateUtf8(value, limit) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let output = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit - 3) break;
    output += character;
    bytes += size;
  }
  return `${output}…`;
}

function recoveryLine(label, value, budget = 850) {
  return `${label}: ${truncateUtf8(value, budget)}`;
}

function renderRecoveryPackage(snapshot) {
  if (!snapshot?.initialized) return '';
  if (snapshot.selectionRequired) {
    const choices = (snapshot.taskCandidates ?? []).map(task => `${task.id} (${task.state}): ${truncateUtf8(task.title, 160)}`).join('; ');
    return [
      'PROJECT MEMORY — historical project state; current user instructions take precedence',
      recoveryLine('Project', snapshot.project.id),
      ...(snapshot.lastBoundTask ? [recoveryLine('Previous task lifecycle', `${snapshot.lastBoundTask.id}: ${snapshot.lastBoundTask.state}`, 300)] : []),
      recoveryLine('Unfinished tasks', choices, 2200),
      'Use memory_use_task to choose one task. Never guess based on ordering.',
    ].join('\n');
  }
  const task = snapshot.task;
  if (!task) return `PROJECT MEMORY — historical project state; current user instructions take precedence\n${recoveryLine('Project', snapshot.project.id, 300)}\nNo unfinished task is selected.${snapshot.lastBoundTask ? `\n${recoveryLine('Previous task lifecycle', `${snapshot.lastBoundTask.id}: ${snapshot.lastBoundTask.state}`, 300)}` : ''}`;
  const checkpoint = snapshot.checkpoint?.payload ?? {};
  const pending = (snapshot.toolOperations ?? []).filter(item => item.status === 'pending' || item.status === 'unknown');
  const current = snapshot.currentParticipant;
  const hasParticipants = (snapshot.participantCount ?? 0) > 0;
  const peers = (snapshot.participants ?? []).filter(row => row.participantId !== current?.participantId).slice(0, 4);
  const parts = [
    'PROJECT MEMORY — historical project state; current user instructions take precedence',
    recoveryLine('Project / Task', `${snapshot.project.id} / ${task.id} (${task.state})`, 300),
    recoveryLine('Task lifecycle', task.state, 50),
    ...(current ? [recoveryLine('Current participant', `${clipUtf8(current.participantId, 128)}; last reported status=${current.status}; presence=${current.presence}; last seen=${current.lastSeenAt}`, 350)] : []),
    recoveryLine('Revisions / workspace / branch / code', `${task.taskVersion}/${task.contractVersion}; ${snapshot.workspaceId}; ${snapshot.branch}; ${snapshot.codeRevision ?? 'unknown'}`, 350),
    recoveryLine('Objective', task.contract?.objective ?? task.title, 650),
    recoveryLine('Confirmed constraints', (task.contract?.constraints ?? []).join(' · ') || 'none', 400),
    recoveryLine('Acceptance status', JSON.stringify(snapshot.acceptanceUpdates ?? task.data?.acceptanceUpdates ?? checkpoint.acceptanceUpdates ?? task.contract?.acceptanceCriteria ?? []), 600),
    recoveryLine('Current state', current ? current.summary || 'No progress recorded for this participant' : hasParticipants ? 'No progress recorded for this session' : checkpoint.summary ?? task.data?.progress ?? 'No confirmed checkpoint yet', 600),
    recoveryLine('Pending or unknown external operations', pending.map(item => `${item.toolName} (${item.status})`).join(', ') || 'none', 250),
    recoveryLine('Next action', current ? current.nextAction ?? 'Review your own progress.' : hasParticipants ? 'Choose your own next action.' : checkpoint.nextAction ?? task.data?.nextAction ?? 'Review current work and commit evidence-backed progress.', 400),
    recoveryLine('Latest confirmed checkpoint (historical, not another session current state)', `${checkpoint.summary ?? 'none'}; historical next action=${checkpoint.nextAction ?? 'none'}`, 350),
    recoveryLine('Last checkpoint / evidence references', `${snapshot.checkpoint?.id ?? 'none'} / ${(checkpoint.evidenceRefs ?? []).join(', ') || 'none'}`, 250),
  ];
  const footer = 'Conflict/write rule: use memory_commit for shared confirmed evidence; memory_update_progress for your own progress; memory_complete_task for task completion. Use memory_search for history.';
  const render = () => [...parts,
    'Other participants — last reported progress; stale/inactive/disposed do not mean currently working:',
    ...peers.map(row => recoveryLine(clipUtf8(row.participantId, 96), `status=${row.status}; presence=${row.presence}; ${row.summary || 'no summary'}`, 160)),
    ...(snapshot.participantCount > peers.length + (current ? 1 : 0) ? ['Additional participant history omitted; use memory_participants for a bounded overview.'] : []), footer].join('\n');
  // Remove complete peer rows in reverse priority. Field budgets keep self,
  // lifecycle and guidance within the cap even when no peer rows remain.
  while (Buffer.byteLength(render()) > MAX_RECOVERY_BYTES && peers.length) peers.pop();
  return render();
}

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, MARKER_DIR, MARKER_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitHead(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  if (!fs.existsSync(dotGit)) return { branch: 'no-git', codeRevision: null };
  let gitDirectory = dotGit;
  const stat = fs.statSync(dotGit);
  if (stat.isFile()) {
    const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return { branch: 'unknown', codeRevision: null };
    gitDirectory = path.resolve(projectRoot, match[1].trim());
  }
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return { branch: `detached:${head.slice(0, 12)}`, codeRevision: head };
  const ref = head.slice(5);
  const looseRef = path.join(gitDirectory, ...ref.split('/'));
  let codeRevision = fs.existsSync(looseRef) ? fs.readFileSync(looseRef, 'utf8').trim() : null;
  if (codeRevision === null) {
    const packed = path.join(gitDirectory, 'packed-refs');
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, 'utf8').split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
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
  let canonical;
  try { canonical = fs.realpathSync.native(projectRoot).toLowerCase(); } catch { canonical = path.resolve(projectRoot).toLowerCase(); }
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return { workspaceId: `local:${digest}`, ...git };
}

function validateString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

class AgentMemoryBinding {
  constructor(agent, cwd, options = {}) {
    this.agent = agent;
    this.cwd = path.resolve(cwd);
    this.projectRoot = null;
    this.store = null;
    this.projectId = null;
    this.taskId = null;
    this.lease = null;
    this.leases = new Map();
    this.instanceId = randomUUID();
    this.clock = options.clock ?? Date.now;
    this.source = options.source ?? 'unknown';
    this.parentSessionId = agent.session?.header?.id === String(agent.id) && typeof agent.session.header.parentSession === 'string'
      ? agent.session.header.parentSession : undefined;
    this.refresh(false);
  }

  activate() {
    const result = activateSession({ cwd: this.cwd, sessionId: String(this.agent.id), instanceId: this.instanceId,
      source: this.source, parentSessionId: this.parentSessionId, now: this.clock() });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    if (result.taskId) this.taskId = result.taskId;
  }

  refresh(create) {
    const root = findProjectRoot(this.cwd) ?? (create ? this.cwd : null);
    if (root === null) return false;
    if (this.projectRoot === root && this.store !== null) return true;
    this.close('detached');
    this.projectRoot = root;
    this.store = openProjectStore(root);
    this.projectId = this.store.project.id;
    // Task selection is session-bound in v0.3.  Do not recover an arbitrary
    // active task merely because it happens to be first in SQLite order.
    this.taskId = null;
    return true;
  }

  requireBound() {
    if (!this.refresh(false)) {
      const error = new Error(`No ${MARKER_DIR}/${MARKER_FILE} marker was found from ${this.cwd}; call memory_bootstrap first`);
      error.code = 'PROJECT_MEMORY_NOT_INITIALIZED';
      throw error;
    }
  }

  facts() {
    this.requireBound();
    return workspaceFacts(this.projectRoot, this.cwd);
  }

  bootstrap(args) {
    const sharedResult = bootstrapOperation({
      sessionId: String(this.agent.id),
      cwd: this.cwd,
      taskId: args.task_id,
      objective: args.objective,
      acceptanceCriteria: args.acceptance_criteria ?? [],
      constraints: args.constraints ?? [],
      nextAction: args.next_action ?? null,
      sourceRef: args.source_ref ?? `session:${this.agent.id}`,
      idempotencyKey: args.idempotency_key,
    });
    if (sharedResult.ok) {
      this.refresh(false);
      this.taskId = sharedResult.task.id;
      this.activate();
    }
    return sharedResult;

    /* Legacy inline implementation retained below for source compatibility; unreachable. */
    this.refresh(true);
    const taskId = validateString(args.task_id, 'task_id');
    const facts = this.facts();
    let task = this.store.getTask(this.projectId, taskId);
    if (task === null) {
      task = this.store.createTask({
        projectId: this.projectId,
        id: taskId,
        title: validateString(args.objective, 'objective'),
        state: 'active',
        data: { nextAction: args.next_action ?? null, blockers: [] },
        contract: {
          objective: args.objective,
          acceptanceCriteria: args.acceptance_criteria ?? [],
          constraints: args.constraints ?? [],
          confirmed: true,
          sourceRef: args.source_ref ?? `session:${this.agent.id}`,
        },
        branch: facts.branch,
        workspace: facts.workspaceId,
        idempotencyKey: args.idempotency_key,
      }).task;
    }
    this.taskId = taskId;
    return { ok: true, projectId: this.projectId, projectRoot: this.projectRoot, task, ...facts };
  }

  startTask(args) {
    const result = startTaskOperation({
      cwd: this.cwd,
      sessionId: String(this.agent.id),
      objective: args.objective,
      acceptanceCriteria: args.acceptance_criteria ?? [],
      constraints: args.constraints ?? [],
      nextAction: args.next_action ?? null,
      sourceRef: args.source_ref ?? `session:${this.agent.id}`,
      idempotencyKey: args.idempotency_key,
    });
    if (result.ok) { this.refresh(false); this.taskId = result.task.id; this.activate(); }
    return result;
  }

  useTask(args) {
    const result = useTaskOperation({ cwd: this.cwd, sessionId: String(this.agent.id), taskId: args.task_id });
    if (result.ok) { this.refresh(false); this.taskId = result.task.id; this.activate(); }
    return result;
  }

  async commit(args) {
    const result = await commitOperation({
      instanceId: this.instanceId,
      now: this.clock(),
      cwd: this.cwd,
      sessionId: String(this.agent.id),
      progress: args.progress,
      nextAction: args.next_action,
      blockers: args.blockers,
      acceptanceUpdates: args.acceptance_updates,
      evidenceRefs: args.evidence_refs,
      state: args.state,
      idempotencyKey: args.idempotency_key,
    });
    if (result.ok) {
      this.taskId = result.taskId;
      // Remember the lease we now hold so a normal dispose can release it;
      // a crashed process still falls back to the TTL.
      if (result.synced && result.lease) { this.lease = result.lease; this.leases.set(result.taskId, result.lease); }
      if (args.state === 'completed') { this.lease = null; this.leases.delete(result.taskId); }
    }
    return result;
  }

  leaseStatus(args) {
    return leaseStatusOperation({
      cwd: this.cwd,
      taskId: args.task_id ?? this.taskId ?? undefined,
      sessionId: String(this.agent.id),
    });
  }

  updateProgress(args) {
    return updateProgressOperation({ cwd: this.cwd, sessionId: String(this.agent.id), instanceId: this.instanceId,
      summary: args.summary, status: args.status, nextAction: args.next_action, blockers: args.blockers,
      expectedVersion: args.expected_version, idempotencyKey: args.idempotency_key, now: this.clock() });
  }

  participants() {
    return participantsOperation({ cwd: this.cwd, sessionId: String(this.agent.id), now: this.clock() });
  }

  completeTask(args) {
    const result = completeTaskOperation({ cwd: this.cwd, sessionId: String(this.agent.id), instanceId: this.instanceId,
      summary: args.summary, evidenceRefs: args.evidence_refs, idempotencyKey: args.idempotency_key, now: this.clock() });
    if (result.ok) { this.lease = null; this.leases.delete(result.taskId); }
    return result;
  }

  deferredCommits(args) {
    return listDeferredCommitsOperation({
      cwd: this.cwd,
      taskId: args.task_id ?? this.taskId ?? undefined,
      sessionId: String(this.agent.id),
    });
  }

  discardDeferredCommit(args) {
    return discardDeferredCommitOperation({
      cwd: this.cwd,
      id: args.id,
      sessionId: String(this.agent.id),
    });
  }

  listTasks() {
    return listTasksOperation({ cwd: this.cwd });
  }

  setTaskState(args) {
    return setTaskStateOperation({
      cwd: this.cwd,
      taskId: args.task_id,
      state: args.state,
      expectedRevision: args.expected_revision,
      owner: `project-memory:${this.agent.id}`,
    });
  }

  read(args) {
    const sharedResult = readProjectSnapshot({
      cwd: this.cwd,
      taskId: args.task_id ?? undefined,
      sessionId: String(this.agent.id),
      sinceEventSeq: args.since_event_seq ?? 0,
    });
    if (sharedResult.ok && sharedResult.initialized && sharedResult.task !== null) {
      this.refresh(false);
      this.taskId = sharedResult.task.id;
    }
    return sharedResult;

    /* Legacy inline implementation retained below for source compatibility; unreachable. */
    this.requireBound();
    const taskId = args.task_id ?? this.taskId;
    validateString(taskId, 'task_id');
    const task = this.store.getTask(this.projectId, taskId);
    if (task === null) {
      const error = new Error(`Task ${taskId} was not found in the bound project`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    this.taskId = taskId;
    const facts = this.facts();
    return {
      ok: true,
      projectId: this.projectId,
      task,
      checkpoint: this.store.latestCheckpoint(this.projectId, { taskId, branch: facts.branch, workspace: facts.workspaceId }),
      evidence: this.store.listEvidence({ projectId: this.projectId, taskId, branch: facts.branch, workspace: facts.workspaceId }),
      recentEvents: this.store.listEvents(this.projectId, { afterSeq: args.since_event_seq ?? 0, limit: 100 }),
      ...facts,
    };
  }

  claim(args) {
    const sharedResult = claimOperation({
      cwd: this.cwd,
      taskId: args.task_id ?? this.taskId ?? undefined,
      expectedRevision: args.expected_revision,
      owner: String(this.agent.id),
      leaseSeconds: args.lease_seconds ?? 300,
    });
    if (sharedResult.ok) {
      this.taskId = sharedResult.taskId;
      this.lease = sharedResult.leaseToken;
      this.leases.set(sharedResult.taskId, sharedResult.leaseToken);
    }
    return sharedResult;

    /* Legacy inline implementation retained below for source compatibility; unreachable. */
    this.requireBound();
    const taskId = args.task_id ?? this.taskId;
    validateString(taskId, 'task_id');
    const current = this.store.getTask(this.projectId, taskId);
    if (current === null) {
      const error = new Error(`Task ${taskId} was not found`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    if (current.taskVersion !== args.expected_revision) {
      const error = new Error('Task version changed before the lease claim');
      error.code = 'TASK_REVISION_CONFLICT';
      error.expectedVersion = args.expected_revision;
      error.actualVersion = current.taskVersion;
      throw error;
    }
    this.lease = this.store.claimTask({
      projectId: this.projectId,
      taskId,
      owner: String(this.agent.id),
      ttlMs: (args.lease_seconds ?? 300) * 1000,
    });
    this.taskId = taskId;
    return { ok: true, taskId, leaseToken: this.lease, taskRevision: current.taskVersion, contractRevision: current.contractVersion };
  }

  checkpoint(args) {
    const sharedResult = checkpointOperation({
      cwd: this.cwd,
      taskId: args.task_id ?? this.taskId ?? undefined,
      expectedRevision: args.expected_revision,
      expectedContractRevision: args.expected_contract_revision,
      owner: String(this.agent.id),
      leaseToken: args.lease_token,
      patch: args.patch ?? {},
      evidence: args.evidence ?? [],
      summary: args.summary ?? '',
      nextAction: args.next_action ?? null,
      pendingOperations: args.pending_operations ?? [],
      idempotencyKey: args.idempotency_key,
    });
    if (sharedResult.ok) this.taskId = sharedResult.taskId;
    return sharedResult;

    /* Legacy inline implementation retained below for source compatibility; unreachable. */
    this.requireBound();
    const taskId = args.task_id ?? this.taskId;
    validateString(taskId, 'task_id');
    if (this.lease === null || this.lease.fence !== args.lease_token) {
      const error = new Error('The checkpoint lease token is missing or stale for this session');
      error.code = 'LEASE_CONFLICT';
      throw error;
    }
    const facts = this.facts();
    const result = this.store.commitCheckpoint({
      projectId: this.projectId,
      taskId,
      expectedTaskVersion: args.expected_revision,
      expectedContractVersion: args.expected_contract_revision,
      lease: { owner: String(this.agent.id), fence: args.lease_token },
      taskPatch: args.patch ?? {},
      evidence: (args.evidence ?? []).map((item) => ({
        kind: item.kind ?? 'verification',
        payload: { ...item, codeRevision: facts.codeRevision },
      })),
      checkpointPayload: {
        summary: args.summary ?? '',
        nextAction: args.next_action ?? null,
        pendingOperations: args.pending_operations ?? [],
        sessionId: String(this.agent.id),
        codeRevision: facts.codeRevision,
      },
      branch: facts.branch,
      workspace: facts.workspaceId,
      idempotencyKey: args.idempotency_key,
    });
    this.taskId = taskId;
    return { ok: true, ...result };
  }

  search(args) {
    return searchOperation({
      cwd: this.cwd,
      sessionId: String(this.agent.id),
      taskId: args.task_id,
      query: args.query,
      mode: args.mode,
      scope: args.scope,
      includeDeferred: args.include_deferred,
      limit: args.limit,
    });
  }

  proposeContractChange(args) {
    return proposeContractChangeOperation({
      cwd: this.cwd,
      taskId: args.task_id ?? this.taskId ?? undefined,
      expectedContractRevision: args.expected_contract_revision,
      diff: args.diff,
      sourceRef: args.source_ref,
      idempotencyKey: args.idempotency_key,
      owner: String(this.agent.id),
    });

    /* Legacy inline implementation retained below for source compatibility; unreachable. */
    this.requireBound();
    const taskId = args.task_id ?? this.taskId;
    validateString(taskId, 'task_id');
    const task = this.store.getTask(this.projectId, taskId);
    if (task === null) {
      const error = new Error(`Task ${taskId} was not found`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    if (task.contractVersion !== args.expected_contract_revision) {
      const error = new Error('Contract version changed before the proposal');
      error.code = 'CONTRACT_REVISION_CONFLICT';
      error.expectedVersion = args.expected_contract_revision;
      error.actualVersion = task.contractVersion;
      throw error;
    }
    const event = this.store.appendEvent({
      projectId: this.projectId,
      taskId,
      type: 'contract.change-proposed',
      payload: {
        proposal: args.diff,
        sourceRef: args.source_ref,
        expectedContractRevision: args.expected_contract_revision,
        status: 'candidate',
        sessionId: String(this.agent.id),
      },
      idempotencyKey: args.idempotency_key,
    });
    return { ok: true, status: 'candidate', contractRevision: task.contractVersion, event };
  }

  propose(args) {
    const snapshot = readProjectSnapshot({ cwd: this.cwd, taskId: args.task_id, sessionId: String(this.agent.id) });
    if (!snapshot.ok) return snapshot;
    if (!snapshot.task) return { ok: false, error: { code: 'TASK_SELECTION_REQUIRED', message: 'Choose a task before proposing a contract change.' } };
    return proposeContractChangeOperation({
      cwd: this.cwd,
      taskId: snapshot.task.id,
      expectedContractRevision: args.expected_contract_revision ?? snapshot.task.contractVersion,
      diff: args.diff,
      sourceRef: args.source_ref,
      idempotencyKey: args.idempotency_key,
    });
  }

  recoveryText() {
    return renderRecoveryPackage(readProjectSnapshot({ cwd: this.cwd, sessionId: String(this.agent.id), now: this.clock() }));
  }

  recordToolPending(exec) {
    if (exec.name.startsWith(MEMORY_TOOL_PREFIX)) return;
    const snapshot = readProjectSnapshot({ cwd: this.cwd, sessionId: String(this.agent.id) });
    if (!snapshot.ok || !snapshot.task || !this.refresh(false)) return;
    this.taskId = snapshot.task.id;
    this.store.beginToolOperation({ callId: String(exec.callId), sessionId: String(this.agent.id), taskId: this.taskId, toolName: String(exec.name) });
  }

  recordToolResult(exec, result) {
    if (exec.name.startsWith(MEMORY_TOOL_PREFIX) || !this.refresh(false)) return;
    const summary = result?.isError
      ? { error: truncateUtf8(result?.error?.message ?? result?.error ?? 'tool failed', 500) }
      : { result: truncateUtf8(result?.content?.[0]?.text ?? result?.summary ?? 'completed', 500) };
    this.store.finishToolOperation({ callId: String(exec.callId), status: result?.isError ? 'failed' : 'succeeded', resultSummary: summary });
  }

  close(reason = 'disposed') {
    if (this.store && this.projectId) {
      // Best-effort release on normal dispose; `agent/disposed` listeners are
      // not awaited by the Host, and a crash still relies on the lease TTL.
      try { this.store.deactivateParticipants({ projectId: this.projectId, sessionId: String(this.agent.id), workspace: this.facts().workspaceId,
        instanceId: this.instanceId, reason, releaseOwnLease: true, now: this.clock() }); } catch { /* best-effort disposal */ }
      for (const [taskId, lease] of this.leases) {
        try {
          const participant = this.store.getParticipant({ projectId: this.projectId, taskId, participantId: String(this.agent.id) });
          if (participant && participant.instanceId !== this.instanceId) continue;
          this.store.releaseLease({ projectId: this.projectId, taskId, owner: lease.owner, fence: lease.fence });
        } catch { /* already moved on */ }
      }
    }
    if (this.store && this.taskId) {
      try { this.store.markPendingOperationsUnknown({ sessionId: String(this.agent.id), taskId: this.taskId }); } catch { /* shutdown must not throw */ }
    }
    this.store?.close();
    this.store = null;
    this.projectId = null;
    this.projectRoot = null;
    this.lease = null;
    this.leases.clear();
  }
}

const definitions = [
  { name: 'memory_update_progress', method: 'updateProgress', description: 'Update only this session participant. working/waiting/blocked/done describe participant progress, never task lifecycle. Optional expected_version checks this participant CAS revision; use memory_complete_task for task completion.', parameters: objectSchema({ summary: { type: 'string' }, status: { type: 'string', enum: ['working', 'waiting', 'blocked', 'done'] }, next_action: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } }, expected_version: { type: 'integer', minimum: 0 }, idempotency_key: { type: 'string' } }) },
  { name: 'memory_participants', method: 'participants', description: 'Read bounded participant progress for the selected task in this branch/workspace. Self is first. Stale, inactive and disposed reports are historical and do not mean another Agent is currently working. This does not send a message or wake another session.', parameters: objectSchema({}) },
  { name: 'memory_complete_task', method: 'completeTask', description: 'Explicitly complete task lifecycle, record a terminal checkpoint and release this session lease. Queued/conflict drafts or another session live lease block completion; review/flush/discard drafts or wait and retry. Participant done/dispose does not complete a task. No force option.', parameters: objectSchema({ summary: { type: 'string', minLength: 1 }, evidence_refs: { type: 'array', items: { type: 'string' } }, idempotency_key: { type: 'string' } }, ['summary']) },
  { name: 'memory_start_task', method: 'startTask', description: 'Start a confirmed long-running task. The Host creates its id and binding.', parameters: objectSchema({ objective: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, next_action: { type: 'string' }, source_ref: { type: 'string' }, idempotency_key: { type: 'string' } }, ['objective']) },
  { name: 'memory_use_task', method: 'useTask', description: 'Explicitly select one task for this session.', parameters: objectSchema({ task_id: { type: 'string' } }, ['task_id']) },
  { name: 'memory_commit', method: 'commit', description: 'Save progress for the selected task. Strict fields (state, next_action, blockers) are rejected readably while another session holds the lease; independent appends (evidence, observations) defer into a durable queue that the next lease holder flushes.', parameters: objectSchema({ progress: { type: 'string' }, next_action: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } }, acceptance_updates: { type: 'array', items: { type: 'object', additionalProperties: true } }, evidence_refs: { type: 'array', items: { type: 'string' } }, state: { type: 'string' }, idempotency_key: { type: 'string' } }) },
  { name: 'memory_lease_status', method: 'leaseStatus', description: 'Read the save state of the selected task: who holds the write lease, how long until a retry is possible. No fence or raw timestamps in the normal output.', parameters: objectSchema({ task_id: { type: 'string' } }) },
  { name: 'memory_deferred_list', method: 'deferredCommits', description: 'List deferred (unsynced) drafts for the selected task, including queued/conflict/flushed status.', parameters: objectSchema({ task_id: { type: 'string' } }) },
  { name: 'memory_deferred_discard', method: 'discardDeferredCommit', description: 'Discard one of this session\'s queued drafts so it is never flushed.', parameters: objectSchema({ id: { type: 'string' } }, ['id']) },
  { name: 'memory_search', method: 'search', description: 'Search historical checkpoint, evidence, task history and queued drafts. current keeps the selected task and current branch/workspace; task searches one task across workspaces; project must be explicit. any matches any normalized term, all requires all terms, phrase requires their literal order. Queued results are unconfirmed; freshness is unknown.', parameters: objectSchema({ query: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['any', 'all', 'phrase'] }, scope: { type: 'string', enum: ['current', 'task', 'project'] }, task_id: { type: 'string' }, include_deferred: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']) },
  { name: 'memory_propose_contract_change', method: 'propose', description: 'Propose a contract change for later user acceptance or rejection.', parameters: objectSchema({ task_id: { type: 'string' }, diff: { type: 'object', additionalProperties: true }, source_ref: { type: 'string' }, idempotency_key: { type: 'string' } }, ['diff', 'source_ref']) },
];
const adminDefinitions = [
  { name: 'memory_list_tasks', method: 'listTasks', description: 'List tasks for administration.', parameters: objectSchema({}) },
  { name: 'memory_set_task_state', method: 'setTaskState', description: 'Pause, complete, or archive a task.', parameters: objectSchema({ task_id: { type: 'string' }, state: { type: 'string' }, expected_revision: { type: 'integer' } }, ['task_id', 'state']) },
];
const compatibilityDefinitions = [
  { name: 'memory_bootstrap', method: 'bootstrap', description: 'Compatibility bootstrap tool.', parameters: objectSchema({ task_id: { type: 'string' }, objective: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, next_action: { type: 'string' }, source_ref: { type: 'string' }, idempotency_key: { type: 'string' } }, ['task_id', 'objective', 'acceptance_criteria']) },
  { name: 'memory_read', method: 'read', description: 'Compatibility read tool.', parameters: objectSchema({ task_id: { type: 'string' } }) },
  { name: 'memory_claim', method: 'claim', description: 'Compatibility lease tool.', parameters: objectSchema({ task_id: { type: 'string' }, expected_revision: { type: 'integer' }, lease_seconds: { type: 'integer' } }, ['expected_revision']) },
  { name: 'memory_checkpoint', method: 'checkpoint', description: 'Compatibility checkpoint tool.', parameters: objectSchema({ task_id: { type: 'string' }, expected_revision: { type: 'integer' }, expected_contract_revision: { type: 'integer' }, lease_token: { type: 'integer' }, patch: { type: 'object', additionalProperties: true }, evidence: { type: 'array', items: { type: 'object', additionalProperties: true } }, summary: { type: 'string' }, next_action: { type: 'string' }, pending_operations: { type: 'array', items: { type: 'string' } }, idempotency_key: { type: 'string' } }, ['expected_revision', 'expected_contract_revision', 'lease_token', 'idempotency_key']) },
];

// Direct registration is retained for the v0.2 test harness; runtime `apply()`
// passes an explicit config object, where compatibility tools are off by default.
function registerAgent(agent, cwd, logger, options = { compatibilityTools: true }) {
  const binding = new AgentMemoryBinding(agent, cwd, options);
  binding.activate();
  const disposers = [];
  disposers.push(agent.ctx.systemPrompt.context({
    name: 'project-memory:recovery',
    order: agent.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 1,
    required: true,
    interpolate: false,
    text: () => binding.recoveryText(),
  }));
  for (const definition of [...definitions, ...(options.adminTools ? adminDefinitions : []), ...(options.compatibilityTools ? compatibilityDefinitions : [])]) {
    disposers.push(agent.ctx.tools.register({
      name: definition.name,
      description: definition.description + (definition.name === 'memory_commit' ? ' Its state field is task lifecycle, never participant status. Use memory_update_progress for independent session progress and prefer memory_complete_task to finish a task.' : ''),
      parameters: definition.parameters,
      output: outputDefinition(),
      async execute(args) {
        try {
          // ToolRuntime.execute may be called directly without validating the
          // advertised input schema. Enforce the new ownership-sensitive
          // contracts here as well, including the absence of a force option.
          if (['memory_update_progress', 'memory_participants', 'memory_complete_task'].includes(definition.name)) {
            const value = args ?? {};
            if (typeof value !== 'object' || Array.isArray(value)
              || Object.keys(value).some(key => !Object.hasOwn(definition.parameters.properties, key))) throw new TypeError('Unknown or invalid participant tool arguments');
          }
          const result = publicJson(await binding[definition.method](args ?? {}));
          return publicJson(definition.name === 'memory_commit' ? publicCommitResult(result) : result);
        } catch (error) {
          logger.warn(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
          return publicJson(normalizeError(error));
        }
      },
      isConcurrencySafe: () => ['memory_search', 'memory_list_tasks', 'memory_lease_status', 'memory_deferred_list', 'memory_participants'].includes(definition.name),
    }));
  }
  disposers.push(agent.ctx.on('tools/pre-execute', async (exec, next) => {
    try { binding.recordToolPending(exec); } catch (error) { logger.warn(`pending tool record failed: ${error.message}`); }
    return next();
  }));
  disposers.push(agent.ctx.on('tools/result', (exec, result) => {
    try { binding.recordToolResult(exec, result); } catch (error) { logger.warn(`tool result record failed: ${error.message}`); }
  }));
  return async (reason = 'disposed') => {
    for (const dispose of disposers.reverse()) await dispose();
    binding.close(reason);
  };
}

export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

export function apply(ctx) {
  const logger = ctx.logger;
  ctx.effect(() => {
    const agentDisposers = new Map();
    ctx.on('agent/created', async ({ agent, signal, source }) => {
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      // `config` is not a guaranteed injectable Host service in Harness
      // 0.2.1-rc.3.  Reading it here prevents session creation entirely.
      // Keep compatibility tools opt-in for direct/test registration only.
      const dispose = registerAgent(agent, cwd, logger, { source });
      agentDisposers.set(agent, dispose);
    });
    ctx.on('agent/disposed', ({ agent }) => {
      const dispose = agentDisposers.get(agent);
      agentDisposers.delete(agent);
      if (dispose) void dispose();
    });
    return async () => {
      await Promise.allSettled([...agentDisposers.values()].map((dispose) => dispose('plugin-unloaded')));
      agentDisposers.clear();
    };
  });
}

export { AgentMemoryBinding, findProjectRoot, readGitHead, workspaceFacts, definitions, registerAgent, renderRecoveryPackage };
