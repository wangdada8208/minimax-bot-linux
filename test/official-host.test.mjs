import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectMiniAppPort, OfficialHostError, startMiniAppModule } from '../src/official-host.mjs';

/** A package directory with an entry that exports `start` from the given source. */
function makePackage(source) {
  const root = mkdtempSync(join(tmpdir(), 'miniapp-'));
  const dir = join(root, 'miniapp', 'node');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.mjs'), source);
  return { root, entry: 'miniapp/node/server.mjs' };
}

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

test('refuses an entry that resolves outside the package', async () => {
  const { root } = makePackage('export async function start() {}');
  // The file exists, but outside the package root.
  writeFileSync(join(root, '..', `outside-${process.pid}.mjs`), 'export async function start() {}');
  await assert.rejects(
    startMiniAppModule({
      pluginId: 'p',
      processGeneration: 'g',
      packageRoot: root,
      nodeEntry: `../outside-${process.pid}.mjs`,
      dataDir: root,
      listen: { host: '127.0.0.1', port: 1 },
    }),
    (error) => error instanceof OfficialHostError && error.code === 'ENTRY_OUTSIDE_ARTIFACT',
  );
});

test('refuses a module without a start export', async () => {
  const { root, entry } = makePackage('export const nope = 1;');
  await assert.rejects(
    startMiniAppModule({
      pluginId: 'p',
      processGeneration: 'g',
      packageRoot: root,
      nodeEntry: entry,
      dataDir: root,
      listen: { host: '127.0.0.1', port: 1 },
    }),
    (error) => error instanceof OfficialHostError && error.code === 'START_EXPORT_MISSING',
  );
});

test('refuses a start result without dispose', async () => {
  const { root, entry } = makePackage('export async function start() { return {}; }');
  await assert.rejects(
    startMiniAppModule({
      pluginId: 'p',
      processGeneration: 'g',
      packageRoot: root,
      nodeEntry: entry,
      dataDir: root,
      listen: { host: '127.0.0.1', port: 1 },
      awaitReadiness: false,
    }),
    (error) => error instanceof OfficialHostError && error.code === 'RUNNER_LIFECYCLE_INVALID',
  );
});

test('freezes the context, adds the agent, and aborts before dispose', async () => {
  const port = await freePort();
  const { root, entry } = makePackage(`
    export async function start(context) {
      const order = [];
      const server = (await import('node:http')).createServer((req, res) => res.end('ok'));
      await new Promise((resolve) => server.listen(context.listen.port, context.listen.host, resolve));
      context.signal.addEventListener('abort', () => order.push('signal'));
      globalThis.__probe = { context, order };
      return { dispose: async () => { order.push('dispose'); await new Promise((r) => server.close(r)); } };
    }
  `);
  const agent = { run: async () => ({}) };
  const running = await startMiniAppModule({
    pluginId: 'p',
    processGeneration: 'g',
    packageRoot: root,
    nodeEntry: entry,
    dataDir: root,
    listen: { host: '127.0.0.1', port },
    agent,
  });
  const probe = /** @type {any} */ (globalThis).__probe;
  assert.equal(Object.isFrozen(probe.context), true);
  assert.equal(probe.context.agent, agent, 'the Agent is handed to the plugin');
  assert.equal(probe.context.pluginId, 'p');
  await running.stop();
  assert.deepEqual(probe.order, ['signal', 'dispose']);
});

test('waits for the port and reports a timeout when nothing listens', async () => {
  const port = await freePort();
  await assert.rejects(
    connectMiniAppPort({ host: '127.0.0.1', port, timeoutMs: 300, retryMs: 50 }),
    (error) => error instanceof OfficialHostError && error.code === 'READINESS_TIMEOUT',
  );
});

test('resolves once the port accepts connections', async () => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (server.address()).port;
  await connectMiniAppPort({ host: '127.0.0.1', port, timeoutMs: 2000, retryMs: 50 });
  await new Promise((resolve) => server.close(resolve));
});
