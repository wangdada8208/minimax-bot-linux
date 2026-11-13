import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, chmod, readFile, open, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ownFile = fileURLToPath(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const safeQr = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
};
function packageRoot(explicit) {
  if (explicit) return resolve(explicit);
  const runtime = process.env.MINIMAX_BOT_WECHAT_RUNTIME;
  if (!runtime) throw new Error('MINIMAX_BOT_WECHAT_RUNTIME is required');
  const require = createRequire(join(resolve(runtime), 'package.json'));
  return dirname(require.resolve('@tencent-weixin/openclaw-weixin/package.json'));
}
async function official(root, stateDir) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_LOG_LEVEL = 'FATAL';
  const logger = await import(pathToFileURL(join(root, 'dist/src/util/logger.js')));
  logger.setLogLevel('FATAL');
  return import(pathToFileURL(join(root, 'dist/src/api/api.js')));
}

// deps: { sdk:{getUpdates,sendMessage}, login({onQr,onVerify,signal})->credentials,
//         qrToDataURL, fetch, pollIntervalMs }. Production login owns a separate stdin.
export async function startWechatBridge({ host = '127.0.0.1', botPort, token, dataDir, officialPackageRoot, botWebUrl, deps = {} }) {
  if (host !== '127.0.0.1' || !Number.isInteger(botPort) || botPort < 1 || !token || !dataDir)
    throw new Error('Loopback host, botPort, token and private dataDir are required');
  const webLink = botWebUrl ? safeQr(botWebUrl) : null;
  if (botWebUrl && !webLink) throw new Error('botWebUrl must be an HTTPS URL without credentials');
  const webNotice = text => `${text}${webLink ? `\n${webLink}` : ''}`;
  const privateDir = join(resolve(dataDir), 'wechat');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(privateDir, 0o700);
  const stateFile = join(privateDir, 'state.json');
  let state = { version: 1, binding: null, inbox: {}, outbox: {}, seen: {}, cursor: '', context: null };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('WeChat state cannot be read'); }
  if (state.version !== 1 || !state.inbox || !state.outbox || !state.seen) throw new Error('Invalid WeChat state');
  if (state.binding && (!['owner', 'botId', 'botToken', 'chiefId'].every(key => typeof state.binding[key] === 'string' && state.binding[key]) ||
      !safeQr(state.binding.baseUrl) || !/^[a-zA-Z0-9_]+$/.test(state.binding.chiefId))) throw new Error('Invalid confirmed WeChat binding');
  for (const entry of Object.values(state.outbox)) if (entry.status === 'sending') entry.status = 'unknown';
  let writeChain = Promise.resolve();
  const save = () => {
    const text = JSON.stringify(state);
    writeChain = writeChain.then(async () => {
      const temporary = `${stateFile}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try { await file.chmod(0o600); await file.writeFile(text); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, stateFile);
    });
    return writeChain;
  };
  await save();
  const root = deps.sdk ? null : packageRoot(officialPackageRoot);
  const sdk = deps.sdk ?? await official(root, privateDir);
  const abort = new AbortController();
  const fetcher = deps.fetch ?? fetch;
  const origin = `http://127.0.0.1:${botPort}`;
  const api = async (path, body) => {
    const response = await fetcher(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error('Bot HTTP request failed');
    return response.json();
  };
  let phase = state.binding ? 'connected' : 'unbound', error = null, qr = null;
  let worker = null, bindingTask = null, stopped = false;
  let queuedBinding = null;
  const status = () => ({ phase, qr, error, owner: state.binding?.owner ?? null,
    connected: Boolean(state.binding) && phase !== 'stale',
    unknownDeliveries: Object.values(state.outbox).filter(e => e.status === 'unknown').length });
  const chatPath = binding => `/api/chats/bot:${binding.chiefId}/messages`;
  async function history(binding) {
    let before, rows = [];
    do {
      const page = await api(`${chatPath(binding)}?limit=500${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (!Array.isArray(page.messages)) throw new Error('Invalid Bot history');
      rows = [...page.messages, ...rows];
      if (!page.hasMore) return rows;
      if (!page.nextBefore || page.nextBefore === before) throw new Error('Invalid Bot history cursor');
      before = page.nextBefore;
    } while (!stopped);
    throw new Error('Closing');
  }
  const login = deps.login ?? (({ onQr, onVerify, signal }) => new Promise((accept, reject) => {
    worker = fork(ownFile, ['--login-worker', root, privateDir], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, OPENCLAW_STATE_DIR: privateDir, OPENCLAW_LOG_LEVEL: 'FATAL' },
    });
    const child = worker;
    const deadline = setTimeout(() => child.kill(), 250000);
    const kill = () => child.kill();
    signal.addEventListener('abort', kill, { once: true });
    let output = '';
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-8192);
      if (/输入手机微信显示的数字|你输入的数字不匹配/.test(output)) { output = ''; onVerify(); }
      const urls = output.match(/https:\/\/[^\s\x1b]+/g);
      if (urls?.length) { onQr(urls.at(-1)); output = ''; }
    });
    child.stderr.resume();
    child.on('message', message => {
      if (message.type === 'qr') onQr(message.url);
      if (message.type === 'result') accept(message.result);
      if (message.type === 'failed') reject(new Error('Official login failed'));
    });
    child.on('error', () => reject(new Error('Official login worker failed')));
    child.on('exit', () => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', kill);
      if (worker === child) worker = null;
      reject(new Error('Official login ended'));
    });
  }));
  let renderChain = Promise.resolve();
  function onQr(url) {
    const valid = safeQr(url);
    if (!valid) return;
    renderChain = renderChain.then(async () => {
      const render = deps.qrToDataURL ?? createRequire(join(root, 'package.json'))('qrcode').toDataURL;
      const image = await render(valid);
      if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) throw new Error('Invalid QR image');
      qr = { url: valid, image }; phase = 'awaiting_scan';
    }).catch(() => { error = '二维码生成失败，请重新连接'; });
  }
  function beginBind() {
    if (bindingTask || queuedBinding) return;
    phase = 'starting'; error = null; qr = null;
    bindingTask = (async () => {
      const result = await login({ onQr, onVerify: () => { phase = 'needs_code'; }, signal: abort.signal });
      await renderChain;
      const owner = result.userId;
      const botId = result.botId ?? result.accountId;
      if (!result.connected || ![owner, botId, result.botToken].every(value => typeof value === 'string' && value) || !safeQr(result.baseUrl))
        throw new Error('Login lacks confirmed owner');
      const current = await api('/api/state');
      const chief = current.bots?.find(b => b.isMain);
      if (!chief || !/^[a-zA-Z0-9_]+$/.test(chief.id)) throw new Error('Chief unavailable');
      const binding = { owner, botId, botToken: result.botToken, baseUrl: result.baseUrl, chiefId: chief.id };
      const rows = await history(binding);
      queuedBinding = { binding, seen: Object.fromEntries(rows.filter(row => row.role === 'bot' && ['done', 'error'].includes(row.status)).map(row => [row.id, true])) };
      phase = 'confirming';
    })().catch(() => { if (!stopped) { phase = state.binding ? 'connected' : 'error'; error = '连接失败：必须由确认的微信所有者绑定，请重试'; qr = null; } })
      .finally(() => { bindingTask = null; if (worker) worker.kill(); });
  }
  async function send(entry) {
    entry.status = 'sending'; await save();
    try {
      const response = await sdk.sendMessage({ baseUrl: state.binding.baseUrl, token: state.binding.botToken,
        body: { msg: { from_user_id: '', to_user_id: state.binding.owner, client_id: entry.clientId,
          message_type: 2, message_state: 2, context_token: state.context ?? undefined,
          item_list: [{ type: 1, text_item: { text: entry.text } }] } } });
      if ((response?.ret && response.ret !== 0) || (response?.errcode && response.errcode !== 0)) throw new Error('Send rejected');
      entry.status = 'done'; delete entry.text;
    } catch { entry.status = 'unknown'; error = '有一条微信发送结果未知，未自动重发，请在 Bot 网页核对'; }
    await save();
  }
  function enqueue(id, text) {
    if (!state.outbox[id]) state.outbox[id] = { status: 'pending', clientId: `wx_${digest(id)}`, text };
  }
  async function ingest(update) {
    for (const message of update.msgs ?? []) {
      if (message.from_user_id !== state.binding.owner || message.message_type !== 1 ||
          message.group_id || message.room_id || message.chatroom_id ||
          (message.to_user_id && message.to_user_id !== state.binding.botId)) continue;
      if (message.message_id == null || (typeof message.message_id === 'number' && !Number.isSafeInteger(message.message_id)))
        throw new Error('Inbound message has no safe identity');
      const id = `wx:${digest(`${state.binding.botId}:${message.message_id}`)}`;
      if (state.inbox[id]) continue;
      if (Object.keys(state.inbox).length >= 10000) throw new Error('Inbox capacity reached');
      const items = message.item_list ?? [];
      const text = items.filter(i => i.type === 1).map(i => i.text_item?.text ?? '').join('\n').trim();
      const unsupported = !text || items.some(i => i.type !== 1);
      state.inbox[id] = { status: unsupported ? 'done' : 'pending', ...(unsupported ? {} : { text }) };
      if (message.context_token) state.context = message.context_token;
      if (unsupported) enqueue(`unsupported:${id}`, webNotice('当前微信桥接仅支持文字；图片、语音和文件请在 Bot 网页处理。'));
    }
    // The complete batch is durable before its server cursor can become durable.
    await save();
    if (typeof update.get_updates_buf === 'string') state.cursor = update.get_updates_buf;
    await save();
  }
  async function tick() {
    if (queuedBinding) {
      if (Object.values(state.inbox).some(e => e.status === 'pending') || Object.values(state.outbox).some(e => e.status === 'pending')) {
        queuedBinding = null; phase = 'connected'; qr = null;
        error = '旧连接仍有待处理消息，请处理完成后重新连接';
      } else {
        pollController?.abort();
        state = { version: 1, ...queuedBinding, inbox: {}, outbox: {}, cursor: '', context: null };
        queuedBinding = null; await save(); phase = 'connected'; qr = null; error = null;
      }
    }
    if (!state.binding || phase === 'stale') return;
    let rows = await history(state.binding);
    for (const [id, entry] of Object.entries(state.inbox)) {
      if (entry.status !== 'pending') continue;
      const admitted = rows.find(row => row.role === 'user' && row.clientMessageId === id);
      if (admitted && admitted.text !== entry.text) throw new Error('Inbound identity conflicts with Bot history');
      if (!admitted) await api(chatPath(state.binding), { text: entry.text, clientMessageId: id });
      entry.status = 'done'; delete entry.text; await save();
    }
    for (const row of rows) {
      if (!row.id || state.seen[row.id] || row.role !== 'bot' ||
          (row.botId && row.botId !== state.binding.chiefId) || !['done', 'error'].includes(row.status)) continue;
      const text = row.question ? webNotice('Chief 有问题需要你确认，请打开 Bot 网页处理。') :
        row.text || (row.parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n') || (row.status === 'error' ? 'Chief 处理失败，请在 Bot 网页查看。' : '');
      if (Object.keys(state.outbox).length >= 10000) throw new Error('Outbox capacity reached');
      state.seen[row.id] = true;
      if (text) enqueue(`bot:${row.id}`, text);
    }
    await save();
    for (const entry of Object.values(state.outbox)) if (entry.status === 'pending') await send(entry);
  }
  const interval = deps.pollIntervalMs ?? 1000;
  let pollController, pendingPoll = null;
  const monitor = (async () => {
    let backoff = interval;
    while (!stopped) {
      try {
        await tick();
        if (state.binding && phase !== 'stale') {
          if (!pendingPoll) {
            const binding = state.binding;
            pollController = new AbortController();
            pendingPoll = Promise.resolve().then(() => sdk.getUpdates({ baseUrl: binding.baseUrl, token: binding.botToken,
              get_updates_buf: state.cursor, timeoutMs: 35000,
              abortSignal: AbortSignal.any([abort.signal, pollController.signal]) }))
              .then(update => ({ update, binding }), () => ({ failed: true, binding }));
          }
          const result = await Promise.race([pendingPoll, delay(interval, null, { signal: abort.signal }).catch(() => null)]);
          if (stopped) break;
          if (result) {
            pendingPoll = null;
            if (result.binding !== state.binding) continue;
            if (result.failed) throw new Error('WeChat polling failed');
            const { update } = result;
            if (update.ret === -14 || update.errcode === -14) { phase = 'stale'; error = '微信登录已失效，请重新连接'; }
            else if ((update.ret && update.ret !== 0) || (update.errcode && update.errcode !== 0)) throw new Error('WeChat polling failed');
            else await ingest(update);
          }
        }
        backoff = interval;
      } catch { if (!stopped) { error = '桥接暂时不可用，正在重试；未确认的微信发送不会重发'; backoff = Math.min(Math.max(backoff * 2, interval), 30000); } }
      await delay(backoff, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief 微信连接</title><style>body{font:18px system-ui;max-width:520px;margin:32px auto;padding:20px}button,input{font:inherit;padding:12px;margin:8px 0}img{max-width:100%}</style><h1>Chief 微信连接</h1><p>将当前 Chief 连接到你的微信。微信交办的任务和后续结果继续使用现有团队；网页中 Chief 的新回复也会同步到已绑定的微信。仅支持文字，图片、语音、文件和需要确认的问题请在 Bot 网页处理。</p><button id="bind">连接微信</button><p id="status"></p><img id="qr" alt="微信连接二维码" hidden><form id="verify" hidden><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="微信显示的数字"><button>提交配对码</button></form><script>async function call(path,body){const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('请求失败');return r.json()}async function refresh(){try{const s=await call('status');document.querySelector('#status').textContent=({unbound:'尚未连接',starting:'正在获取二维码',awaiting_scan:'请用微信扫码并确认',needs_code:'请输入微信显示的配对码',confirming:'正在绑定 Chief',connected:'已连接 Chief',stale:'登录已失效，请重新连接',error:'连接失败'}[s.phase]||s.phase)+(s.error?'：'+s.error:'');document.querySelector('#qr').hidden=!s.qr;if(s.qr)document.querySelector('#qr').src=s.qr.image;document.querySelector('#verify').hidden=s.phase!=='needs_code'}catch{document.querySelector('#status').textContent='无法访问，请检查管理令牌'}}document.querySelector('#bind').onclick=()=>call('bind/start',{}).then(refresh);document.querySelector('#verify').onsubmit=e=>{e.preventDefault();call('verify',{code:document.querySelector('#code').value}).then(refresh)};refresh();setInterval(refresh,2000)</script></html>`;
  const server = createServer(async (request, response) => {
    const reply = (code, body, type = 'application/json') => { response.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); response.end(type === 'text/html' ? body : JSON.stringify(body)); };
    const provided = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply(401, { error: 'Unauthorized' });
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/') return reply(200, html, 'text/html');
      if (request.method === 'GET' && path === '/status') return reply(200, status());
      if (request.method === 'POST' && path === '/bind/start') { beginBind(); pollController?.abort(); return reply(202, status()); }
      if (request.method === 'POST' && path === '/verify') {
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024) return reply(413, { error: 'Too large' }); }
        const { code } = JSON.parse(body);
        if (phase !== 'needs_code' || !worker || !/^[0-9]{1,12}$/.test(code)) return reply(409, { error: 'Pairing code unavailable or invalid' });
        worker.stdin.write(`${code}\n`); phase = 'awaiting_scan'; return reply(200, status());
      }
      reply(404, { error: 'Not found' });
    } catch { reply(400, { error: 'Request failed' }); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, host, accept); });
  return { port: server.address().port, async close() {
    stopped = true; abort.abort(); worker?.kill();
    await Promise.allSettled([monitor, pendingPoll, bindingTask, renderChain]);
    await writeChain;
    await new Promise(accept => { server.close(accept); server.closeAllConnections(); });
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile && process.argv[2] === '--login-worker') {
  try {
    const [, , , root, stateDir] = process.argv;
    await official(root, stateDir);
    const sdk = await import(pathToFileURL(join(root, 'dist/src/auth/login-qr.js')));
    const started = await sdk.startWeixinLoginWithQr({ force: true });
    if (!started.qrcodeUrl) throw new Error('No QR code');
    process.send({ type: 'qr', url: started.qrcodeUrl });
    const result = await sdk.waitForWeixinLogin({ sessionKey: started.sessionKey, timeoutMs: 240000 });
    process.send({ type: 'result', result }, () => process.exit(0));
  } catch { process.send?.({ type: 'failed' }, () => process.exit(1)); }
}
