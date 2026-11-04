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
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { HostMiniAppPortRegistry, startOfficialBotRuntime } from './official-host.mjs';
import { SelfUpdate } from './self-update.mjs';
import { startMobileBridge } from './mobile-bridge.mjs';
import { newToken, presentedToken, tokenMatches } from './token.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const options = {
  pluginRoot: resolve(process.env.MINIMAX_BOT_PLUGIN ?? join(root, '../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot')),
  dataDir: resolve(process.env.MINIMAX_BOT_DATA ?? join(homedir(), '.minimax-bot')),
  host: process.env.MINIMAX_BOT_HOST ?? '127.0.0.1',
  port: Number(process.env.MINIMAX_BOT_PORT ?? 8787),
  mcode: process.env.MINIMAX_BOT_MCODE ?? join(process.env.MINIMAX_RUNTIME_DIR ?? join(root, '../minimax-code-official'), 'dist/cli.js'),
  node: process.env.MINIMAX_BOT_NODE ?? process.execPath,
  cwd: resolve(process.env.MINIMAX_BOT_CWD ?? process.cwd()),
  modelsUrl: process.env.MINIMAX_BOT_MODELS_URL ?? '',
  modelsApiKey: process.env.MINIMAX_BOT_MODELS_API_KEY ?? process.env.magpie ?? '',
};

const tokenPath = join(options.dataDir, 'access-token');
mkdirSync(options.dataDir, { recursive: true });
const token = process.env.MINIMAX_BOT_TOKEN || readToken(tokenPath);
if (!process.env.MINIMAX_BOT_TOKEN) writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

// The unmodified official process adapter owns port selection/reservations,
// child startup, readiness, retries, materialization and termination. The child
// runs the official host runner with a small context.agent compatibility bridge.
const portRegistry = new HostMiniAppPortRegistry(new Set([options.port]));
// The embedded official adapter unrefs cleanup/retry timers because its normal
// owner is an already-running application. Keep this standalone host alive until
// its HTTP listener takes over that ownership.
const startupOwner = setInterval(() => {}, 1000);
const lifecycle = await startOfficialBotRuntime({
  ...options,
  agentBackend: process.env.MINIMAX_BOT_AGENT_BACKEND ?? 'native',
  portRegistry,
  logger: {
    debug: () => {},
    info: (message) => console.error(`[minimax-bot] ${message}`),
    warn: (message) => console.error(`[minimax-bot] warn ${message}`),
    error: (message) => console.error(`[minimax-bot] error ${message}`),
  },
}).catch((error) => { clearInterval(startupOwner); throw error; });
const pluginPort = lifecycle.port;
// options.port is the bridge's upstream, not its own listener. The bridge
// allocates its listener separately; it must forward to the actual plugin.
const mobile = await startMobileBridge({ host: '127.0.0.1', port: pluginPort, token });
const selfUpdate = new SelfUpdate({
  root,
  logger: { warn: (message) => console.error(`[bot] warn ${message}`) },
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
  // The update control is served by this host and injected into the Bot page,
  // so the plugin stays a byte-for-byte upstream copy.
  if (url.pathname === '/host-update.js') {
    const script = readFileSync(join(here, 'host-update.js'));
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': script.length });
    response.end(script);
    return;
  }
  // The update button talks to the checkout this process runs from.
  if (url.pathname === '/api/update' || url.pathname === '/api/update/apply') {
    const isApply = url.pathname === '/api/update/apply';
    if (isApply && request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
      response.end(JSON.stringify({ ok: false, reason: 'Use POST.' }));
      return;
    }
    void (isApply ? selfUpdate.apply() : selfUpdate.check())
      .then((result) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(result));
        // The new code is on disk; the running process still has the old one.
        // Exit so the watchdog brings it back with the update, after the reply
        // has had time to reach the page.
        if (isApply && result.ok && result.restartRequired) {
          console.error('[bot] self_update.restarting');
          setTimeout(() => void stop().then(() => process.exit(0)), 1500).unref();
        }
      })
      .catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, reason: String(error?.message ?? 'update failed') }));
      });
    return;
  }
  const mobilePath = url.pathname.startsWith('/api/mobile/');
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: mobilePath ? mobile.port : pluginPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${mobilePath ? mobile.port : pluginPort}` },
      agent: mobilePath ? mobileAgent : appAgent,
    },
    (reply) => {
      // A page load is a few hundred KB of JSON and ES modules. Compressing here
      // matters most on a relayed link, where the plugin's uncompressed replies
      // are what make a chat feel slow to open.
      const type = String(reply.headers['content-type'] ?? '');
      const streaming = type.startsWith('text/event-stream');
      // Put the update control into the Bot page itself. Buffering this one
      // small HTML reply lets the host add a script tag without touching the
      // plugin's files; everything else still streams through untouched.
      const botPage = request.method === 'GET' && reply.statusCode === 200 &&
        /^text\/html/.test(type) && /^\/bot(?:\/|$)/.test(url.pathname);
      if (botPage) {
        const chunks = [];
        reply.on('data', (chunk) => chunks.push(chunk));
        reply.on('end', () => {
          const original = Buffer.concat(chunks).toString('utf8');
          const tag = '<script defer src="/host-update.js"></script>';
          const injected = original.includes('</body>')
            ? original.replace('</body>', `${tag}\n</body>`)
            : original + tag;
          const body = Buffer.from(injected, 'utf8');
          const headers = { ...reply.headers };
          // We send a fixed-length body, so drop both the plugin's framing hints:
          // Content-Length together with Transfer-Encoding is a protocol error.
          delete headers['content-length'];
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = body.length;
          headers['cache-control'] = 'no-store';
          response.writeHead(reply.statusCode, headers);
          response.end(body);
        });
        reply.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        return;
      }
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

await new Promise((resolve, reject) => {
  guard.once('error', reject);
  guard.listen(options.port, options.host, resolve);
}).catch(async (error) => {
  clearInterval(startupOwner);
  mobile.close();
  await lifecycle.stop();
  throw error;
});
clearInterval(startupOwner);
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
  mobile.close();
  appAgent.destroy();
  mobileAgent.destroy();
  try {
    const result = await lifecycle.stop();
    if (!result.proven) throw new Error('Official runtime could not prove its process stopped');
  } finally {
    guard.close();
    guard.closeAllConnections();
  }
};
// The watchdog watches the guard port. Exit when the official plugin child dies
// so it can restart the whole host instead of leaving a healthy-looking 502 proxy.
lifecycle.closed.then((exit) => {
  if (stopping) return;
  console.error(`[bot] runtime.exited code=${exit.code} signal=${exit.signal}`);
  void stop().finally(() => process.exit(1));
});
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
