// @ts-check
/**
 * Speaks the DS-Bot App v0.1.0 mobile protocol (/api/mobile/v1) and translates
 * it onto the MiniMax Bot HTTP API. The phone UI is unchanged; only the calls
 * MiniMax actually has are wired through.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const unsupported = '这台电脑上的 MiniMax Bot 没有这项。界面留着，功能对不上。';

/**
 * @param {{ port: number, host: string, token: string }} options
 */
export function startMobileBridge(options) {
  const origin = `http://${options.host}:${options.port}`;
  const messageDir = options.messageDir || '';
  /** @type {Set<import('ws').WebSocket & { conversationId?: string }>} */
  const sockets = new Set();
  let lastStamp = '';

  async function api(method, path, body) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value.message || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return value;
  }

  function modelRef(model) {
    if (!model) return undefined;
    if (typeof model === 'string') return model;
    return model.modelId ? `${model.providerId || ''}:${model.modelId}` : undefined;
  }

  function modelPatch(ref) {
    if (typeof ref !== 'string' || !ref) return undefined;
    const split = ref.indexOf(':');
    if (split === -1) return { modelId: ref };
    return { providerId: ref.slice(0, split), modelId: ref.slice(split + 1), variant: 'thinking' };
  }

  function botView(bot, state) {
    const chatId = `bot:${bot.id}`;
    const sessionId = state.sessions?.[chatId]?.[bot.id] || chatId;
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role || '',
      instructions: bot.instructions || '',
      color: bot.color,
      model: modelRef(bot.model),
      sessionId,
      pinned: !!bot.pinned,
      hidden: false,
      skin: bot.skin || 'fuzzy',
      avatar: { shape: bot.skin || bot.face || 'fuzzy', color: bot.color },
    };
  }

  function roomView(group) {
    return {
      id: group.id,
      name: group.name,
      members: group.memberIds || group.members || [],
      admin: group.admin || (group.memberIds || [])[0] || null,
      notice: group.notice || '',
      mode: group.mode || 'everyone',
      named: true,
      pinned: !!group.pinned,
    };
  }

  function conversationOfBot(bot, state) {
    const chatId = `bot:${bot.id}`;
    const chat = state.chats?.[chatId] || {};
    const sessionId = state.sessions?.[chatId]?.[bot.id] || chatId;
    return {
      id: bot.id,
      kind: 'bot',
      name: bot.name,
      role: bot.role || '',
      sessionId,
      pinned: !!bot.pinned,
      hidden: false,
      updatedAt: chat.lastTs || bot.updatedAt || 0,
    };
  }

  function conversationOfGroup(group, state) {
    const chatId = `group:${group.id}`;
    const chat = state.chats?.[chatId] || {};
    return {
      id: group.id,
      kind: 'room',
      name: group.name,
      sessionId: chatId,
      pinned: !!group.pinned,
      hidden: false,
      updatedAt: chat.lastTs || group.updatedAt || 0,
    };
  }

  function chatIdOf(conversationId, state) {
    if (state.bots?.some((bot) => bot.id === conversationId)) return `bot:${conversationId}`;
    if (state.groups?.some((group) => group.id === conversationId)) return `group:${conversationId}`;
    if (String(conversationId).startsWith('bot:') || String(conversationId).startsWith('group:')) return conversationId;
    return `bot:${conversationId}`;
  }

  function messageView(message) {
    const base = {
      sessionId: message.sessionId || message.chatId,
      createdAt: message.ts || message.startedAt || Date.now(),
      author: message.botId,
    };
    const role = message.role === 'user' ? 'user' : 'assistant';
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const steps = [];
    let seq = message.seq ?? message.ts ?? 0;
    for (const part of parts) {
      if (part?.type === 'text' && part.text) {
        steps.push({
          ...base,
          id: `${message.id}:t${steps.length}`,
          seq,
          role,
          text: part.text,
          pending: false,
        });
        seq += 1;
      }
    }
    if (!steps.length) {
      return [{
        ...base,
        id: message.id,
        seq: message.seq ?? message.ts ?? 0,
        role,
        text: message.text || '',
        pending: message.status === 'streaming' && !message.text,
      }];
    }
    return steps;
  }

  async function teamState() {
    const [state, catalog] = await Promise.all([
      api('GET', '/api/state'),
      api('GET', '/api/models').catch(() => ({ models: [] })),
    ]);
    const bots = (state.bots || []).map((bot) => botView(bot, state));
    const rooms = (state.groups || []).map(roomView);
    const models = (catalog.models || []).slice(0, 80).map((model) => ({
      ref: `${model.providerId}:${model.modelId}`,
      name: model.displayName || model.modelId,
      providerName: model.providerId,
    }));
    const main = (state.bots || []).find((bot) => bot.isMain);
    return {
      state,
      team: {
        bots,
        rooms,
        models,
        mainBotId: main?.id,
        mainBotIds: (state.bots || []).filter((bot) => bot.isMain).map((bot) => bot.id),
        prefs: { theme: 'deepseek', language: state.settings?.language || state.locale || 'zh' },
        readOnly: null,
        memory: true,
        colors: ['ocean', 'jade', 'gold', 'plum', 'coral'],
      },
    };
  }

  async function handleAction(endpoint, payload = {}) {
    if (endpoint === 'create-bot') {
      const created = await api('POST', '/api/bots', {
        name: payload.name,
        role: payload.role || '',
        instructions: payload.instructions || '',
        ...(payload.model ? { model: modelPatch(payload.model) } : {}),
      });
      const { state } = await teamState();
      return botView(created.bot, state);
    }
    if (endpoint === 'update-bot') {
      const patch = {};
      for (const key of ['name', 'role', 'instructions', 'pinned', 'color']) {
        if (payload[key] !== undefined) patch[key] = payload[key];
      }
      if (payload.model) patch.model = modelPatch(payload.model);
      if (payload.avatar?.shape) patch.skin = payload.avatar.shape;
      const updated = await api('PATCH', `/api/bots/${payload.id}`, patch);
      const { state } = await teamState();
      return botView(updated.bot, state);
    }
    if (endpoint === 'delete-bot') return api('DELETE', `/api/bots/${payload.id}`);
    if (endpoint === 'set-main') {
      return api('PATCH', `/api/bots/${payload.id}`, { isMain: payload.main !== false });
    }
    if (endpoint === 'create-room') {
      const created = await api('POST', '/api/groups', {
        name: payload.name,
        members: payload.members,
      });
      return roomView(created.group);
    }
    if (endpoint === 'update-room') {
      const patch = {};
      if (payload.name !== undefined) patch.name = payload.name;
      if (payload.members !== undefined) patch.memberIds = payload.members;
      if (payload.notice !== undefined) patch.notice = payload.notice;
      const updated = await api('PATCH', `/api/groups/${payload.id}`, patch);
      return roomView(updated.group);
    }
    if (endpoint === 'delete-room') return api('DELETE', `/api/groups/${payload.id}`);
    if (endpoint === 'approval-resolve' || endpoint === 'approvals') {
      if (endpoint === 'approvals') {
        const state = await api('GET', '/api/state');
        return { requests: (state.approvals || []).map((item) => ({
          id: item.requestId,
          conversationId: item.chatId?.replace(/^bot:|^group:/, '') || item.chatId,
          sessionId: item.chatId,
          toolName: item.toolName,
          reason: item.reason,
          createdAt: item.createdAt || Date.now(),
        })) };
      }
      const decision = payload.decision === 'allowed-once' ? 'allowOnce' : 'deny';
      await api('POST', `/api/approvals/${encodeURIComponent(payload.id)}`, { decision });
      return { accepted: true };
    }
    if (endpoint === 'parts') {
      const state = await api('GET', '/api/state');
      const chatId = chatIdOf(payload.conversationId, state);
      const sessionId = Object.values(state.sessions?.[chatId] || {})[0] || chatId;
      return { conversationId: payload.conversationId, currentSessionId: sessionId, parts: [{ sessionId, number: 1, current: true, cursor: '' }] };
    }
    if (endpoint === 'queue') {
      return { sessionId: payload.conversationId, items: [] };
    }
    if (endpoint === 'memory-view' || endpoint === 'memory-ask' || endpoint === 'memory-forget') {
      const scope = payload.botId || 'team';
      const list = async () => {
        const [own, team] = await Promise.all([
          api('GET', `/api/memory/${scope}`).catch(() => ({ entries: [] })),
          api('GET', '/api/memory/team').catch(() => ({ entries: [] })),
        ]);
        const entries = [
          ...(own.entries || []).map((entry) => ({ scope: 'own', text: entry.text, topic: entry.key || null, added: entry.updatedAt })),
          ...(scope === 'team' ? [] : (team.entries || []).map((entry) => ({ scope: 'team', text: entry.text, topic: entry.key || null, added: entry.updatedAt }))),
        ];
        return {
          botId: payload.botId,
          entries,
          sizes: { own: (own.entries || []).length, team: (team.entries || []).length },
          limits: { main: 100, entry: 1200, topic: 40, topics: 20 },
          summary: null,
          fresh: true,
          summarizing: false,
        };
      };
      if (endpoint === 'memory-forget') {
        const target = payload.scope === 'team' ? 'team' : scope;
        const current = await api('GET', `/api/memory/${target}`);
        const found = (current.entries || []).find((entry) => entry.text === payload.text && (entry.key || null) === (payload.topic || null));
        if (found?.id) await api('DELETE', `/api/memory/${target}/${found.id}`);
        return list();
      }
      if (endpoint === 'memory-ask') {
        const saved = await api('POST', `/api/memory/${scope}`, { text: payload.text });
        return { reply: '已记住。', changes: [{ op: 'add', scope: 'own', text: payload.text, ok: true }], view: { ...(await list()), ...saved } };
      }
      return list();
    }
    if (endpoint === 'schedules' || endpoint === 'schedule-create' || endpoint === 'schedule-delete') {
      if (endpoint === 'schedule-delete') {
        await api('DELETE', `/api/schedules/${payload.id}`);
      }
      if (endpoint === 'schedule-create') {
        const when = payload.when || {};
        const body = { botId: payload.target, name: payload.title, prompt: payload.prompt };
        if (when.kind === 'every') {
          body.kind = 'interval';
          body.everyMinutes = when.minutes;
        } else if (when.kind === 'at') {
          const minutes = Math.max(1, Math.round((Date.parse(when.at) - Date.now()) / 60000));
          body.kind = 'once';
          body.inMinutes = minutes;
        } else if (when.kind === 'daily') {
          body.kind = 'daily';
          body.time = when.time;
        } else {
          const error = new Error('网页端的定时只有每天、一次和固定间隔，没有每周。');
          error.status = 422;
          throw error;
        }
        await api('POST', '/api/schedules', body);
      }
      const state = await api('GET', '/api/state');
      const tasks = (state.schedules || []).map((item) => ({
        id: item.id,
        sessionId: item.id,
        botId: item.botId,
        title: item.name || item.prompt,
        prompt: item.prompt,
        status: item.enabled === false ? 'paused' : 'active',
        kind: item.kind === 'interval' ? 'every' : item.kind === 'once' ? 'at' : 'daily',
        scheduledAt: item.runAt ? new Date(item.runAt).toISOString() : new Date(item.nextRunAt || Date.now()).toISOString(),
        time: item.time,
        everySeconds: item.everyMinutes ? item.everyMinutes * 60 : undefined,
      }));
      return { available: true, tasks };
    }
    if (endpoint === 'settings-describe') {
      const state = await api('GET', '/api/state');
      return {
        writable: false,
        hasDocument: true,
        namespaces: [{
          ns: 'locale',
          autoGenerate: false,
          schema: {},
          value: { preference: state.settings?.language || state.locale || 'zh' },
          applies: 'live',
          secrets: [],
          revision: 1,
        }],
      };
    }
    const error = new Error(unsupported);
    error.status = 501;
    throw error;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://bridge.local');
    const path = url.pathname;
    const send = (status, value) => {
      const body = JSON.stringify(value ?? {});
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      response.end(body);
    };
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
        response.end();
        return;
      }
      const header = request.headers.authorization || '';
      const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      const mobilePublic = path === '/api/mobile/v1/info' || path === '/api/mobile/v1/auth/refresh';
      if (!mobilePublic && presented !== options.token) {
        send(401, { message: 'Sign in with the access token printed when the host started.' });
        return;
      }
      if (request.method === 'GET' && path === '/api/mobile/v1/info') {
        send(200, { protocolVersion: 1, serverId: 'minimax-bot', name: 'MiniMax Bot', capabilities: {} });
        return;
      }
      if (request.method === 'POST' && path === '/api/mobile/v1/auth/refresh') {
        const body = await readJson(request);
        const refresh = typeof body.refreshToken === 'string' ? body.refreshToken : '';
        if (refresh !== options.token) {
          send(401, { error: { code: 'unauthorized', message: 'Sign in with the access token printed when the host started.' } });
          return;
        }
        send(200, {
          accessToken: options.token,
          refreshToken: options.token,
          deviceId: 'minimax-phone',
          serverId: 'minimax-bot',
          expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
        });
        return;
      }
      if (request.method === 'GET' && path === '/api/mobile/v1/state') {
        const { team } = await teamState();
        send(200, team);
        return;
      }
      if (request.method === 'GET' && path === '/api/mobile/v1/conversations') {
        const { state } = await teamState();
        const conversations = [
          ...(state.bots || []).map((bot) => conversationOfBot(bot, state)),
          ...(state.groups || []).map((group) => conversationOfGroup(group, state)),
        ];
        send(200, { conversations });
        return;
      }
      const messages = /^\/api\/mobile\/v1\/conversations\/([^/]+)\/messages$/.exec(path);
      if (request.method === 'GET' && messages) {
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(decodeURIComponent(messages[1]), state);
        const page = await api('GET', `/api/chats/${chatId}/messages?limit=80`);
        const list = (page.messages || []).slice(-40).flatMap(messageView);
        send(200, { messages: list, cursor: null, sessionId: list.at(-1)?.sessionId || chatId });
        return;
      }
      const target = /^\/api\/mobile\/v1\/conversations\/([^/]+)\/target$/.exec(path);
      if (request.method === 'GET' && target) {
        const state = await api('GET', '/api/state');
        const id = decodeURIComponent(target[1]);
        const chatId = chatIdOf(id, state);
        const sessionId = Object.values(state.sessions?.[chatId] || {})[0] || chatId;
        send(200, { conversationId: id, sessionId, revision: state.chats?.[chatId]?.lastTs || 0 });
        return;
      }
      if (request.method === 'POST' && path === '/api/mobile/v1/submissions') {
        const body = await readJson(request);
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(body.conversationId, state);
        await api('POST', `/api/chats/${chatId}/messages`, { text: body.text, clientMessageId: body.requestId });
        send(200, { requestId: body.requestId, status: 'accepted', conversationId: body.conversationId, sessionId: body.sessionId });
        broadcast();
        return;
      }
      const submission = /^\/api\/mobile\/v1\/submissions\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && submission) {
        send(404, { error: { code: 'not_found', message: '还没有这条发送回执。' } });
        return;
      }
      const cancel = /^\/api\/mobile\/v1\/conversations\/([^/]+)\/cancel$/.exec(path);
      if (request.method === 'POST' && cancel) {
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(decodeURIComponent(cancel[1]), state);
        send(200, await api('POST', `/api/chats/${encodeURIComponent(chatId)}/cancel`));
        return;
      }
      if (request.method === 'POST' && path === '/api/mobile/v1/actions') {
        const body = await readJson(request);
        send(200, await handleAction(body.endpoint, body.payload || {}));
        broadcast();
        return;
      }
      send(501, { message: unsupported });
    } catch (error) {
      send(error.status || 500, { message: error.message || '请求失败' });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://bridge.local');
    if (url.pathname !== '/api/mobile/v1/events') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    const timer = setTimeout(() => ws.close(), 20000);
    ws.on('message', (raw) => {
      let body = {};
      try { body = JSON.parse(String(raw)); } catch { return; }
      if (body.type !== 'auth' || body.token !== options.token) {
        ws.send(JSON.stringify({ type: 'error', error: { code: 'unauthorized', message: '令牌不对。' } }));
        ws.close();
        return;
      }
      clearTimeout(timer);
      ws.conversationId = String(body.conversationId || '');
      ws.send(JSON.stringify({ type: 'ready', conversationId: ws.conversationId }));
    });
    ws.on('close', () => sockets.delete(ws));
  });

  async function broadcast() {
    const grouped = new Map();
    for (const ws of sockets) {
      if (!ws.conversationId) continue;
      const ids = grouped.get(ws.conversationId) || [];
      ids.push(ws);
      grouped.set(ws.conversationId, ids);
    }
    for (const [conversationId, clients] of grouped) {
      let messages = [];
      try {
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(conversationId, state);
        const page = await api('GET', `/api/chats/${chatId}/messages?limit=40`);
        messages = (page.messages || []).flatMap(messageView);
      } catch { continue; }
      const event = JSON.stringify({ type: 'reset', conversationId, messages });
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(event);
      }
    }
  }

  const poll = setInterval(async () => {
    try {
      const state = await api('GET', '/api/state');
      const stamp = JSON.stringify({
        chats: state.chats,
        busy: state.busyChats,
        approvals: state.approvals,
        bots: (state.bots || []).map((bot) => [bot.id, bot.rev, bot.updatedAt]),
      });
      if (lastStamp && stamp !== lastStamp) broadcast();
      lastStamp = stamp;
    } catch { /* the next poll retries */ }
  }, 1500);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => { clearInterval(poll); server.close(); },
      });
    });
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

export const bridgeToken = () => randomBytes(18).toString('base64url');
