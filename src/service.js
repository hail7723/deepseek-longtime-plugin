import path from 'node:path';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { apply as applyAgentMemory } from './plugin.js';
import {
  bootstrap as bootstrapOperation,
  checkpoint as checkpointOperation,
  claim as claimOperation,
  proposeContractChange as proposeContractChangeOperation,
  readProjectSnapshot,
  search as searchOperation,
} from './operations.js';

const remoteInitializers = [];

function normalizedCwd(request, fallback = '') {
  const value = typeof request?.cwd === 'string' ? request.cwd.trim() : '';
  if (value !== '') return path.resolve(value);
  return fallback;
}

function uiOwner(cwd) {
  return `project-memory-ui:${cwd.toLowerCase()}`;
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
      nextAction: task.data?.nextAction ?? snapshot.checkpoint?.payload?.nextAction ?? null,
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
    this.lastCwd = '';
    this.leases = new Map();
    applyAgentMemory(ctx);
  }

  snapshot(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
    if (cwd === '') return { ok: true, initialized: false, cwd: '', projectRoot: null };
    this.lastCwd = cwd;
    const taskId = request.task_id ?? request.taskId;
    const snapshot = readProjectSnapshot({
      cwd,
      taskId,
      sinceEventSeq: request.since_event_seq ?? request.sinceEventSeq ?? 0,
      eventLimit: request.event_limit ?? request.eventLimit ?? 100,
    });
    return presentSnapshot(snapshot, this.leases.get(`${cwd}\0${taskId ?? snapshot.task?.id ?? ''}`));
  }

  bootstrap(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
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
    if (result.ok) this.lastCwd = cwd;
    return result;
  }

  claim(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
    const taskId = request.task_id ?? request.taskId;
    const result = claimOperation({
      cwd,
      taskId,
      expectedRevision: request.expected_revision ?? request.expectedRevision,
      owner: uiOwner(cwd),
      leaseSeconds: request.lease_seconds ?? request.leaseSeconds ?? 300,
    });
    if (result.ok) {
      this.lastCwd = cwd;
      this.leases.set(`${cwd}\0${result.taskId}`, result.leaseToken);
    }
    return result;
  }

  checkpoint(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
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
    if (result.ok) this.lastCwd = cwd;
    return result;
  }

  search(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
    return searchOperation({
      cwd,
      taskId: request.task_id ?? request.taskId,
      query: request.query ?? '',
      limit: request.limit ?? 20,
    });
  }

  proposeContract(request) {
    request ??= {};
    const cwd = normalizedCwd(request, this.lastCwd);
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

for (const name of ['snapshot', 'bootstrap', 'claim', 'checkpoint', 'search', 'proposeContract']) {
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
