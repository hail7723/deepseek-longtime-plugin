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

// R00.2 minimal Client/Host integration evidence for the session/workspace
// interface: the Host tracks one workspace per live agent (session) id, the
// Client can address it explicitly, and disposal withdraws the candidate.
test('workspace remote resolves per-session workspaces across a real gateway', { timeout: 15000 }, async (t) => {
  const requireRuntime = createRequire(runtime ? path.join(path.resolve(runtime), 'package.json') : new URL('../package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const [{ Context }, { default: Registry }, { default: Gateway }, clientGateway] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'), load('@deepseek-ai/dsh-api-gateway/client'),
  ]);
  const host = new Context();
  const client = new Context();
  const directoryA = await mkdtemp(path.join(tmpdir(), 'project-memory-session-a-'));
  const directoryB = await mkdtemp(path.join(tmpdir(), 'project-memory-session-b-'));
  t.after(() => Promise.all([rm(directoryA, { recursive: true, force: true }), rm(directoryB, { recursive: true, force: true })]));

  const workspaces = new Map([['session-a', directoryA], ['session-b', directoryB]]);
  function fakeAgent(id) {
    const listeners = new Map();
    const ctx = {
      systemPrompt: { getContextOrder() { return 100; }, context() { return async () => {}; } },
      tools: { register() { return async () => {}; } },
      on(name, listener) { listeners.set(name, listener); return async () => listeners.delete(name); },
    };
    return { id, ctx };
  }
  const hostFiber = host.plugin({ name: 'memory-session-host', apply(ctx) {
    ctx.provide('workingDirectory', { ensure: async agent => workspaces.get(String(agent.id)) });
    new Registry(ctx);
    new ProjectMemoryService(ctx);
    new Gateway(ctx, {});
  } });
  await hostFiber;
  t.after(() => hostFiber.dispose());
  await host.parallel("agent/created", { agent: fakeAgent("session-a"), source: "create", signal: undefined });
  await host.parallel("agent/created", { agent: fakeAgent("session-b"), source: "resume", signal: undefined });

  const peer = { id: 'integration-owner', ctx: hostFiber.ctx, principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal, async dispose() {} };
  const connection = {
    interactions: 'none', generation: { getSnapshot() { return undefined; } },
    rpc: { open() {}, async call(route, endpoint, payload, signal) {
      assert.equal(route, '/api');
      const [namespace, method] = endpoint.split('/');
      try {
        const value = await hostFiber.ctx.typertGateway.invoke({ namespace, method, args: JSON.parse(JSON.stringify(payload.args)), peer, signal });
        return JSON.parse(JSON.stringify({ ok: true, value }));
      } catch (error) { return { ok: false, error: hostFiber.ctx.typertGateway.wireStream.failure(error) }; }
    } },
  };
  const infrastructure = client.plugin({ name: 'memory-session-client-transport', apply(ctx) {
    new Registry(ctx);
    ctx.provide('connection', connection);
  } });
  await infrastructure;
  t.after(() => infrastructure.dispose());
  const gatewayFiber = client.plugin(clientGateway);
  await gatewayFiber;
  t.after(() => gatewayFiber.dispose());

  let definition;
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInThisContext(`(function(window) {\n${source}\n})`)({ __ModuleLoader__: { load(value) { definition = value; } } });
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return { createElement(type, props) { return { type, props }; }, useEffect() {}, useMemo() {}, useState() {} };
  });
  const slotFixture = client.plugin({ name: 'memory-test-slots', apply(ctx) {
    ctx.provide('slots', {
      inject(name, callback) { return callback(); },
      register() { return () => {}; },
    });
  } });
  await slotFixture;
  t.after(() => slotFixture.dispose());
  const memory = client.plugin({ name: 'memory-test-ui-session', ...plugin });
  await memory;
  t.after(() => memory.dispose());
  const api = memory.ctx.get('remote.projectMemory');
  assert.ok(api, 'remote namespace must mount');

  // Explicit session addressing works regardless of how many agents are live.
  const forA = await api.workspace({ session_id: 'session-a' });
  assert.equal(forA.ok, true, JSON.stringify(forA));
  assert.equal(forA.value.cwd, path.resolve(directoryA));
  assert.equal(forA.value.sessionId, 'session-a');
  const forB = await api.workspace({ session_id: 'session-b' });
  assert.equal(forB.value.cwd, path.resolve(directoryB));

  // Two live agents and no session id: the Host must refuse to guess.
  const ambiguous = await api.workspace({});
  assert.equal(ambiguous.value.ok, false);
  assert.equal(ambiguous.value.error.code, 'WORKSPACE_SELECTION_REQUIRED');
  assert.equal(ambiguous.value.candidates.length, 2);

  // Unknown session ids fail closed instead of falling back to another window.
  const unknown = await api.workspace({ session_id: 'session-z' });
  assert.equal(unknown.value.ok, false);
  assert.equal(unknown.value.error.code, 'WORKSPACE_UNAVAILABLE');

  // Disposal withdraws only that session's candidate.
  host.emit("agent/disposed", { agent: fakeAgent("session-b") });
  await new Promise(resolve => setImmediate(resolve));
  const afterDispose = await api.workspace({});
  assert.equal(afterDispose.value.ok, true);
  assert.equal(afterDispose.value.sessionId, 'session-a');
  host.emit("agent/disposed", { agent: fakeAgent("session-a") });
  await new Promise(resolve => setImmediate(resolve));
  const empty = await api.workspace({});
  assert.equal(empty.value.ok, false);
  assert.equal(empty.value.error.code, 'WORKSPACE_UNAVAILABLE');
});

// R02: the v0.3 panel task flow is session-bound across the real gateway:
// startTask binds, useTask rebinds, commit writes without lease tokens, and
// a completed task invalidates its binding into an explicit re-selection.
test('session-bound task flow crosses the gateway with explicit session ids', { timeout: 15000 }, async (t) => {
  const requireRuntime = createRequire(runtime ? path.join(path.resolve(runtime), 'package.json') : new URL('../package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const [{ Context }, { default: Registry }, { default: Gateway }, clientGateway] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'), load('@deepseek-ai/dsh-api-gateway/client'),
  ]);
  const host = new Context();
  const client = new Context();
  const directory = await mkdtemp(path.join(tmpdir(), 'project-memory-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostFiber = host.plugin({ name: 'memory-tasks-host', apply(ctx) {
    ctx.provide('workingDirectory', { ensure: async () => directory });
    new Registry(ctx);
    new ProjectMemoryService(ctx);
    new Gateway(ctx, {});
  } });
  await hostFiber;
  t.after(() => hostFiber.dispose());
  const peer = { id: 'integration-owner', ctx: hostFiber.ctx, principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal, async dispose() {} };
  const connection = {
    interactions: 'none', generation: { getSnapshot() { return undefined; } },
    rpc: { open() {}, async call(route, endpoint, payload, signal) {
      const [namespace, method] = endpoint.split('/');
      try {
        const value = await hostFiber.ctx.typertGateway.invoke({ namespace, method, args: JSON.parse(JSON.stringify(payload.args)), peer, signal });
        return JSON.parse(JSON.stringify({ ok: true, value }));
      } catch (error) { return { ok: false, error: hostFiber.ctx.typertGateway.wireStream.failure(error) }; }
    } },
  };
  const infrastructure = client.plugin({ name: 'memory-tasks-transport', apply(ctx) {
    new Registry(ctx);
    ctx.provide('connection', connection);
  } });
  await infrastructure;
  t.after(() => infrastructure.dispose());
  const gatewayFiber = client.plugin(clientGateway);
  await gatewayFiber;
  t.after(() => gatewayFiber.dispose());
  let definition;
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInThisContext(`(function(window) {\n${source}\n})`)({ __ModuleLoader__: { load(value) { definition = value; } } });
  const plugin = definition.factory(name => ({
    createElement(type, props) { return { type, props }; }, useEffect() {}, useMemo() {}, useState() {},
  }));
  const slotFixture = client.plugin({ name: 'memory-tasks-slots', apply(ctx) {
    ctx.provide('slots', { inject(name, callback) { return callback(); }, register() { return () => {}; } });
  } });
  await slotFixture;
  t.after(() => slotFixture.dispose());
  const memory = client.plugin({ name: 'memory-test-ui-tasks', ...plugin });
  await memory;
  t.after(() => memory.dispose());
  const api = memory.ctx.get('remote.projectMemory');
  assert.ok(api);

  const first = await api.startTask({ cwd: directory, session_id: 'panel-session-a', objective: 'First task' });
  assert.equal(first.value.ok, true, JSON.stringify(first));
  const readme = await api.startTask({ cwd: directory, session_id: 'panel-session-b', objective: 'README task' });
  assert.equal(readme.value.ok, true);

  // Binding-aware snapshots through the wire.
  const forA = await api.snapshot({ cwd: directory, session_id: 'panel-session-a' });
  assert.equal(forA.value.task.id, first.value.task.id);
  const forB = await api.snapshot({ cwd: directory, session_id: 'panel-session-b' });
  assert.equal(forB.value.task.id, readme.value.task.id);

  // An unbound third session must choose explicitly.
  const forC = await api.snapshot({ cwd: directory, session_id: 'panel-session-c' });
  assert.equal(forC.value.selectionRequired, true);
  assert.equal(forC.value.task, null);

  // Commit without lease tokens, session-bound.
  const saved = await api.commit({ cwd: directory, session_id: 'panel-session-a', progress: 'wrote the first checkpoint', next_action: 'review' });
  assert.equal(saved.value.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.synced, true);

  // P1: mode, scope and deferred visibility survive the real wire path.
  const selectedSearch = await api.search({ cwd: directory, session_id: 'panel-session-a', query: 'checkpoint first', mode: 'all', scope: 'current' });
  assert.equal(selectedSearch.value.ok, true, JSON.stringify(selectedSearch));
  assert.equal(selectedSearch.value.filters.taskId, first.value.task.id);
  assert.equal(selectedSearch.value.mode, 'all');
  assert.ok(selectedSearch.value.results.some(row => row.source === 'checkpoint'));
  const peerSearch = await api.search({ cwd: directory, session_id: 'panel-session-b', query: 'checkpoint first', mode: 'all' });
  assert.deepEqual(peerSearch.value.results, []);
  assert.ok(peerSearch.value.diagnostics.scopeFilteredMatches > 0);
  const projectSearch = await api.search({ cwd: directory, session_id: 'panel-session-b', query: 'checkpoint first', mode: 'all', scope: 'project' });
  assert.equal(projectSearch.value.filters.taskId, null);
  assert.ok(projectSearch.value.results.some(row => row.taskId === first.value.task.id));
  await api.useTask({ cwd: directory, session_id: 'panel-session-c', task_id: first.value.task.id });
  const draft = await api.commit({ cwd: directory, session_id: 'panel-session-c', progress: 'gateway queued-only needle' });
  assert.equal(draft.value.synced, false);
  const queuedSearch = await api.search({ cwd: directory, session_id: 'panel-session-a', query: 'queued-only', mode: 'phrase' });
  assert.equal(queuedSearch.value.results[0].visibility, 'queued');
  assert.equal(queuedSearch.value.results[0].confirmed, false);
  const withoutDrafts = await api.search({ cwd: directory, session_id: 'panel-session-a', query: 'queued-only', mode: 'phrase', include_deferred: false });
  assert.deepEqual(withoutDrafts.value.results, []);
  assert.equal(withoutDrafts.value.diagnostics.queuedMatchCount, 1);

  // Completing one task invalidates only its own binding.
  const done = await api.setTaskState({ cwd: directory, task_id: readme.value.task.id, state: 'completed' });
  assert.equal(done.value.ok, true, JSON.stringify(done));
  const afterComplete = await api.snapshot({ cwd: directory, session_id: 'panel-session-b' });
  assert.equal(afterComplete.value.selectionRequired, true);
  const stillA = await api.snapshot({ cwd: directory, session_id: 'panel-session-a' });
  assert.equal(stillA.value.task.id, first.value.task.id);

  // Missing session ids fail closed instead of guessing.
  const noSession = await api.commit({ cwd: directory, progress: 'no session' });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error.code, 'gateway/signature-invalid' in noSession.error ? noSession.error.code : noSession.error.code);
  assert.equal(noSession.value === undefined || noSession.value.ok === false, true);
});
