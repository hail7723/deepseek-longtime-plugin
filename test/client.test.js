import assert from 'node:assert/strict';
import test from 'node:test';

function loadClientFactory() {
  let definition;
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  return import(`../client.js?test=${Date.now()}`).then(() => definition);
}

test('client mounts Remote descriptors before registering sidebar and main slots', async (t) => {
  const definition = await loadClientFactory();
  t.after(() => { delete globalThis.window; });
  assert.equal(definition.id, 'dsh-longtime-memory');

  const React = {
    createElement() { return null; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useState(value) { return [value, () => {}]; },
    Fragment: Symbol('Fragment'),
  };
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  assert.deepEqual(plugin.inject, ['slots', 'remote']);

  const order = [];
  const registered = [];
  const remote = {
    async $mount(contribution) {
      order.push('mount');
      assert.equal(contribution.package, 'dsh-longtime-memory');
      assert.deepEqual(contribution.descriptors.map(item => item.method), [
        'workspace', 'snapshot', 'startTask', 'useTask', 'listTasks', 'setTaskState', 'commit', 'bootstrap', 'claim', 'checkpoint', 'leaseStatus', 'deferred', 'discardDeferred', 'search', 'proposeContract',
      ]);
      for (const descriptor of contribution.descriptors) {
        assert.equal(descriptor.service, 'projectMemory');
        assert.equal(descriptor.namespace, 'projectMemory');
        assert.equal(descriptor.parameters[0].codec.mode, 'strict');
        assert.equal(descriptor.result.mode, 'strict');
        const parser = descriptor.parameters[0].codec.create();
        assert.deepEqual(parser.parse({ cwd: 'C:/project' }), { cwd: 'C:/project' });
        assert.throws(() => parser.parse({ x: undefined }));
        assert.throws(() => parser.parse({ x: NaN }));
      }
      remote.projectMemory = Object.fromEntries(contribution.descriptors.map(({ method }) => [method, async () => ({ ok: true, value: { ok: true } })]));
      return async () => { order.push('unmount'); delete remote.projectMemory; };
    },
  };
  const ctx = {
    remote,
    get(name) {
      assert.equal(name, 'layout');
      return { selectPanel() {} };
    },
    slots: {
      inject(name, register) {
        order.push(`inject:${name}`);
        const dispose = register();
        return async () => { order.push(`dispose:${name}`); await dispose(); };
      },
      register(options) {
        registered.push(options);
        return async () => {};
      },
    },
  };

  const dispose = await plugin.apply(ctx);
  assert.deepEqual(order, ['mount', 'inject:sidebar.panellist', 'inject:main']);
  assert.deepEqual(registered.map(item => [item.name, item.id ?? item.key]), [
    ['sidebar.panellist', 'project-memory'],
    ['main', 'project-memory'],
  ]);

  await dispose();
  assert.deepEqual(order.slice(-3), ['dispose:main', 'dispose:sidebar.panellist', 'unmount']);
});

test('Remote mount rejection stays inside the memory panel instead of rejecting Web boot', async (t) => {
  const definition = await loadClientFactory();
  t.after(() => { delete globalThis.window; });
  const plugin = definition.factory(() => ({ createElement() {}, useEffect() {}, useMemo() {}, useState() {} }));
  const slots = [];
  const errors = [];
  const dispose = await plugin.apply({
    remote: { async $mount() { throw new Error('codec rejected by gateway'); } },
    logger: { error(...args) { errors.push(args); } },
    get() { return undefined; },
    slots: {
      inject(name, register) { slots.push(name); register(); return () => {}; },
      register() { return () => {}; },
    },
  });
  assert.deepEqual(slots, ['sidebar.panellist', 'main']);
  assert.equal(errors.length, 1);
  await dispose();
});

test('ambiguous workspaces render an explicit picker and a pick loads that project', async (t) => {
  const definition = await loadClientFactory();
  t.after(() => { delete globalThis.window; });

  // Stateful fake React that actually invokes function components.
  let hookIndex = 0;
  const hookStates = [];
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props || {}), children });
      return { type, props: { ...(props || {}), children } };
    },
    Fragment: 'Fragment',
    useEffect() {}, useMemo(factory) { return factory(); },
    useState(initial) {
      const i = hookIndex++;
      if (i >= hookStates.length) hookStates[i] = typeof initial === 'function' ? initial() : initial;
      return [hookStates[i], () => {}];
    },
  };
  const plugin = definition.factory(name => React);
  const registrations = [];
  // The slot wrapper injects its own api built on `remote.projectMemory`,
  // so the fake is provided as the Remote namespace, not as a prop.
  const calls = [];
  const namespace = {
    async workspace() {
      return { ok: true, value: { ok: false, error: { code: 'WORKSPACE_SELECTION_REQUIRED' }, candidates: [
        { sessionId: 'session-a', cwd: 'D:/projects/alpha' },
        { sessionId: 'session-b', cwd: 'D:/projects/beta' },
      ] } };
    },
    async snapshot(request) {
      calls.push({ method: 'snapshot', request });
      return { ok: true, value: { ok: true, initialized: true, cwd: request.cwd, tasks: [], events: [] } };
    },
  };
  const dispose = await plugin.apply({
    remote: { async $mount() { return async () => {}; } },
    get(name) { return name === 'remote.projectMemory' ? namespace : {}; },
    slots: {
      inject(name, register) { const out = register(); return async () => { await out; }; },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  });
  t.after(() => dispose());
  const panel = registrations.find(item => item.options.key === 'project-memory').component;
  assert.ok(panel, 'main slot component registered');

  // hooks: 0 tab, 1 cwd, 2 sessionId, 3 data, 4 busy, 5 feedback, 6 bootstrap,
  // 7 commit, 8 newTask, 9 search, 10 results, 11 proposal, 12 lastCommitArgs,
  // 13 draftKept, 14 workspaceChoices
  hookStates.length = 0;
  hookStates.push('overview', '', '', null, '', null, { taskId: '' }, { progress: '', nextAction: '', blockers: '', evidence: '' }, { objective: '', criteria: '', constraints: '' }, { query: '', limit: '20' }, [], { sourceRef: '', diff: '' }, null, false, [
    { sessionId: 'session-a', cwd: 'D:/projects/alpha' },
    { sessionId: 'session-b', cwd: 'D:/projects/beta' },
  ]);
  hookIndex = 0;
  const rendered = panel({});
  const text = JSON.stringify(rendered, (key, value) => (typeof value === 'function' ? 'FN' : value));
  assert.ok(text.includes('选择项目工作区'), 'picker section is visible');
  assert.ok(text.includes('D:/projects/alpha') && text.includes('D:/projects/beta'), 'both candidates are listed');

  // Clicking a candidate loads exactly that project.
  function collectButtons(node, found) {
    if (Array.isArray(node)) { for (const item of node) collectButtons(item, found); return found; }
    if (!node || typeof node !== 'object') return found;
    if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') found.push(node.props);
    collectButtons(node.props?.children ?? [], found);
    return found;
  }
  const buttons = collectButtons(rendered, []);
  const pickButtons = buttons.filter(props => JSON.stringify(props.children ?? []).includes('打开此项目'));
  assert.equal(pickButtons.length, 2, 'one pick button per candidate row');
  calls.length = 0;
  await pickButtons[1].onClick();
  const snapshot = calls.find(call => call.method === 'snapshot');
  assert.ok(snapshot, 'snapshot requested after picking');
  assert.equal(snapshot.request.cwd, 'D:/projects/beta');
});
