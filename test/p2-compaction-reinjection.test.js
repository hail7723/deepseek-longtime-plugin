import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import LlmRuntime, { LlmAdapter, createUserMessage, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import SessionStore, { buildForkSeed } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import * as memoryPlugin from '../src/plugin.js';
import * as operations from '../src/operations.js';
import { openProjectStore } from '../src/store.js';

const RECOVERY = 'project-memory:recovery';
const SESSION = 'session-p21-main';
const padding = 'Offline conversation history worth retaining. '.repeat(300);

// The only model implementation is this offline provider. Agent requests and
// auxiliary summary requests both traverse the public LlmRuntime adapter seam.
class OfflineProvider extends LlmAdapter {
  requests = [];
  overflowNext = false;
  failSummary = false;
  onSummary;
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 }, defaultMaxTokens: 1024 };
  }
  async *stream(request) {
    this.requests.push(structuredClone(request));
    if (request.model === 'summary') {
      await this.onSummary?.(request);
      request.signal?.throwIfAborted();
      if (this.failSummary) throw new LlmError('offline summarizer failed', 'OFFLINE_SUMMARY_FAILURE');
    } else if (this.overflowNext) {
      this.overflowNext = false;
      throw new LlmError('offline context overflow', CONTEXT_WINDOW_EXCEEDED_CODE);
    }
    const text = request.model === 'summary' ? 'Offline compacted history.' : 'Offline answer. '.repeat(300);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function recoveryMessages(request) {
  return request.messages.filter(message => message.source?.kind === 'runtime-context'
    && message.source.sections?.some(section => section.name === RECOVERY));
}
function recoverySection(request) {
  const messages = recoveryMessages(request);
  assert.equal(messages.length, 1, 'provider sees exactly one current recovery snapshot');
  return visibleRecovery(messages[0]);
}
function visibleRecovery(message) {
  assert.ok(message, 'a current recovery message must exist');
  const section = message.source.sections.find(section => section.name === RECOVERY);
  assert.ok(section);
  const body = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.ok(body.includes(section.text), 'recovery must be present in model-facing content, not just source metadata');
  assert.ok(Buffer.byteLength(section.text) <= 6000);
  return { message, text: section.text };
}

async function fixture(t, { auto = false, suppress = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p21-reinjection-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const ctx = new Context(); const provider = new OfflineProvider();
  const events = new Map(); const errors = []; const fibers = []; const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber; return fiber; };
  await mount({ name: 'p21-offline-services', apply(host) {
    new AgentRegistry(host); new SessionStore(host); new SessionProjectionRegistry(host);
    new SystemPrompt(host, { includeHarnessIdentity: false }); new ToolRuntime(host, { mode: 'native' });
    new LlmRuntime(host); new TokenMeter(host, {});
    host.llm.registerAdapter(['offline'], provider);
    host.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd });
    host.on('session/event', (session, event) => {
      if (!events.has(session.id)) events.set(session.id, []);
      events.get(session.id).push(event);
    });
    host.on('agent/error', ({ error }) => errors.push(error));
  } });
  await mount(JsonlPersistence, { root: path.join(root, 'sessions'), compression: 'none' });
  await mount(AgentLoop, { agents: [] });
  await mount(BasicCompactionEngine, { auto, thresholdRatio: 0.99, headroomTokens: 0, retainTokens: 0,
    summarizationProvider: 'offline', summarizationModel: 'summary', maxTokens: 256, maxOverflowRetries: 1 });
  await mount(memoryPlugin);
  const started = operations.startTask({ cwd: project, sessionId: SESSION, objective: 'P2.1 recovery contract' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const committed = await operations.commit({ cwd: project, sessionId: SESSION, progress: 'database-before-compaction', nextAction: 'verify next request' });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const create = async (sessionId = SESSION, extra = {}) => {
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: project }, agentOptions: { provider: 'offline', model: 'chat' }, ...extra });
    handles.push(handle); return handle;
  };
  const handle = await create(); const agent = handle.agent;
  if (suppress) agent.ctx.systemPrompt.suppressRuntimeContext();
  const send = async (owner = agent, text = padding) => {
    const before = provider.requests.filter(request => request.model === 'chat').length;
    owner.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await owner.whenIdle();
    assert.deepEqual(errors, [], 'the real Agent loop must not silently fail');
    const calls = provider.requests.filter(request => request.model === 'chat').slice(before);
    assert.ok(calls.length, 'the fake Provider must receive a real model request');
    return calls;
  };
  const compactAll = () => ctx.compaction.compactNow(agent, new AbortController().signal);
  const log = (owner = agent) => events.get(owner.id) ?? [];
  const dbState = () => {
    const store = openProjectStore(project);
    try { return { task: store.getTask(started.projectId, started.task.id),
      participant: store.getParticipant({ projectId: started.projectId, taskId: started.task.id, participantId: SESSION }),
      events: store.listEvents(started.projectId), schema: store.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value }; }
    finally { store.close(); }
  };
  return { ctx, root, project, started, provider, agent, handle, handles, create, send, compactAll, log, dbState };
}

test('P2.1 full real compaction replaces recovery; first subsequent provider request reinjects unchanged text', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = recoverySection((await f.send())[0]);
  const before = f.dbState();
  const compacted = await f.compactAll();
  assert.ok(compacted, 'compaction must actually run');
  const oldEvent = f.log().find(event => event.type === 'user/message' && event.data.id === first.message.id);
  assert.ok(compacted.shadowedSeqs.includes(oldEvent.seq), 'the real backend must cover the old runtime context');
  assert.equal(recoveryMessages({ messages: f.agent.session.deriveMessages() }).length, 0);
  const next = recoverySection((await f.send(undefined, 'after compaction'))[0]);
  assert.equal(next.text, first.text); assert.notEqual(next.message.id, first.message.id);
  assert.deepEqual(f.dbState(), before, 'reinjection changes no task, participant, lease, CAS, schema or project events');
});

test('P2.1 partial compaction retaining recovery does not append another snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = recoverySection((await f.send())[0]);
  const assistant = f.log().findLast(event => event.type === 'assistant/message');
  const before = f.dbState();
  let result;
  const stop = f.agent.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    result = await f.ctx.compaction.compactRegion(assistant.seq, assistant.seq, agent, signal);
    const retained = recoverySection({ messages: agent.session.deriveMessages() });
    assert.equal(retained.message.id, first.message.id);
    stop();
    return next();
  });
  const next = recoverySection((await f.send(undefined, 'after local compaction'))[0]);
  assert.deepEqual(result.shadowedSeqs, [assistant.seq]);
  assert.equal(next.message.id, first.message.id);
  assert.equal(f.log().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context').length, 1);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 SQLite update between compaction and next request is visible without refreshing participant state', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.send(); await f.compactAll();
  assert.equal(operations.updateProgress({ cwd: f.project, sessionId: SESSION,
    summary: 'sqlite-after-compaction-latest', nextAction: 'latest-next-action' }).ok, true);
  const expected = memoryPlugin.renderRecoveryPackage(operations.readProjectSnapshot({ cwd: f.project, sessionId: SESSION }));
  const before = f.dbState();
  const next = recoverySection((await f.send(undefined, 'read current database'))[0]);
  assert.equal(next.text, expected);
  assert.match(next.text, /Current state: sqlite-after-compaction-latest/);
  assert.match(next.text, /Next action: latest-next-action/);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 retained historical recovery is superseded by fresh SQLite state after partial compaction', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = recoverySection((await f.send())[0]);
  const assistant = f.log().findLast(event => event.type === 'assistant/message');
  let afterUpdate;
  const stop = f.agent.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const result = await f.ctx.compaction.compactRegion(assistant.seq, assistant.seq, agent, signal);
    assert.deepEqual(result.shadowedSeqs, [assistant.seq]);
    assert.equal(recoverySection({ messages: agent.session.deriveMessages() }).message.id, first.message.id);
    assert.equal(operations.updateProgress({ cwd: f.project, sessionId: SESSION, summary: 'partial-compaction-newest-sqlite' }).ok, true);
    afterUpdate = f.dbState(); stop(); return next();
  });
  const request = (await f.send(undefined, 'updated after partial compaction'))[0];
  const snapshots = recoveryMessages(request);
  assert.equal(snapshots.length, 2, 'a later snapshot supersedes the retained historical snapshot');
  assert.equal(snapshots[0].id, first.message.id);
  const current = snapshots.at(-1);
  assert.match(visibleRecovery(current).text, /Current state: partial-compaction-newest-sqlite/);
  const unchanged = recoveryMessages((await f.send(undefined, 'unchanged after update'))[0]);
  assert.equal(unchanged.length, 2); assert.equal(unchanged.at(-1).id, current.id);
  assert.deepEqual(f.dbState(), afterUpdate);
});

test('P2.1 three consecutive compactions preserve one current recovery with bounded surface growth', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let current = recoverySection((await f.send())[0]);
  const before = f.dbState();
  for (let cycle = 0; cycle < 3; cycle++) {
    const previous = current;
    assert.ok(await f.compactAll());
    current = recoverySection((await f.send(undefined, `cycle-${cycle} ${padding}`))[0]);
    assert.equal(current.text, previous.text); assert.notEqual(current.message.id, previous.message.id);
    const unchanged = recoverySection((await f.send(undefined, `ordinary follow-up-${cycle}`))[0]);
    assert.equal(unchanged.message.id, current.message.id, 'no snapshot append on an ordinary unchanged request');
    assert.ok(f.agent.session.deriveMessages().length <= 8, 'the retained surface does not accumulate old snapshots');
  }
  assert.equal(f.log().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context').length, 4);
  assert.equal(f.log().filter(event => event.type === 'compaction/summary').length, 3);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 required recovery survives runtime-context suppression before and after compaction', { timeout: 15000 }, async t => {
  const f = await fixture(t, { suppress: true });
  f.agent.ctx.systemPrompt.context({ name: 'p21:optional', order: 9999, text: 'OPTIONAL_CONTEXT_MUST_BE_SUPPRESSED' });
  const firstRequest = (await f.send())[0];
  const first = recoverySection(firstRequest);
  assert.doesNotMatch(JSON.stringify(firstRequest.messages), /OPTIONAL_CONTEXT_MUST_BE_SUPPRESSED/);
  assert.ok(await f.compactAll());
  const nextRequest = (await f.send(undefined, 'after suppressed compaction'))[0];
  const next = recoverySection(nextRequest);
  assert.equal(next.text, first.text); assert.notEqual(next.message.id, first.message.id);
  assert.doesNotMatch(JSON.stringify(nextRequest.messages), /OPTIONAL_CONTEXT_MUST_BE_SUPPRESSED/);
});

test('P2.1 real automatic overflow retries refresh SQLite recovery in the same turn without duplicating user input', { timeout: 15000 }, async t => {
  const f = await fixture(t, { auto: true });
  const initial = recoverySection((await f.send())[0]);
  let afterUpdate;
  f.provider.onSummary = async () => {
    assert.equal(operations.updateProgress({ cwd: f.project, sessionId: SESSION, summary: 'overflow-retry-latest-sqlite' }).ok, true);
    afterUpdate = f.dbState();
  };
  f.provider.overflowNext = true;
  const before = f.agent.session.seq;
  const attempts = await f.send(undefined, 'ONE_OVERFLOW_USER_MESSAGE');
  assert.equal(attempts.length, 2, 'one failed attempt and one real retry');
  assert.equal(recoverySection(attempts[0]).message.id, initial.message.id);
  const next = recoverySection(attempts[1]);
  assert.match(next.text, /Current state: overflow-retry-latest-sqlite/);
  const users = attempts.map(request => request.messages.filter(message => message.source?.kind === 'user'
    && message.content.some(block => block.text === 'ONE_OVERFLOW_USER_MESSAGE')));
  assert.deepEqual(users.map(rows => rows.length), [1, 1]);
  assert.equal(users[0][0].id, users[1][0].id, 'accepted input identity survives retry');
  const tail = f.log().filter(event => event.seq >= before);
  assert.equal(tail.filter(event => event.type === 'turn/start').length, 1);
  assert.equal(tail.filter(event => event.type === 'step/start').length, 1);
  assert.equal(tail.filter(event => event.type === 'user/message' && event.data.id === users[0][0].id).length, 1);
  assert.equal(tail.filter(event => event.type === 'compaction/summary').length, 1);
  assert.deepEqual(f.dbState(), afterUpdate, 'only the deliberate SQLite update changes memory state');
});

test('P2.1 failed real summarization preserves the valid recovery without a duplicate', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = recoverySection((await f.send())[0]);
  const before = f.dbState();
  f.provider.failSummary = true;
  await assert.rejects(f.compactAll(), error => error.code === 'summary');
  assert.equal(recoverySection({ messages: f.agent.session.deriveMessages() }).message.id, first.message.id);
  f.provider.failSummary = false;
  const next = recoverySection((await f.send(undefined, 'after failed compaction'))[0]);
  assert.equal(next.message.id, first.message.id);
  assert.equal(f.log().filter(event => event.type === 'compaction/summary').length, 0);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 in-flight compaction abort preserves recovery and closes the attempt without replacement', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = recoverySection((await f.send())[0]);
  const before = f.dbState();
  const began = Promise.withResolvers(); const release = Promise.withResolvers();
  f.provider.onSummary = async () => { began.resolve(); await release.promise; };
  const cancellation = new AbortController();
  const pending = f.ctx.compaction.compactNow(f.agent, cancellation.signal);
  const rejected = assert.rejects(pending, /cancel|aborted|p21 abort/i);
  await began.promise;
  cancellation.abort(new Error('p21 abort')); release.resolve();
  await rejected;
  assert.equal(recoverySection({ messages: f.agent.session.deriveMessages() }).message.id, first.message.id);
  f.provider.onSummary = undefined;
  assert.equal(recoverySection((await f.send(undefined, 'after aborted compaction'))[0]).message.id, first.message.id);
  assert.equal(f.log().filter(event => event.type === 'compaction/summary').length, 0);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 reinjected multi-participant recovery stays within 6000 UTF-8 bytes', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(operations.updateProgress({ cwd: f.project, sessionId: SESSION, summary: '中文😀'.repeat(700), nextAction: '下一步'.repeat(100) }).ok, true);
  for (let i = 0; i < 6; i++) {
    const sessionId = `p21-peer-${i}`;
    assert.equal(operations.useTask({ cwd: f.project, sessionId, taskId: f.started.task.id }).ok, true);
    assert.equal(operations.updateProgress({ cwd: f.project, sessionId, summary: '其他会话进度'.repeat(250) }).ok, true);
  }
  const first = recoverySection((await f.send())[0]);
  const before = f.dbState();
  assert.ok(await f.compactAll());
  const next = recoverySection((await f.send(undefined, 'budget after compaction'))[0]);
  assert.equal(next.text, first.text); assert.match(next.text, /Other participants/);
  assert.deepEqual(f.dbState(), before);
});

test('P2.1 real startup, persisted resume and fork retain correct participant identities and visible recovery', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.match(recoverySection((await f.send())[0]).text, /Current participant: session-p21-main/);
  await f.ctx.sessions.flush(f.agent.session);
  const stored = await f.ctx.sessionPersistence.open(SESSION, 'read');
  let prefix;
  try { prefix = (await stored.read()).events; } finally { await stored.close(); }
  const childId = 'session-p21-fork';
  const child = await f.create(childId, { meta: { cwd: f.project, parentSession: SESSION, isSeeded: true },
    seed: buildForkSeed(prefix, prefix.length - 1), inheritedEventCount: prefix.length });
  const childRequest = (await f.send(child.agent, 'fork request'))[0];
  const childCurrent = visibleRecovery(recoveryMessages(childRequest).at(-1));
  assert.match(childCurrent.text, /Current participant: session-p21-fork/);
  assert.match(childCurrent.text, /Current state: No progress recorded for this participant/);
  const participants = operations.participants({ cwd: f.project, sessionId: childId }).participants;
  assert.equal(participants.find(row => row.participantId === childId).parentSessionId, SESSION);
  assert.equal(participants.filter(row => row.participantId === SESSION).length, 1);
  await f.handle.dispose();
  const resumed = await f.ctx.agents.resume({ resumeSessionId: SESSION, agentOptions: { provider: 'offline', model: 'chat' } });
  f.handles.push(resumed);
  const resumedRequest = (await f.send(resumed.agent, 'resume request'))[0];
  const resumedCurrent = visibleRecovery(recoveryMessages(resumedRequest).at(-1));
  assert.match(resumedCurrent.text, /Current participant: session-p21-main/);
  assert.match(resumedCurrent.text, /Current state: database-before-compaction/);
  assert.equal(operations.participants({ cwd: f.project, sessionId: SESSION }).participants.filter(row => row.participantId === SESSION).length, 1);
  assert.equal(f.dbState().task.state, 'active');
});
