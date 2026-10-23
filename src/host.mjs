// @ts-check
/**
 * Linux host for the official MiniMax Bot Mini App.
 *
 * The desktop app is the only thing that normally calls `start(context)`. This
 * process does that job: it assigns a data directory and a loopback port,
 * injects an Agent backed by `mcode acp`, and puts a token check in front.
 * The token stands in for the desktop app's per-run loopback credential, so
 * the page is not open to whoever can reach the port. The official plugin is
 * loaded as-is and is not modified.
 *
 * The plugin binds the address we pass and never returns the server object, so
 * the guard accepts the connection, checks the token, then replays the same
 * bytes to the plugin on loopback. A request with no token never reaches it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AcpAgent } from './agent.mjs';
import { startMobileBridge } from './mobile-bridge.mjs';
import { newToken, presentedToken, tokenMatches } from './token.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const options = {
  pluginRoot: resolve(process.env.MINIMAX_BOT_PLUGIN ?? join(root, '../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot')),
  dataDir: resolve(process.env.MINIMAX_BOT_DATA ?? join(homedir(), '.minimax-bot')),
  host: process.env.MINIMAX_BOT_HOST ?? '127.0.0.1',
  port: Number(process.env.MINIMAX_BOT_PORT ?? 8787),
  mcode: process.env.MINIMAX_BOT_MCODE ?? 'mcode',
  node: process.env.MINIMAX_BOT_NODE ?? process.execPath,
  cwd: resolve(process.env.MINIMAX_BOT_CWD ?? process.cwd()),
  modelsUrl: process.env.MINIMAX_BOT_MODELS_URL ?? '',
  modelsApiKey: process.env.MINIMAX_BOT_MODELS_API_KEY ?? process.env.magpie ?? '',
};

const tokenPath = join(options.dataDir, 'access-token');
mkdirSync(options.dataDir, { recursive: true });
const token = process.env.MINIMAX_BOT_TOKEN || readToken(tokenPath);
if (!process.env.MINIMAX_BOT_TOKEN) writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

const appPort = await freePort();
const mcodeTarget = resolve(options.mcode);
const acp = new AcpAgent({
  command: mcodeTarget.endsWith('.js') ? options.node : options.mcode,
  args: mcodeTarget.endsWith('.js') ? [mcodeTarget, 'acp'] : ['acp'],
  cwd: options.cwd,
  modelsUrl: options.modelsUrl,
  modelsApiKey: options.modelsApiKey,
  logger: {
    info: (message, fields) => console.error(`[bot] ${message}${fields?.text ? ` ${fields.text}` : ''}`),
    warn: (message) => console.error(`[bot] warn ${message}`),
    error: (message) => console.error(`[bot] error ${message}`),
  },
});
const agent = {
  run: (input, runOptions) => acp.run(input, runOptions),
  answer: (input, runOptions) => acp.answer(input, runOptions),
  reply: (input) => acp.reply(input),
  models: () => acp.loadModels(),
};

const pluginUrl = pathToFileURL(join(options.pluginRoot, 'miniapp/node/server.mjs'));
const plugin = await import(pluginUrl.href);
const mobile = await startMobileBridge({ host: '127.0.0.1', port: appPort, token });
const abort = new AbortController();
const lifecycle = await plugin.start({
  pluginId: 'minimax-bot',
  pluginRoot: options.pluginRoot,
  dataDir: options.dataDir,
  listen: { host: '127.0.0.1', port: appPort },
  signal: abort.signal,
  logger: {
    debug: () => {},
    info: (message) => console.error(`[minimax-bot] ${message}`),
    warn: (message) => console.error(`[minimax-bot] warn ${message}`),
    error: (message) => console.error(`[minimax-bot] error ${message}`),
  },
  agent,
});

const guard = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let decided = false;
  const fail = (status, text) => {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
    );
  };
  const onData = (chunk) => {
    if (decided) return;
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buffer.length > 64 * 1024) fail(431, 'Request header too large.');
      return;
    }
    decided = true;
    socket.off('data', onData);
    const header = Object.create(null);
    for (const line of buffer.subarray(0, headerEnd).toString('latin1').split('\r\n').slice(1)) {
      const split = line.indexOf(':');
      if (split === -1) continue;
      header[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
    }
    const requestLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
    const target = requestLine.split(' ')[1] ?? '/';
    let url;
    try {
      url = new URL(target, 'http://bot.local');
    } catch {
      fail(400, 'Bad request.');
      return;
    }
    const request = { headers: { authorization: header.authorization, cookie: header.cookie } };
    const mobilePublic = url.pathname === '/api/mobile/v1/info' || url.pathname === '/api/mobile/v1/auth/refresh';
    if (!mobilePublic && !tokenMatches(token, presentedToken(request, url))) {
      fail(401, 'Sign in with the access token printed when the host started.');
      return;
    }
    const upstreamPort = url.pathname.startsWith('/api/mobile/') ? mobile.port : appPort;
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort }, () => {
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        const next = `${url.pathname}${url.search}` || '/';
        socket.end(
          'HTTP/1.1 302 Found\r\n'
          + `location: ${next}\r\n`
          + `set-cookie: minimax_bot=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000\r\n`
          + 'cache-control: no-store\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
        );
        upstream.end();
        return;
      }
      const forwarded = Buffer.from(buffer.toString('latin1').replace(/\r\nconnection:[^\r\n]*/i, '').replace('\r\n\r\n', '\r\nconnection: close\r\n\r\n'), 'latin1');
      upstream.write(forwarded);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on('end', () => upstream.end());
    });
    upstream.on('error', () => fail(502, 'MiniMax Bot is not reachable.'));
  };
  socket.on('data', onData);
  socket.on('error', () => socket.destroy());
});

await new Promise((resolve) => guard.listen(options.port, options.host, resolve));
const address = guard.address();
const published = typeof address === 'object' && address ? address.port : options.port;
console.log('MiniMax Bot is ready.');
console.log(`Open: http://${options.host}:${published}/bot?token=${token}`);
console.log(`Token file: ${tokenPath}`);
console.log(`Agent workspace: ${options.cwd}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  abort.abort();
  mobile.close();
  await acp.dispose();
  await lifecycle?.dispose?.();
  guard.close();
};
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));

/** @param {string} path */
function readToken(path) {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  return newToken();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address();
      const port = typeof value === 'object' && value ? value.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
