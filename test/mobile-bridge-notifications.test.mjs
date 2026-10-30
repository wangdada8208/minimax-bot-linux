import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMobileBridge } from '../src/mobile-bridge.mjs';

async function fixture(t, options = {}) {
  const state = {
    bots: [{ id: 'bot_a', name: 'A', isMain: true }],
    groups: [],
    chats: { 'bot:bot_a': { lastTs: 10 } },
    approvals: [],
    busyChats: [],
    schedules: [],
    settings: {},
  };
  const history = { 'bot:bot_a': [{ id: 'msg_old', role: 'bot', seq: 1, text: 'hello' }] };
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/state') return send(state);
    if (url.pathname === '/api/models') return send({ models: [], default: null });
    const chat = /^\/api\/chats\/((?:bot|group):\w+)\/messages$/.exec(url.pathname);
    if (chat) {
      const messages = history[chat[1]] || [];
      const end = url.searchParams.has('before') ? messages.findIndex((m) => m.id === url.searchParams.get('before')) : messages.length;
      const start = Math.max(0, end - Number(url.searchParams.get('limit') || 40));
      return send({ messages: messages.slice(start, end), hasMore: start > 0 });
    }
    return send({ error: 'not_found', message: 'unknown route' }, 404);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const bridge = await startMobileBridge({ port: upstream.address().port, host: '127.0.0.1', token: 'synthetic', pollIntervalMs: 20, notifyIntervalMs: 20, ...options });
  t.after(() => { bridge.close(); upstream.closeAllConnections(); upstream.close(); });
  const request = async (path, body, token = 'synthetic') => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const action = (endpoint, payload = {}) => request('/api/mobile/v1/actions', { endpoint, payload });
  const inbox = async () => (await action('notifications-list')).value;
  return { state, history, request, action, inbox };
}

const waitFor = async (check, timeout = 2000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for notifications');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('existing history is a baseline, not a burst of notifications', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const value = await f.inbox();
  assert.deepEqual(value.items, []);
  assert.equal(value.cursor, 0);
  assert.equal(value.preferences.enabled, false);
  assert.deepEqual(value.preferences.categories, ['reply', 'question', 'approval']);
  assert.equal(value.pushRegistered, false);
});

test('approvals and finished replies become notifications with the right kind', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 80));
  f.state.approvals = [{ requestId: 'req_1', chatId: 'bot:bot_a', toolName: 'shell' }];
  f.history['bot:bot_a'].push({ id: 'msg_2', role: 'bot', seq: 2, text: 'done with the task' });
  f.state.chats['bot:bot_a'].lastTs = 20;
  const items = await waitFor(async () => { const value = await f.inbox(); return value.items.length >= 2 ? value.items : null; });
  assert.deepEqual(items.map((item) => [item.conversationId, item.kind]).sort(), [['bot_a', 'approval'], ['bot_a', 'reply']]);
  assert.ok(items.every((item) => item.read === false));

  // A trailing question mark marks the message as a question for the user.
  f.history['bot:bot_a'].push({ id: 'msg_3', role: 'bot', seq: 3, text: 'should I continue?' });
  f.state.chats['bot:bot_a'].lastTs = 30;
  const question = await waitFor(async () => { const value = await f.inbox(); return value.items.find((item) => item.kind === 'question'); });
  assert.equal(question.conversationId, 'bot_a');
});

test('streaming replies and user messages never notify', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 80));
  f.history['bot:bot_a'].push({ id: 'msg_4', role: 'bot', status: 'streaming', seq: 4, text: 'partial' });
  f.state.chats['bot:bot_a'].lastTs = 40;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual((await f.inbox()).items, []);
  f.history['bot:bot_a'].push({ id: 'msg_5', role: 'user', seq: 5, text: 'my own message' });
  f.state.chats['bot:bot_a'].lastTs = 50;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual((await f.inbox()).items, []);
});

test('preferences and read state round-trip with validation', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 80));
  f.state.approvals = [{ requestId: 'req_1', chatId: 'bot:bot_a' }];
  await waitFor(async () => (await f.inbox()).items.length === 1);
  const enabled = await f.action('notifications-preferences', { enabled: true, categories: ['approval'] });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.value.preferences.enabled, true);
  assert.deepEqual(enabled.value.preferences.categories, ['approval']);
  assert.equal((await f.action('notifications-preferences', { enabled: 'yes' })).status, 422);
  assert.equal((await f.action('notifications-preferences', { enabled: true, categories: ['nope'] })).status, 422);
  assert.equal((await f.action('notifications-preferences', { enabled: true, extra: 1 })).status, 422);

  const read = await f.action('notifications-read', { through: enabled.value.cursor });
  assert.equal(read.value.accepted, true);
  assert.equal((await f.inbox()).items.every((item) => item.read), true);
  assert.equal((await f.action('notifications-read', { through: -1 })).status, 422);
  assert.equal((await f.action('notifications-read', { ids: ['x'] })).status, 422);
});

test('background receiver uses a lease token, honours cursor and categories', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const registered = await f.action('notifications-background-register');
  assert.equal(registered.status, 200);
  const { token, cursor, expiresAt } = registered.value;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cursor, 0);
  assert.ok(expiresAt > Date.now() + 60_000);
  assert.notEqual(token, 'synthetic');

  f.state.approvals = [{ requestId: 'req_1', chatId: 'bot:bot_a' }];
  f.history['bot:bot_a'].push({ id: 'msg_6', role: 'bot', seq: 6, text: 'finished' });
  f.state.chats['bot:bot_a'].lastTs = 60;
  await waitFor(async () => (await f.inbox()).items.length === 2);

  const poll = (body, lease = token) => f.request('/mobile/v1/notifications/background', body, lease);
  const first = await poll({ cursor: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.value.deliveryEnabled, false);
  assert.deepEqual(first.value.items.map((item) => item.kind), ['approval', 'reply']);
  assert.equal(first.value.cursor, 2);

  const caughtUp = await poll({ cursor: first.value.cursor });
  assert.deepEqual(caughtUp.value.items, []);

  await f.action('notifications-preferences', { enabled: true, categories: ['approval'] });
  f.state.approvals.push({ requestId: 'req_2', chatId: 'bot:bot_a' });
  f.history['bot:bot_a'].push({ id: 'msg_7', role: 'bot', seq: 7, text: 'another reply' });
  f.state.chats['bot:bot_a'].lastTs = 70;
  await waitFor(async () => (await f.inbox()).cursor === 4);
  const filtered = await poll({ cursor: first.value.cursor });
  assert.equal(filtered.value.deliveryEnabled, true);
  assert.deepEqual(filtered.value.items.map((item) => item.kind), ['approval']);
  // The path without /api is what the native receiver requests.
  assert.equal((await f.request('/api/mobile/v1/notifications/background', { cursor: 0 }, token)).status, 200);

  assert.equal((await poll({ cursor: 0 }, 'nope')).status, 401);
  assert.equal((await poll({ cursor: 0 }, 'synthetic')).status, 401);
  await f.action('notifications-background-unregister');
  assert.equal((await poll({ cursor: 0 })).status, 401);
});

test('cloud push is reported as unavailable instead of pretending to work', async (t) => {
  const f = await fixture(t);
  const registered = await f.action('notifications-register', { token: 'device' });
  assert.equal(registered.status, 422);
  assert.equal(registered.value.error.code, 'unsupported');
  assert.equal((await f.action('notifications-test')).status, 422);
  assert.equal((await f.action('notifications-unregister')).status, 200);
});

test('the inbox survives a bridge restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minibot-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(dir, 'notifications.json');
  const first = await fixture(t, { notifyStorePath: store });
  await new Promise((resolve) => setTimeout(resolve, 80));
  first.state.approvals = [{ requestId: 'req_1', chatId: 'bot:bot_a' }];
  const before = await waitFor(async () => { const value = await first.inbox(); return value.items.length ? value : null; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await fixture(t, { notifyStorePath: store });
  const after = await waitFor(async () => { const value = await second.inbox(); return value.items.length ? value : null; });
  assert.deepEqual(after.items, before.items);
  assert.equal(after.cursor, before.cursor);
  // The approval already recorded is not announced twice.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await second.inbox()).items.length, 1);
});

test('a running turn waits for its final answer and user messages stay silent', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => setTimeout(resolve, 80));
  f.history['bot:bot_a'].push({ id: 'msg_8', role: 'bot', seq: 8, text: 'working' });
  f.state.chats['bot:bot_a'] = { lastTs: 80, lastRole: 'bot', pending: true };
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual((await f.inbox()).items, []);

  f.state.chats['bot:bot_a'] = { lastTs: 90, lastRole: 'bot', pending: false };
  const items = await waitFor(async () => { const value = await f.inbox(); return value.items.length ? value.items : null; });
  assert.deepEqual(items.map((item) => item.kind), ['reply']);

  f.state.chats['bot:bot_a'] = { lastTs: 100, lastRole: 'user', pending: false };
  f.history['bot:bot_a'].push({ id: 'msg_9', role: 'user', seq: 9, text: 'mine' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await f.inbox()).items.length, 1);
});
