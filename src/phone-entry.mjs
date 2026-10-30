// @ts-check
/**
 * Optional second listener that speaks the phone bridge protocol and forwards
 * everything else to the page host. All addresses come from the environment so
 * this file carries no machine-specific values.
 */
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startMobileBridge } from './mobile-bridge.mjs';

const host = process.env.MINIMAX_BOT_HOST ?? '127.0.0.1';
const pagePort = Number(process.env.MINIMAX_BOT_PORT ?? 8787);
const phonePort = Number(process.env.MINIMAX_BOT_PHONE_PORT ?? pagePort + 1);
const dataDir = process.env.MINIMAX_BOT_DATA ?? join(homedir(), '.minimax-bot');
const token = process.env.MINIMAX_BOT_TOKEN || readFileSync(join(dataDir, 'access-token'), 'utf8').trim();

const bridge = await startMobileBridge({
  host,
  port: pagePort,
  token,
  notifyStorePath: process.env.MINIMAX_BOT_NOTIFY_STORE ?? join(dataDir, 'phone-notifications.json'),
});
const server = createServer((req, res) => {
  const upstream = request({ hostname: '127.0.0.1', port: bridge.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(bridge.port, '127.0.0.1', () => {
    let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(req.headers)) for (const item of Array.isArray(value) ? value : [value]) text += `${key}: ${item}\r\n`;
    upstream.write(`${text}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
});
server.listen(phonePort, host, () => console.log(`Phone entry listening on ${host}:${phonePort}`));
