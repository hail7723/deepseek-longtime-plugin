import path from 'node:path';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { apply as applyAgentMemory } from './plugin.js';
import {
  bootstrap as bootstrapOperation,
  checkpoint as checkpointOperation,
  claim as claimOperation,
  commit as commitOperation,
  discardDeferredCommit as discardDeferredCommitOperation,
  leaseStatus as leaseStatusOperation,
  listDeferredCommits as listDeferredCommitsOperation,
  listTasks as listTasksOperation,
  proposeContractChange as proposeContractChangeOperation,
  readProjectSnapshot,
  search as searchOperation,
  setTaskState as setTaskStateOperation,
  startTask as startTaskOperation,
  useTask as useTaskOperation,
  participants as participantsOperation,
  updateProgress as updateProgressOperation,
  completeTask as completeTaskOperation,
} from './operations.js';

const remoteInitializers = [];

function normalizedCwd(request) {
  const value = typeof request?.cwd === 'string' ? request.cwd.trim() : '';
  if (value !== '') return path.resolve(value);
  const error = new Error('No active workspace is available; open the panel from a conversation with a working directory.');
  error.code = 'WORKSPACE_UNAVAILABLE';
  throw error;
}

function uiOwner(cwd) {
  return `project-memory-ui:${cwd.toLowerCase()}`;
}

// The v0.3 panel flow is session-bound; the Client must pass its current
// conversation's id explicitly instead of relying on process-wide state.
function requireSessionId(request) {
  const sessionId = request.session_id ?? request.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    const error = new Error('session_id is required; open the panel from a conversation so the Client can pass its session id');
    error.code = 'SESSION_REQUIRED';
    throw error;
  }
  return sessionId;
}

function presentSnapshot(snapshot, lease) {
  if (!snapshot?.ok || !snapshot.initialized) return snapshot;
  const task = snapshot.task;
  const events = snapshot.recentEvents ?? [];
  const contractCandidates = snapshot.contractCandidates ?? events
    .filter((event) => event.type === 'contract.change-proposed' && event.payload?.status === 'candidate' && event.taskId === task?.id)
    .map((event) => ({
      id: event.seq,
      eventSeq: event.seq,
      createdAt: event.createdAt,
      ...event.payload,
    }));
  return {
    ...snapshot,
    projectId: snapshot.project?.id,
    eventSeq: snapshot.project?.eventSeq,
    task: task === null ? null : {
      ...task,
      objective: task.contract?.objective ?? task.title,
      acceptanceCriteria: task.contract?.acceptanceCriteria ?? [],
      nextAction: snapshot.currentParticipant ? snapshot.currentParticipant.nextAction
        : (snapshot.participantCount ?? 0) > 0 ? null : task.data?.nextAction ?? snapshot.checkpoint?.payload?.nextAction ?? null,
      ...(lease === undefined ? {} : { leaseToken: lease.fence }),
    },
    contract: task?.contract ?? null,
    taskRevision: task?.taskVersion ?? null,
    contractRevision: task?.contractVersion ?? null,
    pendingOperations: snapshot.checkpoint?.payload?.pendingOperations ?? [],
    contractCandidates,
    events,
  };
}

class ProjectMemoryRemoteService extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'workingDirectory'];

  constructor(ctx) {
    super(ctx, 'projectMemory');
    for (const initialize of remoteInitializers) initialize.call(this);
    this.leases = new Map();
    this.workspaces = new Map();
    // Keep the workspace on the agent it belongs to.  This intentionally
    // replaces the old process-wide `lastCwd`, which could leak a directory
    // from another window into this panel.
    ctx.on('agent/created', async ({ agent, signal }) => {
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      this.workspaces.set(String(agent.id), path.resolve(cwd));
    });
    ctx.on('agent/disposed', ({ agent }) => this.workspaces.delete(String(agent.id)));
    applyAgentMemory(ctx);
  }

  // No default parameter: the gateway derives the wire signature from the
  // function's arity, and a default would register a zero-argument endpoint
  // that rejects the client's `request` argument.
  workspace(request) {
    request ??= {};
    const sessionId = request.session_id ?? request.sessionId;
    if (sessionId !== undefined) {
      const cwd = this.workspaces.get(String(sessionId));
      return cwd ? { ok: true, cwd, sessionId: String(sessionId) } : { ok: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: 'The selected conversation has no active working directory.' } };
    }
    const candidates = [...this.workspaces.entries()].map(([id, cwd]) => ({ sessionId: id, cwd }));
    if (candidates.length === 1) return { ok: true, ...candidates[0] };
    return {
      ok: false,
      error: {
        code: candidates.length === 0 ? 'WORKSPACE_UNAVAILABLE' : 'WORKSPACE_SELECTION_REQUIRED',
        message: candidates.length === 0
          ? 'No active conversation has a working directory yet; start or select a project conversation, then refresh.'
          : 'More than one active workspace exists; the panel shows an explicit picker.',
      },
      candidates,
    };
  }

  snapshot(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    const taskId = request.task_id ?? request.taskId;
    const sessionId = request.session_id ?? request.sessionId;
    const snapshot = readProjectSnapshot({
      cwd,
      taskId,
      // A Client session id makes the snapshot binding-aware; the legacy
      // panel flow falls back to the UI lease owner's perspective.
      ...(sessionId === undefined ? {} : { sessionId }),
      owner: uiOwner(cwd),
      sinceEventSeq: request.since_event_seq ?? request.sinceEventSeq ?? 0,
      eventLimit: request.event_limit ?? request.eventLimit ?? 100,
    });
    return presentSnapshot(snapshot, this.leases.get(`${cwd}\0${taskId ?? snapshot.task?.id ?? ''}`));
  }

  // v0.3 panel flow: session-bound task selection, host-managed commits.
  startTask(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    const sessionId = requireSessionId(request);
    return startTaskOperation({
      cwd,
      sessionId,
      objective: request.objective,
      acceptanceCriteria: request.acceptance_criteria ?? request.acceptanceCriteria ?? [],
      constraints: request.constraints ?? [],
      nextAction: request.next_action ?? request.nextAction ?? null,
      sourceRef: request.source_ref ?? request.sourceRef ?? 'project-memory-ui',
      idempotencyKey: request.idempotency_key ?? request.idempotencyKey,
    });
  }

  useTask(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return useTaskOperation({
      cwd,
      sessionId: requireSessionId(request),
      taskId: request.task_id ?? request.taskId,
    });
  }

  listTasks(request) {
    request ??= {};
    return listTasksOperation({ cwd: normalizedCwd(request) });
  }

  setTaskState(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return setTaskStateOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
      state: request.state,
      expectedRevision: request.expected_revision ?? request.expectedRevision,
      owner: uiOwner(cwd),
    });
  }

  async commit(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return commitOperation({
      cwd,
      sessionId: requireSessionId(request),
      progress: request.progress,
      nextAction: request.next_action ?? request.nextAction,
      blockers: request.blockers,
      acceptanceUpdates: Object.hasOwn(request, 'acceptance_updates') ? request.acceptance_updates : request.acceptanceUpdates,
      evidenceRefs: request.evidence_refs ?? request.evidenceRefs,
      state: request.state,
      idempotencyKey: request.idempotency_key ?? request.idempotencyKey,
    });
  }

  participants(request) {
    request ??= {};
    return participantsOperation({ cwd: normalizedCwd(request), sessionId: requireSessionId(request) });
  }

  updateProgress(request) {
    request ??= {};
    return updateProgressOperation({ cwd: normalizedCwd(request), sessionId: requireSessionId(request), summary: request.summary,
      status: request.status, nextAction: request.next_action ?? request.nextAction, blockers: request.blockers,
      expectedVersion: request.expected_version ?? request.expectedVersion, idempotencyKey: request.idempotency_key ?? request.idempotencyKey });
  }

  completeTask(request) {
    request ??= {};
    return completeTaskOperation({ cwd: normalizedCwd(request), sessionId: requireSessionId(request), summary: request.summary,
      evidenceRefs: request.evidence_refs ?? request.evidenceRefs, idempotencyKey: request.idempotency_key ?? request.idempotencyKey });
  }

  leaseStatus(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return leaseStatusOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
      // The Remote layer authenticates nothing; the viewer is the panel itself.
      sessionId: `ui:${cwd.toLowerCase()}`,
      owner: uiOwner(cwd),
    });
  }

  deferred(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return listDeferredCommitsOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
    });
  }

  discardDeferred(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return discardDeferredCommitOperation({
      cwd,
      id: request.id,
    });
  }

  bootstrap(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    const result = bootstrapOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
      objective: request.objective,
      acceptanceCriteria: request.acceptance_criteria ?? request.acceptanceCriteria ?? [],
      constraints: request.constraints ?? [],
      nextAction: request.next_action ?? request.nextAction ?? null,
      sourceRef: request.source_ref ?? request.sourceRef ?? 'project-memory-ui',
      idempotencyKey: request.idempotency_key ?? request.idempotencyKey,
    });
    return result;
  }

  claim(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    const taskId = request.task_id ?? request.taskId;
    const result = claimOperation({
      cwd,
      taskId,
      expectedRevision: request.expected_revision ?? request.expectedRevision,
      owner: uiOwner(cwd),
      leaseSeconds: request.lease_seconds ?? request.leaseSeconds ?? 300,
    });
    if (result.ok) {
      this.leases.set(`${cwd}\0${result.taskId}`, result.leaseToken);
    }
    return result;
  }

  checkpoint(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    const taskId = request.task_id ?? request.taskId;
    const key = `${cwd}\0${taskId ?? ''}`;
    const cachedLease = this.leases.get(key);
    const leaseToken = request.lease_token ?? request.leaseToken ?? cachedLease?.fence;
    const result = checkpointOperation({
      cwd,
      taskId,
      expectedRevision: request.expected_revision ?? request.expectedRevision,
      expectedContractRevision: request.expected_contract_revision ?? request.expectedContractRevision,
      owner: uiOwner(cwd),
      leaseToken,
      patch: request.patch ?? {},
      evidence: request.evidence ?? [],
      summary: request.summary ?? '',
      nextAction: request.next_action ?? request.nextAction ?? null,
      pendingOperations: request.pending_operations ?? request.pendingOperations ?? [],
      idempotencyKey: request.idempotency_key ?? request.idempotencyKey,
    });
    return result;
  }

  search(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return searchOperation({
      cwd,
      sessionId: request.session_id ?? request.sessionId,
      taskId: request.task_id ?? request.taskId,
      query: request.query,
      mode: request.mode,
      scope: request.scope,
      includeDeferred: Object.hasOwn(request, 'include_deferred') ? request.include_deferred : request.includeDeferred,
      limit: request.limit,
    });
  }

  proposeContract(request) {
    request ??= {};
    const cwd = normalizedCwd(request);
    return proposeContractChangeOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
      expectedContractRevision: request.expected_contract_revision ?? request.expectedContractRevision,
      diff: request.diff,
      sourceRef: request.source_ref ?? request.sourceRef ?? 'project-memory-ui',
      idempotencyKey: request.idempotency_key ?? request.idempotencyKey,
      owner: uiOwner(cwd),
    });
  }
}

for (const name of ['workspace', 'snapshot', 'startTask', 'useTask', 'listTasks', 'setTaskState', 'commit', 'bootstrap', 'claim', 'checkpoint', 'leaseStatus', 'deferred', 'discardDeferred', 'search', 'proposeContract', 'participants', 'updateProgress', 'completeTask']) {
  Remote(name)(ProjectMemoryRemoteService.prototype[name], {
    kind: 'method',
    name,
    static: false,
    private: false,
    access: {
      has: (object) => name in object,
      get: (object) => object[name],
    },
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    },
  });
}

export { ProjectMemoryRemoteService, presentSnapshot };
export default ProjectMemoryRemoteService;
