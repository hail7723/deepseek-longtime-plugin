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
