import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const pluginRoot = process.env.MINIMAX_BOT_PLUGIN;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * The host could not start after an edit removed a variable declaration, and
 * nothing caught it because no test ever booted the real process. This one
 * boots it against the pinned plugin and requires it to answer.
 */
test('the host boots and serves the Bot page', { skip: !pluginRoot && 'MINIMAX_BOT_PLUGIN is not set' }, async () => {
  const port = await freePort();
  const token = randomUUID();
  const dataDir = mkdtempSync(join(tmpdir(), 'minimax-bot-host-'));
  const child = spawn(process.execPath, ['src/host.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      MINIMAX_BOT_HOST: '127.0.0.1',
      MINIMAX_BOT_PORT: String(port),
      MINIMAX_BOT_DATA: dataDir,
      MINIMAX_DATA_DIR: join(dataDir, 'runtime'),
      MINIMAX_BOT_CWD: dataDir,
      MINIMAX_BOT_PLUGIN: pluginRoot,
      MINIMAX_BOT_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const started = Date.now();
    // Wait for the listening line rather than a fixed delay.
    while (!/MiniMax Bot is ready/.test(output)) {
      if (child.exitCode !== null) break;
      if (Date.now() - started > 45_000) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(child.exitCode, null, `the host exited during startup:\n${output.slice(-2000)}`);
    assert.match(output, /MiniMax Bot is ready/, `the host never became ready:\n${output.slice(-2000)}`);

    const response = await fetch(`http://127.0.0.1:${port}/bot`, {
      headers: { cookie: `minimax_bot=${token}` },
    });
    assert.equal(response.status, 200, 'the Bot page is served');
    const html = await response.text();
    assert.match(html, /host-update\.js/, 'the update control is injected');

    // The phone bridge must be listening too; it broke when its startup call
    // was removed and only showed up as a 500 on the first mobile request.
    const mobile = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/info`, {
      headers: { cookie: `minimax_bot=${token}` },
    });
    assert.equal(mobile.status, 200, 'the mobile bridge info is served');
    // Info is static and cannot detect a bridge pointing at an unused port.
    // Read data through the bridge to exercise its real upstream connection.
    const conversations = await fetch(`http://127.0.0.1:${port}/api/mobile/v1/conversations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(conversations.status, 200, 'the bridge reaches the real plugin');
    assert.ok(Array.isArray((await conversations.json()).conversations));
    if (process.platform === 'linux') {
      const descendants = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(child.pid)], { encoding: 'utf8' });
      const runner = descendants.split('\n').find((line) => line.includes('src/official-runner.mjs'));
      assert.ok(runner, 'the official runtime owns a separate plugin process');
      const runnerPid = Number(runner.trim().split(/\s+/)[0]);
      assert.ok(Number.isSafeInteger(runnerPid) && runnerPid > 1);
      process.kill(runnerPid, 'SIGKILL');
      const deadline = Date.now() + 10_000;
      while (child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(child.exitCode, 1, 'a dead plugin makes the guard exit so the watchdog can recover');
    }
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
