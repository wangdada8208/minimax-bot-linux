import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startMobileBridge } from '../src/mobile-bridge.mjs';

async function fixture(t) {
  const state = { bots: [{ id: 'bot_a', name: 'A', isMain: true }, { id: 'bot_b', name: 'B' }], groups: [{ id: 'grp_a', name: 'G', memberIds: ['bot_a'], adminId: 'bot_a', replyMode: 'admin' }], chats: { 'bot:bot_a': { lastTs: 10 } }, busyChats: [], schedules: [], settings: {} };
  const model = { providerId: 'custom_provider:magpie', modelId: 'service:model:full', variants: ['thinking', ''], thinking: { efforts: ['low', 'high'], default: 'high' } };
  const history = { 'bot:bot_a': [], 'bot:bot_b': [], 'group:grp_a': [] };
  const calls = [];
  let memoryError = false;
  let historyDelay = 0, activeReads = 0, maxReads = 0;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/state') return send(state);
    if (url.pathname === '/api/models') return send({ models: [model], default: model });
    const chat = /^\/api\/chats\/((?:bot|group):\w+)\/(messages|cancel)$/.exec(url.pathname);
    if (chat) {
      if (chat[2] === 'cancel') return send({ cancelled: true });
      const messages = history[chat[1]];
      if (req.method === 'POST') {
        let message = messages.find((m) => m.clientMessageId === body.clientMessageId);
        if (message && message.text !== body.text) return send({ error: 'invalid', message: 'id conflict' }, 400);
        if (!message) { message = { id: `msg_${messages.length}`, role: 'user', clientMessageId: body.clientMessageId, text: body.text, chatId: chat[1], dispatchState: 'pending' }; messages.push(message); }
        return send({ message });
      }
      const captured = structuredClone(messages);
      activeReads++; maxReads = Math.max(maxReads, activeReads);
      if (historyDelay) await new Promise((resolve) => setTimeout(resolve, historyDelay));
      activeReads--;
      const end = url.searchParams.has('before') ? messages.findIndex((m) => m.id === url.searchParams.get('before')) : messages.length;
      const start = Math.max(0, end - Number(url.searchParams.get('limit')));
      const page = captured.slice(start, end);
      return send({ messages: page, hasMore: start > 0, nextBefore: start > 0 ? page[0].id : null });
    }
    if (url.pathname.startsWith('/api/memory/')) {
      if (memoryError) return send({ error: 'memory_failed', message: 'read failed' }, 500);
      const entries = [{ id: 'abcdef12', text: 'remembered', key: 'topic', revision: 'r1' }];
      return send({ entries, chars: 10, budget: { limit: 100000, entryMax: 1200, entryLimit: 1000 }, contextBudget: { limit: 6000 }, entry: entries[0], unchanged: false });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/bots/')) { const bot = state.bots.find((b) => url.pathname.endsWith(b.id)); Object.assign(bot, body); return send({ bot }); }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/groups/')) { Object.assign(state.groups[0], body, body.members ? { memberIds: body.members } : {}, body.admin ? { adminId: body.admin } : {}); return send({ group: state.groups[0] }); }
    if (url.pathname === '/api/bots') return send({ bot: { ...body, id: 'bot_copy' } });
    if (url.pathname === '/api/settings') { Object.assign(state.settings, body); return send({ settings: state.settings }); }
    if (url.pathname === '/api/schedules') return send({ schedule: body });
    if (url.pathname.startsWith('/api/approvals/')) return send({ ok: true });
    return send({ error: 'not_found', message: 'unknown route' }, 404);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const bridge = await startMobileBridge({ port: upstream.address().port, host: '127.0.0.1', token: 'synthetic', pollIntervalMs: 20 });
  t.after(() => { bridge.close(); upstream.closeAllConnections(); upstream.close(); });
  const request = async (path, body, token = 'synthetic') => { const response = await fetch(`http://127.0.0.1:${bridge.port}/api/mobile/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, value: await response.json() }; };
  const action = (endpoint, payload = {}) => request('actions', { endpoint, payload });
  return { state, model, history, calls, bridge, request, action, delayHistory: (ms) => { historyDelay = ms; }, maxReads: () => maxReads, memoryError: () => { memoryError = true; } };
}

test('history forwards cursor/limit without truncating split parents and reports authoritative metadata', async (t) => {
  const f = await fixture(t);
  f.history['bot:bot_a'] = [0, 1, 2].map((seq) => ({ id: `msg_${seq}`, seq, chatId: 'bot:bot_a', role: 'bot', parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }));
  const page = (await f.request('conversations/bot_a/messages?limit=1')).value;
  assert.equal(page.messages.length, 2); assert.equal(page.cursor, 'msg_2'); assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map((m) => [m.seq, m.sourceSeq, m.sourceMessageId, m.partIndex]), [[2, 2, 'msg_2', 0], [2, 2, 'msg_2', 1]]);
  assert.deepEqual(page.replacedMessageIds, ['msg_2']);
  const older = (await f.request(`conversations/bot_a/messages?limit=2&cursor=${page.cursor}`)).value;
  assert.equal(older.messages[0].sourceMessageId, 'msg_0'); assert.equal(older.hasMore, false);
  assert.equal((await f.request('conversations/bot_a/messages?limit=0')).status, 422);
});

test('source revisions are stable, monotonic and immune to older overlapping history reads', async (t) => {
  const f = await fixture(t);
  const message = { id: 'msg_revision', seq: 10, status: 'streaming', parts: [{ type: 'text', text: 'commentary' }, { type: 'text', text: 'tail' }] };
  f.history['bot:bot_a'] = [message];
  const read = async () => (await f.request('conversations/bot_a/messages')).value.messages;
  const first = await read();
  assert.deepEqual(first.map((m) => m.pending), [false, true]);
  assert.equal(first[0].updatedSeq, first[1].updatedSeq);
  assert.equal((await read())[0].updatedSeq, first[0].updatedSeq);
  f.delayHistory(100);
  const initialCalls = f.calls.filter((c) => c.path.endsWith('/messages')).length;
  const delayed = read();
  while (f.calls.filter((c) => c.path.endsWith('/messages')).length === initialCalls) await new Promise((resolve) => setTimeout(resolve, 2));
  f.delayHistory(0); message.parts[1].text = 'newer tail';
  const newer = await read();
  assert.ok(newer[0].updatedSeq > first[0].updatedSeq);
  assert.equal(newer[0].sourceRevision, newer[0].updatedSeq);
  assert.deepEqual(await delayed, newer);
  message.status = 'done';
  const completed = await read();
  assert.ok(completed[0].updatedSeq > newer[0].updatedSeq);
  assert.deepEqual(completed.map((m) => m.pending), [false, false]);
});

test('approval decisions faithfully allow once or reject and never silently deny unsupported decisions', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action('approval-resolve', { id: 'approval_a', decision: 'allowed-always' })).status, 422);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/api/approvals/')).length, 0);
  await f.action('approval-resolve', { id: 'approval_a', decision: 'allowed-once' });
  await f.action('approval-resolve', { id: 'approval_a', decision: 'rejected' });
  assert.deepEqual(f.calls.filter((c) => c.path.startsWith('/api/approvals/')).map((c) => c.body.decision), ['allowOnce', 'deny']);
});

test('receipts recover durable history, deduplicate, expose uncertainty and preserve errors', async (t) => {
  const f = await fixture(t);
  const body = { requestId: 'request-1', conversationId: 'bot_a', sessionId: 'old-session', text: 'hello', attachments: [] };
  assert.equal((await f.request('submissions', body)).value.sessionId, 'bot:bot_a');
  await f.request('submissions', body); assert.equal(f.history['bot:bot_a'].length, 1);
  assert.equal((await f.request('submissions/request-1')).value.messageId, 'msg_0');
  f.history['bot:bot_a'][0].dispatchState = 'uncertain';
  assert.equal((await f.request('submissions/request-1')).value.status, 'uncertain');
  const conflict = await f.request('submissions', { ...body, text: 'different' });
  assert.deepEqual(conflict.value.error, { code: 'invalid', message: 'id conflict' });
  assert.equal((await f.request('submissions/missing')).status, 404);
  assert.equal((await f.request('state', undefined, 'wrong')).value.error.code, 'unauthorized');
  assert.equal((await f.request('conversations/bot_a/cancel', {})).value.cancelled, true);
});

test('receipt recovery scans preexisting older upstream pages without local receipts', async (t) => {
  const f = await fixture(t);
  f.history['bot:bot_a'] = Array.from({ length: 501 }, (_, seq) => ({ id: `msg_${seq}`, role: 'user', text: 'persisted', clientMessageId: seq === 0 ? 'durable-old' : `other-${seq}` }));
  const result = await f.request('submissions/durable-old');
  assert.equal(result.status, 200); assert.equal(result.value.messageId, 'msg_0');
  assert.ok(f.calls.some((call) => call.query.get('before') === 'msg_1'));
});

test('models preserve exact provider/model and effort and default selection', async (t) => {
  const f = await fixture(t); const ref = `${f.model.providerId}:${f.model.modelId}`;
  const team = (await f.request('state')).value;
  assert.equal(team.defaultModel, ref); assert.equal(team.bots[0].appliedModel, ref);
  assert.deepEqual(team.models[0].reasoning.efforts.map((e) => e.id), ['low', 'high', 'off']);
  await f.action('update-bot', { id: 'bot_a', model: ref, effort: 'off' });
  assert.deepEqual(f.state.bots[0].model, { providerId: f.model.providerId, modelId: f.model.modelId, variant: '' });
  await f.action('update-bot', { id: 'bot_a', model: ref }); assert.equal(f.state.bots[0].model.variant, '');
  await f.action('update-bot', { id: 'bot_a', effort: 'low' }); assert.equal(f.state.bots[0].model.thinking.effort, 'low');
  f.state.bots[0].model = { providerId: 'custom_provider', modelId: `magpie:${f.model.modelId}`, variant: '' };
  await f.action('update-bot', { id: 'bot_a', model: ref });
  assert.deepEqual(f.state.bots[0].model, { providerId: f.model.providerId, modelId: f.model.modelId, variant: '' });
  await f.action('update-bot', { id: 'bot_a', model: null }); assert.equal(f.state.bots[0].model, null);
});

test('group, main, prefs, flags and duplication translate only supported semantics', async (t) => {
  const f = await fixture(t);
  const group = (await f.action('update-room', { id: 'grp_a', members: ['bot_b'], admin: 'bot_b', mode: 'everyone' })).value;
  assert.deepEqual(group.members, ['bot_b']); assert.equal(group.admin, 'bot_b'); assert.equal(group.mode, 'everyone');
  assert.equal((await f.action('set-main', { id: 'bot_b', primary: true })).status, 422);
  await f.action('set-main', { id: 'bot_b', replace: true });
  assert.equal(f.state.bots[0].isMain, false); assert.equal(f.state.bots[1].isMain, true);
  assert.equal((await f.action('set-prefs', { motion: 'off' })).status, 422);
  await f.action('set-prefs', { language: 'en' }); assert.equal(f.state.settings.language, 'en');
  assert.equal((await f.action('set-flags', { id: 'bot_a', hidden: true })).status, 422);
  await f.action('set-flags', { id: 'bot_a', pinned: true }); assert.equal(f.state.bots[0].pinned, true);
  assert.equal((await f.action('duplicate-bot', { id: 'bot_a', name: 'Copy' })).value.name, 'Copy');
});

test('memory reads preserve scopes/budgets/errors; queries do not write; saves use response contract', async (t) => {
  const f = await fixture(t);
  const view = (await f.action('memory-view')).value;
  assert.deepEqual(view.entries.map((e) => e.scope), ['team']); assert.equal(view.sizes.own, 0); assert.equal(view.limits.main, 100000);
  const answer = (await f.action('memory-save', { botId: 'bot_a', text: 'remembered' })).value;
  assert.equal(answer.view.entries.length, 2); assert.equal(answer.view.entries[0].id, 'abcdef12'); assert.equal(answer.changes[0].ok, true);
  assert.equal((await f.action('memory-ask', { text: 'question?' })).status, 422);
  assert.equal((await f.action('memory-forget', { botId: 'bot_a', text: 'remembered' })).status, 422);
  await f.action('memory-forget', { botId: 'bot_a', id: 'abcdef12' });
  assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/abcdef12')));
  f.memoryError(); assert.equal((await f.action('memory-view')).value.error.message, 'read failed');
});

test('schedule validation rejects silent upstream coercions and unsupported targets/timezones', async (t) => {
  const f = await fixture(t);
  for (const when of [{ kind: 'weekly' }, { kind: 'every', minutes: 4 }, { kind: 'every', minutes: 10081 }, { kind: 'daily', time: '25:00' }, { kind: 'daily', time: '09:00', timeZone: 'Unsupported/Zone' }, { kind: 'at', at: 'invalid' }, { kind: 'at', at: new Date(Date.now() - 60000).toISOString() }, { kind: 'at', at: new Date(Date.now() + 8 * 86400000).toISOString() }]) assert.equal((await f.action('schedule-create', { target: 'bot_a', when })).status, 422);
  assert.equal((await f.action('schedule-create', { target: 'grp_a', when: { kind: 'every', minutes: 5 } })).status, 422);
  assert.equal((await f.action('schedule-create', { target: 'bot_a', when: { kind: 'every', minutes: 5 }, prompt: 'test' })).status, 200);
  assert.equal(f.calls.filter((c) => c.path === '/api/schedules').length, 1);
});

test('websocket auth gives initial snapshot and polls intermediate text with constant lastTs and busy', async (t) => {
  const f = await fixture(t);
  f.delayHistory(35);
  f.history['bot:bot_a'] = [{ id: 'msg_live', seq: 1, text: 'first', status: 'streaming' }];
  const ws = new WebSocket(`ws://127.0.0.1:${f.bridge.port}/api/mobile/v1/events`);
  t.after(() => ws.terminate());
  const events = []; ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token: 'synthetic', conversationId: 'bot_a' }));
  const waitFor = async (predicate) => { const start = Date.now(); while (!events.some(predicate)) { if (Date.now() - start > 2000) assert.fail('snapshot timeout'); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  await waitFor((e) => e.type === 'reset' && e.messages[0].text === 'first');
  f.history['bot:bot_a'][0].text = 'intermediate'; f.state.busyChats = ['bot:bot_a'];
  await waitFor((e) => e.type === 'reset' && e.messages[0].text === 'intermediate' && e.busy === true);
  const latest = events.filter((e) => e.type === 'reset').at(-1);
  assert.deepEqual(latest.replacedMessageIds, ['msg_live']); assert.equal(latest.messages[0].pending, true);
  assert.equal(f.maxReads(), 1, 'broadcast history requests must never overlap');
});
