import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ProjectMemoryService from '../src/service.js';

const runtime = process.env.DSH_TEST_RUNTIME;

test('real Client Gateway mounts, invokes Host Gateway and disposes the memory namespace', { timeout: 15000 }, async (t) => {
  const requireRuntime = createRequire(runtime ? path.join(path.resolve(runtime), 'package.json') : new URL('../package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const [{ Context }, { default: Registry }, { default: Gateway }, clientGateway] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'), load('@deepseek-ai/dsh-api-gateway/client'),
  ]);
  const host = new Context();
  const client = new Context();
  const directory = await mkdtemp(path.join(tmpdir(), 'project-memory-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostFiber = host.plugin({ name: 'memory-test-host', apply(ctx) {
    new Registry(ctx);
    new ProjectMemoryService(ctx);
    new Gateway(ctx, {});
  } });
  await hostFiber;
  t.after(() => hostFiber.dispose());
  const peer = { id: 'integration-owner', ctx: hostFiber.ctx, principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal, async dispose() {} };
  const requests = [];
  const connection = {
    interactions: 'none', generation: { getSnapshot() { return undefined; } },
    rpc: { open() {}, async call(route, endpoint, payload, signal) {
      assert.equal(route, '/api');
      requests.push({ endpoint, payload });
      const [namespace, method] = endpoint.split('/');
      try {
        const value = await hostFiber.ctx.typertGateway.invoke({ namespace, method, args: JSON.parse(JSON.stringify(payload.args)), peer, signal });
        return JSON.parse(JSON.stringify({ ok: true, value }));
      } catch (error) { return { ok: false, error: hostFiber.ctx.typertGateway.wireStream.failure(error) }; }
    } },
  };
  const infrastructure = client.plugin({ name: 'memory-test-client-transport', apply(ctx) {
    new Registry(ctx);
    ctx.provide('connection', connection);
  } });
  await infrastructure;
  t.after(() => infrastructure.dispose());
  const gatewayFiber = client.plugin(clientGateway);
  await gatewayFiber;
  t.after(() => gatewayFiber.dispose());
  await assert.rejects(client.get('remote').$mount({
    package: '@hail7723/invalid-codec-regression',
    descriptors: [{ id: 'invalid-codec', service: 'projectMemory', namespace: 'invalidMemory', method: 'snapshot', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } }],
  }), /no strict codec/);
  let definition;
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInThisContext(`(function(window) {\n${source}\n})`)({ __ModuleLoader__: { load(value) { definition = value; } } });
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return { createElement(type, props) { return { type, props }; }, useEffect() {}, useMemo() {}, useState() {} };
  });
  const registrations = [];
  const slotFixture = client.plugin({ name: 'memory-test-slots', apply(ctx) {
    ctx.provide('slots', {
      inject(name, callback) { return callback(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    });
  } });
  await slotFixture;
  t.after(() => slotFixture.dispose());
  const memory = client.plugin({ name: 'memory-test-ui', ...plugin });
  await memory;
  t.after(() => memory.dispose());
  assert.equal(registrations.length, 2);
  const api = memory.ctx.get('remote.projectMemory');
  assert.ok(api, 'real gateway namespace must exist; catch-and-degrade must not mask mount failure');
  const panelApi = registrations.find(x => x.options.name === 'main').component({}).props.api;
  const panelSnapshot = await panelApi('snapshot', { cwd: directory, task_id: undefined });
  assert.equal(panelSnapshot.initialized, false);
  const carried = await api.snapshot({ cwd: directory });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(carried.value.initialized, false);
  const created = await api.bootstrap({ cwd: directory, task_id: 'ui-task', objective: 'Ship panel', acceptance_criteria: ['shared SQLite state'] });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.ok, true, JSON.stringify(created));
  const claimed = await api.claim({ cwd: directory, task_id: 'ui-task', expected_revision: created.value.task.taskVersion });
  assert.equal(claimed.value.ok, true, JSON.stringify(claimed));
  const saved = await api.checkpoint({ cwd: directory, task_id: 'ui-task', expected_revision: claimed.value.taskRevision, expected_contract_revision: claimed.value.contractRevision, summary: 'Gateway checkpoint', next_action: 'verify browser' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.ok, true, JSON.stringify(saved));
  const latest = await api.snapshot({ cwd: directory });
  assert.equal(latest.value.task.id, 'ui-task');
  assert.equal(latest.value.checkpoint.payload.summary, 'Gateway checkpoint');
  const conflict = await api.checkpoint({ cwd: directory, task_id: 'ui-task', expected_revision: claimed.value.taskRevision, expected_contract_revision: claimed.value.contractRevision, summary: 'must fail' });
  assert.equal(conflict.ok, true);
  assert.equal(conflict.value.ok, false);
  assert.match(conflict.value.error.code, /CONFLICT/);
  const proposal = await panelApi('proposeContract', { cwd: directory, task_id: 'ui-task', expected_contract_revision: latest.value.task.contractVersion, diff: { objective: 'Candidate objective' }, source_ref: 'user:integration' });
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  const candidateView = await panelApi('snapshot', { cwd: directory });
  assert.equal(candidateView.contractCandidates.length, 1);
  assert.equal(candidateView.contractCandidates[0].id, proposal.candidate.id);
  assert.equal(candidateView.contract.objective, 'Ship panel');
  const found = await panelApi('search', { cwd: directory, task_id: 'ui-task', query: 'Gateway checkpoint' });
  assert.equal(found.ok, true);
  assert.ok(found.results.length > 0);
  assert.deepEqual(Object.keys(requests[0].payload.args), ['request']);
  await memory.dispose();
  assert.equal(client.get('remote.projectMemory'), undefined);
  assert.equal(infrastructure.ctx.typert.remotes.list().filter(x => x.namespace === 'projectMemory').length, 0);
  assert.equal(api.snapshot, undefined);
  const remounted = client.plugin({ name: 'memory-test-ui-remounted', ...plugin });
  await remounted;
  t.after(() => remounted.dispose());
  const afterRemount = await remounted.ctx.get('remote.projectMemory').snapshot({ cwd: directory });
  assert.equal(afterRemount.value.task.id, 'ui-task');
});
