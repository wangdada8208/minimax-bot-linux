import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostMiniAppPortRegistry, startOfficialBotRuntime } from '../src/official-host.mjs';

async function fixture(t, source, { extensions = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'official-miniapp-test-'));
  // The official direct-root terminator intentionally unrefs its polling timers;
  // the deployed host's guard provides this live event-loop owner.
  const hostHandle = setInterval(() => {}, 1000);
  t.after(async () => { clearInterval(hostHandle); await rm(root, { recursive: true, force: true }); });
  const pluginRoot = join(root, 'plugin');
  const dataDir = join(root, 'data');
  await Promise.all(['.minimax-plugin', 'miniapp/client', 'miniapp/node', 'node_modules'].map((dir) => mkdir(join(pluginRoot, dir), { recursive: true })));
  await writeFile(join(pluginRoot, '.minimax-plugin/plugin.json'), JSON.stringify({ schemaVersion: 1, name: 'test-bot', displayName: 'Test Bot', version: '1.0.0', description: 'Test', author: 'Test', icon: 'icon.png', category: 'Other', exampleQueries: [], apps: [], mcpServers: [], skills: [] }));
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ mcode: { schemaVersion: 2, miniApp: './miniapp/miniapp.json' } }));
  await writeFile(join(pluginRoot, 'icon.png'), 'test');
  await writeFile(join(pluginRoot, 'miniapp/client/index.html'), '<!doctype html>test');
  await writeFile(join(pluginRoot, 'node_modules/excluded.mjs'), 'not a runtime payload');
  const manifest = { schemaVersion: 1, artifacts: { client: ['./miniapp/client'], node: ['./miniapp/node'] }, runtime: { kind: 'process', entry: './miniapp/node/server.mjs', lifecycle: 'on-demand' }, surface: { path: '/bot', ...(extensions ? { window: { width: 1180 } } : {}) }, mcpEndpoints: [], ...(extensions ? { agentAccess: ['session.run'] } : {}) };
  await writeFile(join(pluginRoot, 'miniapp/miniapp.json'), JSON.stringify(manifest));
  await writeFile(join(pluginRoot, 'miniapp/node/server.mjs'), source);
  const portRegistry = new HostMiniAppPortRegistry();
  const options = { pluginRoot, dataDir, cwd: root, portRegistry, runnerStartTimeoutMs: 2000 };
  const start = async (overrides = {}) => {
    const runtime = await startOfficialBotRuntime({ ...options, ...overrides });
    t.after(() => runtime.stop());
    return runtime;
  };
  return { root, pluginRoot, dataDir, start, options, portRegistry, manifest };
}

const serverSource = `
  import { createServer } from 'node:http';
  import { access, appendFile, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  export async function start(context) {
    await appendFile(join(context.dataDir, 'attempts'), context.listen.port + '\\n');
    let excluded = true;
    try { await access(join(context.pluginRoot, 'node_modules/excluded.mjs')); excluded = false; } catch {}
    const state = { pid: process.pid, pluginRoot: context.pluginRoot, excluded,
      frozen: Object.isFrozen(context) && Object.isFrozen(context.listen) && Object.isFrozen(context.agent),
      agentMethods: Object.keys(context.agent), port: context.listen.port };
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(context.listen.port, context.listen.host, resolve); });
    context.signal.addEventListener('abort', () => { state.aborted = true; });
    return { dispose: async () => {
      await writeFile(join(context.dataDir, 'disposed'), JSON.stringify({ aborted: state.aborted }));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    } };
  }
`;

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
}

test('official child freezes context, materializes payload, aborts before dispose, and proves root exit', async (t) => {
  const f = await fixture(t, serverSource, { extensions: true });
  const originalManifest = await readFile(join(f.pluginRoot, 'miniapp/miniapp.json'), 'utf8');
  const runtime = await f.start();
  const state = await (await fetch(runtime.origin)).json();
  assert.notEqual(state.pid, process.pid);
  assert.notEqual(state.pluginRoot, f.pluginRoot);
  assert.equal(state.excluded, true);
  assert.equal(state.frozen, true);
  assert.deepEqual(state.agentMethods, ['run', 'answer', 'reply', 'models']);
  assert.equal(await readFile(join(state.pluginRoot, 'miniapp/miniapp.json'), 'utf8'), originalManifest);
  assert.equal(f.portRegistry.isReserved({ pluginId: 'test-bot', port: runtime.port }), true);
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping, 'official stop is idempotent');
  assert.deepEqual(await stopping, { proven: true });
  assert.equal((await runtime.closed).shutdownRequested, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'disposed'), 'utf8')), { aborted: true });
  assertGone(state.pid);
  await assert.rejects(access(state.pluginRoot), { code: 'ENOENT' });
  assert.equal(f.portRegistry.isReserved({ pluginId: 'test-bot', port: runtime.port }), false);
  assert.equal(await readFile(join(f.pluginRoot, 'miniapp/miniapp.json'), 'utf8'), originalManifest);
});

for (const [label, source, expected] of [
  ['missing start', 'export const nope = true;', 'START_EXPORT_MISSING'],
  ['invalid dispose', 'export function start() { return {}; }', 'RUNNER_LIFECYCLE_INVALID'],
  ['thrown start', 'export function start() { throw new Error("synthetic startup failure"); }', 'RUNNER_START_FAILED'],
  ['TCP readiness failure', 'export function start() { return { dispose() {} }; }', 'READINESS_TIMEOUT'],
]) {
  test(`official child reports ${label} and releases its reservation`, async (t) => {
    const f = await fixture(t, source);
    const reservations = [];
    const reserve = f.portRegistry.reserve.bind(f.portRegistry);
    f.portRegistry.reserve = (input) => { reservations.push(input); return reserve(input); };
    await assert.rejects(f.start({ runnerStartTimeoutMs: 600 }), (error) => error.code === expected);
    assert.equal(reservations.length, 1);
    for (const input of reservations) assert.equal(f.portRegistry.isReserved(input), false);
  });
}

test('official adapter retries a real EADDRINUSE in a new child and releases all reservations', async (t) => {
  const blocker = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  // Ask the OS for a dynamic port until it falls in the official candidate range.
  // Linux normally allocates these within its ephemeral range below 65536.
  let busy = blocker.address().port;
  if (busy < 49152) {
    await new Promise((resolve) => blocker.close(resolve));
    for (let port = 55000; port < 56000; port++) {
      try { await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', resolve); }); busy = port; break; } catch {}
    }
  }
  assert.ok(busy >= 49152);
  const f = await fixture(t, serverSource);
  const runtime = await f.start({ preferredPort: busy });
  assert.notEqual(runtime.port, busy);
  assert.deepEqual((await readFile(join(f.dataDir, 'attempts'), 'utf8')).trim().split('\n').map(Number), [busy, runtime.port]);
  await runtime.stop();
  for (const port of [busy, runtime.port]) assert.equal(f.portRegistry.isReserved({ pluginId: 'test-bot', port }), false);
});

test('official registry preserves ownership when an earlier reservation is released twice', () => {
  const registry = new HostMiniAppPortRegistry(new Set([50000]));
  assert.equal(registry.reserve({ pluginId: 'a', processGeneration: 'a', port: 50000 }), undefined);
  const input = { pluginId: 'a', processGeneration: 'a', port: 50001 };
  const first = registry.reserve(input);
  assert.ok(first);
  assert.equal(registry.reserve(input), undefined);
  first.release();
  const second = registry.reserve({ ...input, processGeneration: 'b' });
  assert.ok(second);
  first.release();
  assert.equal(registry.isReserved(input), true);
  second.release();
});

test('ACP subprocess uses the actual retry-selected MCP port and is disposed with the official lifecycle', async (t) => {
  const source = serverSource.replace('const state = {', `await context.agent.run({ text: 'hello' });\n    const state = {`);
  const f = await fixture(t, source, { extensions: true });
  const cli = join(f.root, 'fake-mcode.js');
  await writeFile(cli, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const path = require('node:path');
    const root = process.cwd();
    fs.writeFileSync(path.join(root, 'acp-pid'), String(process.pid));
    process.on('SIGTERM', () => { fs.writeFileSync(path.join(root, 'acp-stopped'), 'yes'); process.exit(0); });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      let result = {};
      if (m.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
      if (m.method === 'session/new') { fs.writeFileSync(path.join(root, 'session-new'), JSON.stringify(m.params)); result = { sessionId: 'synthetic' }; }
      if (m.method === 'session/prompt') result = { stopReason: 'end_turn' };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
  `);
  const runtime = await f.start({ mcode: cli });
  const session = JSON.parse(await readFile(join(f.root, 'session-new'), 'utf8'));
  assert.equal(session.cwd, f.root);
  assert.equal(session.mcpServers[0].url, `${runtime.origin}/mcp/minimax-bot`);
  const acpPid = Number(await readFile(join(f.root, 'acp-pid'), 'utf8'));
  await runtime.stop();
  assert.equal(await readFile(join(f.root, 'acp-stopped'), 'utf8'), 'yes');
  assertGone(acpPid);
});

test('bridge manifest projection still rejects unknown official runtime fields', async (t) => {
  const f = await fixture(t, serverSource, { extensions: true });
  f.manifest.runtime.unrecognized = true;
  await writeFile(join(f.pluginRoot, 'miniapp/miniapp.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.start(), { code: 'MINIAPP_RUNTIME_INVALID' });
});
