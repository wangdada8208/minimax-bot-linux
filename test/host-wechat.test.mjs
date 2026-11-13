import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const plugin = process.env.MINIMAX_BOT_PLUGIN;
const runtime = process.env.MINIMAX_BOT_WECHAT_RUNTIME;
test('real host serves the authenticated WeChat management page using the official SDK', {
  skip: !plugin || !runtime ? 'Set MINIMAX_BOT_PLUGIN and MINIMAX_BOT_WECHAT_RUNTIME' : false,
  timeout: 65000,
}, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'minimax-wechat-host-'));
  const token = randomUUID();
  const child = spawn(process.execPath, ['src/host.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, MINIMAX_BOT_HOST: '127.0.0.1', MINIMAX_BOT_PORT: String(port),
      MINIMAX_BOT_DATA: dir, MINIMAX_DATA_DIR: join(dir, 'runtime'), MINIMAX_BOT_CWD: dir,
      MINIMAX_BOT_PLUGIN: plugin, MINIMAX_BOT_WECHAT_RUNTIME: runtime, MINIMAX_BOT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  try {
    const deadline = Date.now() + 45000;
    while (!output.includes('MiniMax Bot is ready.') && child.exitCode === null && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(output.includes('MiniMax Bot is ready.'), output.slice(-1500));
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin + '/wechat/')).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    const redirect = await fetch(origin + '/wechat', { headers, redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/wechat/');
    const page = await fetch(origin + '/wechat/', { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Chief/);
    assert.ok(!html.includes(token));
    const status = await fetch(origin + '/wechat/status', { headers: { cookie: `minimax_bot=${token}` } });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.connected, false);
    assert.equal(body.phase, 'unbound');
    assert.ok(!JSON.stringify(body).includes(token));
    assert.equal((await fetch(origin + '/api/state', { headers })).status, 200);
  } finally {
    child.kill('SIGTERM');
    const exit = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
    const force = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exit; clearTimeout(force);
  }
});
