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
 * the guard accepts the request, checks the token, then proxies it to the
 * plugin on loopback. A request with no token never reaches it.
 *
 * The guard is a real HTTP proxy with keep-alive: the page loads ~20 ES modules,
 * and one connection per module would add a round trip each — unusable over a
 * relayed link. Streaming responses (the event stream) pass through untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
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

// One pooled agent per upstream so the browser's keep-alive connection is
// reused for every module, stylesheet and API call.
const appAgent = new Agent({ keepAlive: true, maxSockets: 64 });
const mobileAgent = new Agent({ keepAlive: true, maxSockets: 16 });

const guard = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://bot.local');
  const mobilePublic = url.pathname === '/api/mobile/v1/info' || url.pathname === '/api/mobile/v1/auth/refresh';
  if (!mobilePublic && !tokenMatches(token, presentedToken(request, url))) {
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Sign in with the access token printed when the host started.');
    return;
  }
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    const next = `${url.pathname}${url.search}` || '/';
    response.writeHead(302, {
      location: next,
      'set-cookie': `minimax_bot=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      'cache-control': 'no-store',
      'content-length': '0',
    });
    response.end();
    return;
  }
  const mobilePath = url.pathname.startsWith('/api/mobile/');
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: mobilePath ? mobile.port : appPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${mobilePath ? mobile.port : appPort}` },
      agent: mobilePath ? mobileAgent : appAgent,
    },
    (reply) => {
      // A page load is a few hundred KB of JSON and ES modules. Compressing here
      // matters most on a relayed link, where the plugin's uncompressed replies
      // are what make a chat feel slow to open.
      const type = String(reply.headers['content-type'] ?? '');
      const streaming = type.startsWith('text/event-stream');
      const compressible = /^(?:text\/|application\/(?:json|javascript)|image\/svg)/.test(type);
      const wantsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
      const headers = { ...reply.headers };
      // The plugin marks every static file no-store, so a refresh re-downloads
      // all of the page's modules. Let the browser keep them for a few minutes;
      // a plugin update still shows up on the next reload after that.
      if (request.method === 'GET' && reply.statusCode === 200 && /^\/bot\/[^?]*\.(?:js|css|svg|png)$/.test(url.pathname)) {
        headers['cache-control'] = 'public, max-age=300';
      }
      if (wantsGzip && compressible && !streaming && reply.statusCode === 200 && !headers['content-encoding']) {
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers.vary = 'Accept-Encoding';
        response.writeHead(reply.statusCode, headers);
        const gzip = createGzip({ level: 6 });
        gzip.on('error', () => response.destroy());
        reply.on('error', () => gzip.destroy());
        reply.pipe(gzip).pipe(response);
        return;
      }
      response.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('MiniMax Bot is not reachable.');
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
});
// The event stream stays open, so the guard must not time it out.
guard.requestTimeout = 0;
// Browsers reuse an idle socket for a long time. Node closes one after
// keepAliveTimeout (5 s by default), and a request sent into a socket the
// server is closing costs an extra round trip — noticeable on a relayed link.
guard.keepAliveTimeout = 65_000;
guard.headersTimeout = 66_000;

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
  appAgent.destroy();
  mobileAgent.destroy();
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
