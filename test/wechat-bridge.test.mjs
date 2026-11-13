import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWechatBridge } from '../src/wechat-bridge.mjs';

const auth = { authorization: 'Bearer management-secret' };
const ownerMessage = (id, extra = {}) => ({ message_id: id, from_user_id: 'owner', to_user_id: 'wxbot',
  message_type: 1, context_token: 'context-secret', item_list: [{ type: 1, text_item: { text: `hello ${id}` } }], ...extra });
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('condition did not become true');
}
async function fixture(t, { failSend = false, failPost = false, loginResult, login, botWebUrl } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bridge-test-'));
  let bridge, sends = [], updates = [], posts = [], rows = [], postAttempts = 0, cursorSeen = [];
  const deps = {
    pollIntervalMs: 5,
    qrToDataURL: async () => 'data:image/png;base64,dGVzdA==',
    login: login ?? (async ({ onQr }) => {
      onQr('https://ilinkai.weixin.qq.com/qr/test');
      return loginResult ?? { connected: true, accountId: 'wxbot', botToken: 'bot-secret', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
    }),
    sdk: {
      getUpdates: async ({ get_updates_buf }) => { cursorSeen.push(get_updates_buf); return updates.shift() ?? { ret: 0, msgs: [] }; },
      sendMessage: async params => { sends.push(params); if (failSend) throw new Error('timeout secret'); return { ret: 0 }; },
    },
    fetch: async (url, options) => {
      assert.equal(options.headers.authorization, auth.authorization);
      if (url.endsWith('/api/state')) return Response.json({ bots: [{ id: 'chief', isMain: true }] });
      if (options.method === 'POST') {
        postAttempts++;
        const body = JSON.parse(options.body);
        let message = rows.find(r => r.clientMessageId === body.clientMessageId);
        if (!message) { message = { id: `user${posts.length}`, role: 'user', ...body }; posts.push(body); rows.push(message); }
        if (failPost) throw new Error('response lost after durable admission');
        return Response.json({ message });
      }
      return Response.json({ messages: [...rows], hasMore: false });
    },
  };
  const start = async () => {
    bridge = await startWechatBridge({ host: '127.0.0.1', botPort: 12345, token: 'management-secret', dataDir: dir, botWebUrl, deps });
    return bridge;
  };
  const request = (path, body, headers = auth) => fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const status = async () => (await request('/status')).json();
  const bind = async () => { await request('/bind/start', {}); await eventually(async () => (await status()).phase === 'connected'); };
  t.after(async () => { await bridge?.close(); await rm(dir, { recursive: true, force: true }); });
  await start();
  return { dir, deps, request, status, bind, sends, updates, posts, rows, cursorSeen, start,
    attempts: () => postAttempts, close: async () => { await bridge.close(); bridge = null; } };
}

test('management endpoints require bearer auth and status/HTML omit secrets', async t => {
  const f = await fixture(t);
  for (const [path, body] of [['/', undefined], ['/status', undefined], ['/bind/start', {}], ['/verify', { code: '1' }]]) {
    assert.equal((await f.request(path, body, {})).status, 401);
    assert.equal((await f.request(path, body, { authorization: 'Bearer wrong' })).status, 401);
  }
  await f.bind();
  const output = JSON.stringify(await f.status()) + await (await f.request('/')).text();
  for (const secret of ['bot-secret', 'management-secret', 'context-secret']) assert.ok(!output.includes(secret));
  assert.equal((await f.status()).owner, 'owner');
  assert.equal((await stat(join(f.dir, 'wechat'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.dir, 'wechat/state.json'))).mode & 0o777, 0o600);
});

test('QR status exposes rendered official QR and no credential fields while scan is pending', async t => {
  const f = await fixture(t, { login: async ({ onQr, signal }) => {
    onQr('http://untrusted.invalid/ignored');
    onQr('https://ilinkai.weixin.qq.com/official-qr');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { connected: false };
  } });
  await f.request('/bind/start', {});
  await eventually(async () => (await f.status()).phase === 'awaiting_scan');
  const status = await f.status();
  assert.deepEqual(status.qr, { url: 'https://ilinkai.weixin.qq.com/official-qr', image: 'data:image/png;base64,dGVzdA==' });
  assert.equal(status.owner, null);
  assert.equal(status.botToken, undefined);
  assert.equal(status.token, undefined);
});

test('structured questions include a configured public Bot webpage link', async t => {
  const f = await fixture(t, { botWebUrl: 'https://chief.example.test/bot/' }); await f.bind();
  f.rows.push({ id: 'form', role: 'bot', status: 'done', question: { request: {} } });
  await eventually(() => f.sends.length === 1);
  assert.match(f.sends[0].body.msg.item_list[0].text_item.text, /https:\/\/chief\.example\.test\/bot\//);
});

test('only confirmed owner USER direct messages enter Chief; unsupported media gets an honest notice', async t => {
  const f = await fixture(t); await f.bind();
  f.updates.push({ ret: 0, get_updates_buf: 'cursor1', msgs: [
    ownerMessage('attacker', { from_user_id: 'stranger' }), ownerMessage('bot', { message_type: 2 }),
    ownerMessage('group', { group_id: 'room' }), ownerMessage('otherbot', { to_user_id: 'other' }),
    ownerMessage('accepted'), ownerMessage('media', { item_list: [{ type: 2 }] }),
  ] });
  await eventually(() => f.posts.length === 1 && f.sends.length === 1);
  assert.equal(f.posts[0].text, 'hello accepted');
  assert.match(f.posts[0].clientMessageId, /^wx:[a-f0-9]{64}$/);
  assert.equal(f.sends[0].body.msg.to_user_id, 'owner');
  assert.match(f.sends[0].body.msg.item_list[0].text_item.text, /仅支持文字/);
  await eventually(() => f.cursorSeen.includes('cursor1'));
});

test('missing confirmed owner fails closed without enrolling a sender', async t => {
  const f = await fixture(t, { loginResult: { connected: true, accountId: 'wxbot', botToken: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' } });
  await f.request('/bind/start', {});
  await eventually(async () => (await f.status()).phase === 'error');
  f.updates.push({ ret: 0, msgs: [ownerMessage('random')] });
  assert.equal((await f.status()).owner, null);
  assert.equal(f.posts.length, 0);
});

test('inbound identity survives ambiguous Bot admission and bridge restart', async t => {
  const f = await fixture(t, { failPost: true }); await f.bind();
  f.updates.push({ ret: 0, get_updates_buf: 'committed', msgs: [ownerMessage('stable')] });
  await eventually(() => f.posts.length === 1);
  await f.close();
  const firstId = f.posts[0].clientMessageId;
  await f.start();
  f.updates.push({ ret: 0, msgs: [ownerMessage('stable')] });
  await eventually(async () => {
    const state = JSON.parse(await readFile(join(f.dir, 'wechat/state.json'), 'utf8'));
    return state.inbox[firstId]?.status === 'done';
  });
  assert.equal(f.posts.length, 1);
  assert.equal(f.attempts(), 1);
});

test('baseline skips old rows; only future final Chief replies and delayed followups go to WeChat', async t => {
  const f = await fixture(t);
  f.rows.push({ id: 'old', role: 'bot', status: 'done', text: 'old' });
  await f.bind();
  f.rows.push({ id: 'stream', role: 'bot', status: 'streaming', text: 'unfinished' },
    { id: 'relay', role: 'relay', status: 'done', text: 'relay' },
    { id: 'website', role: 'user', text: 'website user' });
  f.rows.push({ id: 'final', role: 'bot', status: 'done', text: 'final answer' });
  await eventually(() => f.sends.length === 1);
  assert.equal(f.sends[0].body.msg.item_list[0].text_item.text, 'final answer');
  f.rows.push({ id: 'later', role: 'bot', kind: 'taskreturn', status: 'done', text: 'delayed task summary' });
  f.rows.push({ id: 'question', role: 'bot', status: 'done', text: 'raw question', question: { request: {} } });
  await eventually(() => f.sends.length === 3);
  assert.deepEqual(f.sends.map(s => s.body.msg.item_list[0].text_item.text),
    ['final answer', 'delayed task summary', 'Chief 有问题需要你确认，请打开 Bot 网页处理。']);
  f.rows.find(r => r.id === 'stream').status = 'done';
  await eventually(() => f.sends.length === 4);
});

test('ambiguous outward send and persisted sending status never resend after restart', async t => {
  const f = await fixture(t, { failSend: true }); await f.bind();
  f.rows.push({ id: 'ambiguous', role: 'bot', status: 'done', text: 'once' });
  await eventually(async () => (await f.status()).unknownDeliveries === 1);
  assert.equal(f.sends.length, 1);
  await f.close();
  const path = join(f.dir, 'wechat/state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.outbox['bot:ambiguous'].status = 'sending';
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await f.start();
  await eventually(async () => (await f.status()).unknownDeliveries === 1);
  assert.equal(f.sends.length, 1);
});

test('outbound watcher continues during official long-poll and close aborts the poll', async t => {
  const f = await fixture(t); await f.bind();
  let polling = false, cancelled = false;
  f.deps.sdk.getUpdates = ({ abortSignal }) => new Promise(resolve => {
    polling = true;
    abortSignal.addEventListener('abort', () => { cancelled = true; resolve({ ret: 0, msgs: [] }); }, { once: true });
  });
  await eventually(() => polling);
  f.rows.push({ id: 'during-longpoll', role: 'bot', status: 'done', text: 'ready now' });
  await eventually(() => f.sends.length === 1);
  await f.close();
  assert.equal(cancelled, true);
});

test('missing inbound message identity does not advance the server cursor', async t => {
  const f = await fixture(t); await f.bind();
  f.updates.push({ ret: 0, get_updates_buf: 'unsafe-cursor', msgs: [ownerMessage(undefined)] });
  await eventually(async () => Boolean((await f.status()).error));
  assert.equal(f.posts.length, 0);
  const state = JSON.parse(await readFile(join(f.dir, 'wechat/state.json'), 'utf8'));
  assert.notEqual(state.cursor, 'unsafe-cursor');
});

test('expired credentials pause polling and require management rebind', async t => {
  const f = await fixture(t); await f.bind();
  f.updates.push({ ret: -14 });
  await eventually(async () => (await f.status()).phase === 'stale');
  assert.equal((await f.status()).connected, false);
});
