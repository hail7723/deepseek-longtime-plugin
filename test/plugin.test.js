import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findProjectRoot, registerAgent } from '../src/plugin.js';

function harnessAgent(id) {
  const tools = new Map();
  const contexts = new Map();
  const listeners = new Map();
  const ctx = {
    systemPrompt: {
      getContextOrder() { return 100; },
      context(definition) {
        contexts.set(definition.name, definition);
        return async () => contexts.delete(definition.name);
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return async () => tools.delete(definition.name);
      },
    },
    on(name, listener) {
      listeners.set(name, listener);
      return async () => listeners.delete(name);
    },
  };
  return { agent: { id, ctx }, tools, contexts, listeners };
}

const logger = { warn() {} };

async function callTool(harness, name, args) {
  const definition = harness.tools.get(name);
  assert.ok(definition, `${name} is registered`);
  return definition.execute(args, {});
}

test('explicit marker boundary ignores a parent .git directory', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-boundary-'));
  const project = path.join(parent, 'project');
  const nested = path.join(project, 'src', 'nested');
  fs.mkdirSync(path.join(parent, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), null);

  const h = harnessAgent('session-boundary');
  const dispose = registerAgent(h.agent, project, logger);
  t.after(dispose);
  const result = await callTool(h, 'memory_bootstrap', {
    task_id: 'task-boundary',
    objective: 'Keep project identity local',
    acceptance_criteria: ['Do not use the parent Git root'],
    idempotency_key: 'bootstrap-boundary',
  });
  assert.equal(result.ok, true);
  assert.equal(findProjectRoot(nested), project);
  assert.equal(result.projectRoot, project);
});

test('new agents and repeated context refreshes observe latest SQLite checkpoint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-recovery-'));
  const a = harnessAgent('session-a');
  const disposeA = registerAgent(a.agent, root, logger);
  t.after(disposeA);

  const boot = await callTool(a, 'memory_bootstrap', {
    task_id: 'task-1',
    objective: 'Recover exact local state',
    acceptance_criteria: ['Latest checkpoint appears in every request retry'],
    constraints: ['offline only'],
    next_action: 'write checkpoint',
    idempotency_key: 'bootstrap-task-1',
  });
  assert.equal(boot.ok, true);
  const claim = await callTool(a, 'memory_claim', { expected_revision: 1, lease_seconds: 600 });
  assert.equal(claim.ok, true);
  const committed = await callTool(a, 'memory_checkpoint', {
    expected_revision: 1,
    expected_contract_revision: 1,
    lease_token: claim.leaseToken.fence,
    patch: { state: 'active', data: { nextAction: 'run integration test' } },
    evidence: [{ kind: 'test', command: 'node --test', result: 'passed' }],
    summary: 'SQLite checkpoint committed',
    next_action: 'run integration test',
    pending_operations: [],
    idempotency_key: 'checkpoint-1',
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));

  const providerA = a.contexts.get('project-memory:recovery');
  assert.equal(providerA.required, true);
  for (let simulatedCompaction = 0; simulatedCompaction < 3; simulatedCompaction += 1) {
    const text = providerA.text();
    assert.match(text, /Revisions \/ workspace \/ branch \/ code: 2\/1/);
    assert.match(text, /SQLite checkpoint committed/);
  }

  const b = harnessAgent('session-b');
  const disposeB = registerAgent(b.agent, root, logger);
  t.after(disposeB);
  const providerB = b.contexts.get('project-memory:recovery');
  assert.match(providerB.text(), /\/ task-1 \(active\)/);
  assert.match(providerB.text(), /run integration test/);

  const stale = await callTool(b, 'memory_claim', { expected_revision: 1, lease_seconds: 60 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'TASK_REVISION_CONFLICT');
});

test('contract proposals remain candidates and check the confirmed revision', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-contract-'));
  const h = harnessAgent('session-contract');
  const dispose = registerAgent(h.agent, root, logger);
  t.after(dispose);
  await callTool(h, 'memory_bootstrap', {
    task_id: 'contract-task',
    objective: 'Preserve confirmed requirements',
    acceptance_criteria: ['Candidates do not overwrite contracts'],
    idempotency_key: 'bootstrap-contract',
  });

  const proposal = await callTool(h, 'memory_propose_contract_change', {
    expected_contract_revision: 1,
    diff: { objective: 'candidate only' },
    source_ref: 'session-contract:user-message-1',
    idempotency_key: 'proposal-1',
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.status, 'candidate');
  const read = await callTool(h, 'memory_read', {});
  assert.equal(read.task.contractVersion, 1);
  assert.equal(read.task.contract.objective, 'Preserve confirmed requirements');

  const stale = await callTool(h, 'memory_propose_contract_change', {
    expected_contract_revision: 0,
    diff: { objective: 'stale' },
    source_ref: 'session-contract:user-message-2',
    idempotency_key: 'proposal-stale',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'CONTRACT_REVISION_CONFLICT');
});

test('pending tool operations survive a simulated crash and appear in recovery', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-pending-'));
  const a = harnessAgent('session-pending-a');
  const disposeA = registerAgent(a.agent, root, logger);
  t.after(disposeA);
  await callTool(a, 'memory_bootstrap', {
    task_id: 'pending-task',
    objective: 'Recover interrupted operations',
    acceptance_criteria: ['Pending operation is visible after restart'],
    idempotency_key: 'bootstrap-pending',
  });
  const preExecute = a.listeners.get('tools/pre-execute');
  const decision = await preExecute({ name: 'write', callId: 'call-before-crash' }, async () => ({ kind: 'allow' }));
  assert.deepEqual(decision, { kind: 'allow' });

  const b = harnessAgent('session-pending-b');
  const disposeB = registerAgent(b.agent, root, logger);
  t.after(disposeB);
  const recovery = b.contexts.get('project-memory:recovery').text();
  assert.match(recovery, /Pending or unknown external operations: write \(pending\)/);
});

test('database failure is surfaced and never reported as a successful read', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-db-failure-'));
  const h = harnessAgent('session-db-failure');
  const dispose = registerAgent(h.agent, root, logger);
  t.after(dispose);
  await callTool(h, 'memory_bootstrap', {
    task_id: 'db-task',
    objective: 'Surface database failures',
    acceptance_criteria: ['No false success'],
    idempotency_key: 'bootstrap-db',
  });
  const bindingRead = h.tools.get('memory_read');
  await dispose();
  fs.writeFileSync(path.join(root, '.deepseek-memory', 'project.json'), '{broken-json', 'utf8');
  const failed = await bindingRead.execute({}, {});
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'PROJECT_MEMORY_ERROR');
});
