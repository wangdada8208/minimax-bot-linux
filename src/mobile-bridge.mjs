// @ts-check
/**
 * Speaks the DS-Bot App v0.1.0 mobile protocol (/api/mobile/v1) and translates
 * it onto the MiniMax Bot HTTP API. The phone UI is unchanged; only the calls
 * MiniMax actually has are wired through.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

const unsupported = '这台电脑上的 MiniMax Bot 没有这项。界面留着，功能对不上。';

/**
 * @param {{ port: number, host: string, token: string, pollIntervalMs?: number }} options
 */
export function startMobileBridge(options) {
  const origin = `http://${options.host}:${options.port}`;
  /** @type {Set<import('ws').WebSocket & { conversationId?: string }>} */
  const sockets = new Set();
  let broadcastQueue = Promise.resolve();
  let historyReadOrder = 0;
  let snapshotRevision = Date.now() * 1000;
  const sourceSnapshots = new Map();
  const fail = (message, status = 422, code = 'invalid_input') => { throw Object.assign(new Error(message), { status, code }); };
  const rejectFields = (value, allowed) => {
    const fields = Object.keys(value).filter((key) => !allowed.includes(key));
    if (fields.length) fail(`Unsupported fields: ${fields.join(', ')}`, 422, 'unsupported');
  };

  async function api(method, path, body) {
    const historyChat = method === 'GET' ? /^\/api\/chats\/([^/]+)\/messages\?/.exec(path)?.[1] : undefined;
    const readOrder = historyChat ? ++historyReadOrder : 0;
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
      const error = new Error(value.error?.message || value.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = value.error?.code || (typeof value.error === 'string' ? value.error : 'upstream_error');
      throw error;
    }
    if (historyChat && Array.isArray(value.messages)) {
      value.messages = value.messages.map((message) => {
        const key = JSON.stringify([historyChat, message.id]);
        const signature = JSON.stringify(message);
        const previous = sourceSnapshots.get(key);
        // An older HTTP read must not assign a newer version to stale content.
        if (previous && previous.readOrder > readOrder) return previous.message;
        const revision = previous?.signature === signature ? previous.revision : ++snapshotRevision;
        const projected = { ...message, bridgeRevision: revision };
        sourceSnapshots.set(key, { signature, revision, readOrder, message: projected });
        return projected;
      });
    }
    return value;
  }

  function modelRef(model) {
    if (!model) return undefined;
    if (typeof model === 'string') return model;
    if (!model.modelId) return undefined;
    return `${model.providerId}:${model.modelId}`;
  }

  async function modelPatch(ref, effort, previous) {
    if (ref === null || ref === '') return null;
    const catalog = await api('GET', '/api/models');
    const entry = (catalog.models || []).find((model) => modelRef(model) === ref);
    if (!entry) fail('Unknown model reference. Refresh the model catalog.');
    const selection = { ...(previous && modelRef(previous) === ref ? previous : {}), providerId: entry.providerId, modelId: entry.modelId };
    if (effort !== undefined) {
      delete selection.variant;
      delete selection.thinking;
      if (effort !== null && effort !== '' && effort !== 'default') {
        if (effort === 'off' && entry.variants?.includes('')) selection.variant = '';
        else if (entry.thinking?.efforts?.includes(effort)) {
          if (entry.variants?.includes('thinking')) selection.variant = 'thinking';
          selection.thinking = { effort };
        } else fail('Unsupported reasoning effort for this model.');
      }
    }
    return selection;
  }

  const reasoning = (entry) => ({
    efforts: [...(entry?.thinking?.efforts || []), ...(entry?.variants?.includes('') ? ['off'] : [])].map((id) => ({ id, name: id })),
    defaultEffort: entry?.thinking?.default,
  });

  function botView(bot, state) {
    const chatId = `bot:${bot.id}`;
    const sessionId = state.sessions?.[chatId]?.[bot.id] || chatId;
    const defaultEntry = state.defaultEntry;
    let effective = bot.model || state.defaultModel;
    if (!bot.model && bot.effort === 'off' && defaultEntry?.variants?.includes('')) effective = { ...state.defaultModel, variant: '' };
    else if (!bot.model && defaultEntry?.thinking?.efforts?.includes(bot.effort)) effective = { ...state.defaultModel, ...(defaultEntry.variants?.includes('thinking') ? { variant: 'thinking' } : {}), thinking: { effort: bot.effort } };
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role || '',
      instructions: bot.instructions || '',
      color: bot.color,
      model: modelRef(bot.model),
      appliedModel: modelRef(bot.model || state.defaultModel),
      appliedModelSelection: effective,
      modelSelection: bot.model || null,
      effort: bot.model?.variant === '' ? 'off' : bot.model?.thinking?.effort || bot.effort,
      autoHelper: bot.autoHelper,
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
      admin: group.adminId || null,
      notice: group.notice || '',
      mode: group.replyMode === 'all' ? 'everyone' : 'admin',
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
      preview: chat.preview || '',
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
      preview: chat.preview || '',
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
      createdAt: message.ts || message.startedAt || 0,
      author: message.botId,
      sourceMessageId: message.id,
      sourceSeq: message.seq ?? message.ts ?? 0,
      updatedSeq: message.bridgeRevision,
      sourceRevision: message.bridgeRevision,
      clientMessageId: message.clientMessageId,
      pending: message.status === 'streaming',
    };
    const role = message.role === 'user' ? 'user' : 'assistant';
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const steps = [];
    const seq = message.seq ?? message.ts ?? 0;
    let textIndex = 0;
    for (const part of parts) {
      if (part?.type === 'text' && part.text) {
        steps.push({
          ...base,
          id: `${message.id}:text:${textIndex}`,
          seq,
          partIndex: textIndex,
          role,
          text: part.text,
          pending: message.status === 'streaming',
        });
        textIndex += 1;
      }
    }
    if (!steps.length) {
      return [{
        ...base,
        id: message.id,
        seq: message.seq ?? message.ts ?? 0,
        role,
        text: message.text || '',
        partIndex: 0,
        pending: message.status === 'streaming',
      }];
    }
    // Earlier text segments are complete commentary; only the tail can still grow.
    for (const step of steps.slice(0, -1)) step.pending = false;
    return steps;
  }

  function receipt(message, conversationId, chatId) {
    return { requestId: message.clientMessageId, status: message.dispatchState === 'uncertain' ? 'uncertain' : 'accepted', conversationId, sessionId: message.sessionId || chatId, messageId: message.id, dispatchState: message.dispatchState };
  }

  // ---- notifications -------------------------------------------------------
  // The phone app polls this inbox; the host has no notification store of its
  // own, so the bridge derives events from approvals and finished replies.
  const NOTIFY_KINDS = ['reply', 'question', 'approval'];
  const notify = {
    items: [],
    cursor: 0,
    readThrough: 0,
    preferences: { enabled: false, categories: [...NOTIFY_KINDS] },
    seenApprovals: [],
    chatLastTs: {},
    leases: {},
  };
  if (options.notifyStorePath) {
    try {
      const saved = JSON.parse(readFileSync(options.notifyStorePath, 'utf8'));
      if (Array.isArray(saved.items)) notify.items = saved.items.filter((item) => item && Number.isInteger(item.id) && typeof item.conversationId === 'string' && NOTIFY_KINDS.includes(item.kind)).slice(-200);
      if (Number.isInteger(saved.cursor) && saved.cursor >= 0) notify.cursor = saved.cursor;
      if (Number.isInteger(saved.readThrough) && saved.readThrough >= 0) notify.readThrough = saved.readThrough;
      if (typeof saved.preferences?.enabled === 'boolean') notify.preferences.enabled = saved.preferences.enabled;
      if (Array.isArray(saved.preferences?.categories)) notify.preferences.categories = saved.preferences.categories.filter((kind) => NOTIFY_KINDS.includes(kind));
      if (Array.isArray(saved.seenApprovals)) notify.seenApprovals = saved.seenApprovals.filter((key) => typeof key === 'string').slice(-500);
      if (saved.chatLastTs && typeof saved.chatLastTs === 'object') notify.chatLastTs = saved.chatLastTs;
      if (saved.leases && typeof saved.leases === 'object') notify.leases = saved.leases;
    } catch {}
  }
  let notifyWriteTimer;
  function notifySave() {
    if (!options.notifyStorePath) return;
    clearTimeout(notifyWriteTimer);
    notifyWriteTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(options.notifyStorePath), { recursive: true });
        writeFileSync(options.notifyStorePath, JSON.stringify({
          items: notify.items, cursor: notify.cursor, readThrough: notify.readThrough,
          preferences: notify.preferences, seenApprovals: notify.seenApprovals,
          chatLastTs: notify.chatLastTs, leases: notify.leases,
        }));
      } catch {}
    }, 250);
    notifyWriteTimer.unref?.();
  }
  const notifyChat = (chatId) => String(chatId || '').replace(/^(bot|group):/, '');
  function notifyInbox() {
    return {
      items: notify.items
        .map((item) => ({ ...item, read: item.read || item.id <= notify.readThrough }))
        .sort((a, b) => b.id - a.id)
        .slice(0, 50),
      cursor: notify.cursor,
      pushRegistered: false,
      pushAvailable: false,
      preferences: { ...notify.preferences, categories: [...notify.preferences.categories], readThrough: notify.readThrough },
    };
  }
  function notifyAdd(conversationId, kind) {
    const id = ++notify.cursor;
    notify.items.push({ id, conversationId, kind, createdAt: Date.now(), read: false });
    if (notify.items.length > 200) notify.items.splice(0, notify.items.length - 200);
  }
  const messageText = (message) => {
    const parts = Array.isArray(message?.parts) ? message.parts.filter((part) => part?.type === 'text' && part.text).map((part) => part.text) : [];
    return (parts.length ? parts.join(' ') : message?.text) || '';
  };
  let notifyPending = false;
  async function sampleNotifications() {
    const state = await api('GET', '/api/state');
    const fresh = [];
    let changed = false;
    const seen = new Set(notify.seenApprovals);
    for (const item of state.approvals || []) {
      const key = String(item?.requestId || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      changed = true;
      fresh.push({ conversationId: notifyChat(item.chatId), kind: 'approval' });
    }
    notify.seenApprovals = [...seen].slice(-500);
    for (const [chatId, chat] of Object.entries(state.chats || {})) {
      const ts = Number(chat?.lastTs) || 0;
      if (!ts) continue;
      const known = notify.chatLastTs[chatId];
      // The first observation only records a baseline; old history is not news.
      if (known === undefined) { notify.chatLastTs[chatId] = ts; changed = true; continue; }
      if (ts <= known) continue;
      // Keep the old baseline while a turn is still running so the finished
      // reply is announced exactly once.
      if (chat?.pending) continue;
      notify.chatLastTs[chatId] = ts;
      changed = true;
      if (chat?.lastRole && chat.lastRole !== 'bot') continue;
      let page;
      try { page = await api('GET', `/api/chats/${chatId}/messages?limit=3`); } catch { continue; }
      const last = (page.messages || []).at(-1);
      if (!last || last.role === 'user' || last.status === 'streaming') continue;
      const text = messageText(last).trim();
      if (!text) continue;
      fresh.push({ conversationId: notifyChat(chatId), kind: /[?？]\s*$/.test(text) ? 'question' : 'reply' });
    }
    // At most one event per conversation and kind per sample: a burst of
    // messages must not turn into a burst of alerts.
    const dedup = new Map();
    for (const event of fresh) {
      if (!event.conversationId) continue;
      dedup.set(`${event.conversationId}|${event.kind}`, event);
    }
    for (const event of dedup.values()) { notifyAdd(event.conversationId, event.kind); changed = true; }
    if (changed) notifySave();
  }
  const notifyPoll = setInterval(() => {
    if (notifyPending) return;
    notifyPending = true;
    sampleNotifications().catch(() => {}).finally(() => { notifyPending = false; });
  }, options.notifyIntervalMs || 5000);
  notifyPoll.unref?.();
  sampleNotifications().catch(() => {});

  async function teamState() {
    const [state, catalog] = await Promise.all([
      api('GET', '/api/state'),
      api('GET', '/api/models'),
    ]);
    state.defaultModel = catalog.default;
    state.defaultEntry = (catalog.models || []).find((entry) => entry.providerId === catalog.default?.providerId && entry.modelId === catalog.default?.modelId);
    const bots = (state.bots || []).map((bot) => botView(bot, state));
    const rooms = (state.groups || []).map(roomView);
    const models = (catalog.models || []).map((model) => ({
      ref: modelRef({ providerId: model.providerId, modelId: model.modelId }),
      name: model.displayName || model.modelId,
      providerName: model.providerId,
      reasoning: reasoning(model),
      selection: { providerId: model.providerId, modelId: model.modelId },
    }));
    const main = (state.bots || []).find((bot) => bot.isMain);
    return {
      state,
      team: {
        bots,
        rooms,
        models,
        defaultModel: modelRef(catalog.default),
        scheduleTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        mobileFeatures: { primaryMain: false, replaceMain: true, weeklySchedules: false, groupSchedules: false, hidden: false, memoryQuery: false },
        capabilities: [],
        work: {
          bots: Object.fromEntries((state.busyChats || []).filter(id => id.startsWith('bot:')).map(id => [id.slice(4), {}])),
          rooms: {},
          approvals: (state.approvals || []).map(item => ({ id: item.requestId, botId: item.botId, roomId: item.chatId?.startsWith('group:') ? item.chatId.slice(6) : undefined })),
        },
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
    if (endpoint === 'set-prefs') {
      rejectFields(payload, ['language', 'userName']);
      const result = await api('PUT', '/api/settings', payload);
      return { theme: 'deepseek', ...result.settings };
    }
    if (endpoint === 'set-flags') {
      rejectFields(payload, ['id', 'pinned']);
      const state = await api('GET', '/api/state');
      const group = state.groups?.some((item) => item.id === payload.id);
      await api('PATCH', `/api/${group ? 'groups' : 'bots'}/${payload.id}`, { pinned: payload.pinned });
      return (await teamState()).team;
    }
    if (endpoint === 'duplicate-bot') {
      rejectFields(payload, ['id', 'name']);
      const state = await api('GET', '/api/state');
      const source = state.bots?.find((bot) => bot.id === payload.id);
      if (!source) fail('Bot not found.', 404, 'not_found');
      const created = await api('POST', '/api/bots', {
        name: payload.name || `${source.name} copy`, role: source.role, instructions: source.instructions,
        model: source.model, effort: source.effort, skin: source.skin, face: source.face, avatar: source.avatar, autoHelper: source.autoHelper,
      });
      return botView(created.bot, (await teamState()).state);
    }
    if (endpoint === 'create-bot') {
      rejectFields(payload, ['name', 'role', 'instructions', 'model', 'effort', 'avatar']);
      if (payload.avatar) rejectFields(payload.avatar, ['shape']);
      const created = await api('POST', '/api/bots', {
        name: payload.name,
        role: payload.role || '',
        instructions: payload.instructions || '',
        ...(payload.model ? { model: await modelPatch(payload.model, payload.effort) } : { effort: payload.effort }),
        ...(payload.avatar?.shape ? { skin: payload.avatar.shape } : {}),
      });
      const { state } = await teamState();
      return botView(created.bot, state);
    }
    if (endpoint === 'update-bot') {
      rejectFields(payload, ['id', 'name', 'role', 'instructions', 'pinned', 'model', 'effort', 'avatar', 'autoHelper']);
      if (payload.avatar) rejectFields(payload.avatar, ['shape']);
      const patch = {};
      for (const key of ['name', 'role', 'instructions', 'pinned', 'autoHelper']) {
        if (payload[key] !== undefined) patch[key] = payload[key];
      }
      if (payload.model !== undefined || payload.effort !== undefined) {
        const state = await api('GET', '/api/state');
        const bot = state.bots?.find((item) => item.id === payload.id);
        const ref = payload.model === undefined ? modelRef(bot?.model) : payload.model;
        if (ref) patch.model = await modelPatch(ref, payload.effort, bot?.model);
        else { if (payload.model !== undefined) patch.model = null; patch.effort = payload.effort; }
      }
      if (payload.avatar?.shape) patch.skin = payload.avatar.shape;
      const updated = await api('PATCH', `/api/bots/${payload.id}`, patch);
      const { state } = await teamState();
      return botView(updated.bot, state);
    }
    if (endpoint === 'delete-bot') return api('DELETE', `/api/bots/${payload.id}`);
    if (endpoint === 'set-main') {
      rejectFields(payload, ['id', 'main', 'replace', 'primary']);
      if (payload.primary) fail('Upstream does not support ordering a primary main bot.', 422, 'unsupported');
      const state = await api('GET', '/api/state');
      if (!state.bots?.some((bot) => bot.id === payload.id)) fail('Bot not found.', 404, 'not_found');
      if (payload.replace && payload.main === false) fail('Cannot replace main bots while removing the selected bot.');
      if (payload.replace !== undefined && typeof payload.replace !== 'boolean' && typeof payload.replace !== 'string') fail('replace must be a main bot id or boolean.');
      if (typeof payload.replace === 'string' && !state.bots.some((bot) => bot.id === payload.replace && bot.isMain)) fail('Replacement main bot not found.');
      await api('PATCH', `/api/bots/${payload.id}`, { isMain: payload.main !== false });
      if (payload.replace) {
        for (const bot of state.bots.filter((bot) => bot.isMain && bot.id !== payload.id && (payload.replace === true || bot.id === payload.replace))) {
          await api('PATCH', `/api/bots/${bot.id}`, { isMain: false });
        }
      }
      return (await teamState()).team;
    }
    if (endpoint === 'create-room') {
      rejectFields(payload, ['name', 'members', 'admin', 'notice', 'mode', 'greet']);
      if (payload.greet === false) fail('Upstream always creates a group welcome notice.', 422, 'unsupported');
      if (payload.mode !== undefined && !['everyone', 'all', 'admin'].includes(payload.mode)) fail('Unsupported room reply mode.');
      const created = await api('POST', '/api/groups', {
        name: payload.name,
        members: payload.members,
        admin: payload.admin,
        notice: payload.notice,
        replyMode: payload.mode === 'everyone' ? 'all' : payload.mode === 'all' ? 'all' : 'admin',
      });
      return roomView(created.group);
    }
    if (endpoint === 'update-room') {
      rejectFields(payload, ['id', 'name', 'members', 'admin', 'notice', 'mode', 'pinned']);
      const patch = {};
      if (payload.name !== undefined) patch.name = payload.name;
      if (payload.members !== undefined) patch.members = payload.members;
      if (payload.admin !== undefined) patch.admin = payload.admin;
      if (payload.mode !== undefined) {
        if (!['everyone', 'all', 'admin'].includes(payload.mode)) fail('Unsupported room reply mode.');
        patch.replyMode = payload.mode === 'everyone' ? 'all' : payload.mode;
      }
      if (payload.pinned !== undefined) patch.pinned = payload.pinned;
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
      if (!['allowed-once', 'rejected'].includes(payload.decision)) fail('Upstream approvals support allowed-once or rejected only; always-allow is unavailable.', 422, 'unsupported');
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
    if (endpoint === 'memory-ask') fail('Memory queries are unavailable. Use memory-view to read or memory-save to explicitly save a memory.', 422, 'unsupported');
    if (['memory-view', 'memory-save', 'memory-forget'].includes(endpoint)) {
      const scope = payload.botId || 'team';
      if (!/^(team|bot_[a-zA-Z0-9]+)$/.test(scope)) fail('Invalid memory scope.');
      if (payload.scope !== undefined && !['own', 'team'].includes(payload.scope)) fail('Invalid memory scope.');
      const list = async () => {
        const own = scope === 'team' ? null : await api('GET', `/api/memory/${scope}`);
        const team = await api('GET', '/api/memory/team');
        const entries = [
          ...(own?.entries || []).map((entry) => ({ ...entry, scope: 'own', topic: entry.key || null })),
          ...(team.entries || []).map((entry) => ({ ...entry, scope: 'team', topic: entry.key || null })),
        ];
        return {
          botId: payload.botId, entries,
          sizes: { own: own?.chars || 0, team: team.chars || 0 },
          limits: { main: team.budget?.limit ?? 100000, entry: team.budget?.entryMax ?? 1200, topic: 64, topics: team.budget?.entryLimit ?? 1000 },
          budgets: { own: own?.budget || null, team: team.budget, context: team.contextBudget },
          summary: entries.length ? { text: entries.map((entry) => entry.text).join('\n'), at: 0 } : null, fresh: true, summarizing: false,
        };
      };
      const target = payload.scope === 'team' ? 'team' : scope;
      if (endpoint === 'memory-forget') {
        if (!/^[a-f0-9]{8}$/.test(payload.id || '')) fail('Memory entry id is required. Refresh memory-view.');
        await api('DELETE', `/api/memory/${target}/${payload.id}`);
        return list();
      }
      if (endpoint === 'memory-save') {
        rejectFields(payload, ['botId', 'scope', 'text', 'topic', 'key', 'replaceId', 'expectedRevision', 'pinned']);
        const saved = await api('POST', `/api/memory/${target}`, {
          text: payload.text, key: payload.key ?? payload.topic, replaceId: payload.replaceId,
          expectedRevision: payload.expectedRevision, pinned: payload.pinned,
        });
        return { reply: saved.unchanged ? 'Memory unchanged.' : 'Memory saved.', changes: [{ op: saved.unchanged ? 'unchanged' : payload.replaceId ? 'replace' : 'add', scope: target === 'team' ? 'team' : 'own', text: saved.entry?.text || payload.text, id: saved.entry?.id, ok: true }], view: await list() };
      }
      return list();
    }
    if (endpoint === 'schedules' || endpoint === 'schedule-create' || endpoint === 'schedule-delete') {
      if (endpoint === 'schedule-delete') {
        await api('DELETE', `/api/schedules/${payload.id}`);
      }
      if (endpoint === 'schedule-create') {
        const when = payload.when || {};
        const state = await api('GET', '/api/state');
        if (!state.bots?.some((bot) => bot.id === payload.target)) fail('Schedules require a bot target; group schedules are unsupported.');
        const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if ((when.timeZone || payload.timeZone) && (when.timeZone || payload.timeZone) !== hostZone) fail(`Schedules use the host timezone: ${hostZone}.`);
        const body = { botId: payload.target, name: payload.title, prompt: payload.prompt };
        if (when.kind === 'every') {
          if (!Number.isInteger(when.minutes) || when.minutes < 5 || when.minutes > 10080) fail('Interval must be an integer from 5 to 10080 minutes.');
          body.kind = 'interval';
          body.everyMinutes = when.minutes;
        } else if (when.kind === 'at') {
          const minutes = (Date.parse(when.at) - Date.now()) / 60000;
          if (typeof when.at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(when.at) || !Number.isFinite(minutes) || minutes < 1 || minutes > 10080) fail('Date must include a timezone and be between 1 minute and 7 days in the future.');
          body.kind = 'once';
          body.inMinutes = Math.round(minutes);
        } else if (when.kind === 'daily') {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(when.time || '')) fail('Daily time must be HH:mm in the host timezone.');
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
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        everySeconds: item.everyMinutes ? item.everyMinutes * 60 : undefined,
      }));
      return { available: true, tasks };
    }
    if (endpoint === 'efforts') {
      const catalog = await api('GET', '/api/models');
      return reasoning((catalog.models || []).find((model) => modelRef(model) === (payload.model || payload.ref)));
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
    if (endpoint === 'notifications-list') return notifyInbox();
    if (endpoint === 'notifications-preferences') {
      rejectFields(payload, ['enabled', 'categories']);
      if (typeof payload.enabled !== 'boolean') fail('enabled must be a boolean.');
      if (payload.categories !== undefined) {
        if (!Array.isArray(payload.categories) || payload.categories.some((kind) => !NOTIFY_KINDS.includes(kind))) fail('Unknown notification category.');
        notify.preferences.categories = [...new Set(payload.categories)];
      }
      notify.preferences.enabled = payload.enabled;
      notifySave();
      return notifyInbox();
    }
    if (endpoint === 'notifications-read') {
      rejectFields(payload, ['through', 'ids']);
      if (payload.through !== undefined) {
        if (!Number.isInteger(payload.through) || payload.through < 0) fail('through must be a non-negative integer.');
        notify.readThrough = Math.max(notify.readThrough, payload.through);
      }
      if (payload.ids !== undefined) {
        if (!Array.isArray(payload.ids) || payload.ids.some((id) => !Number.isInteger(id) || id < 0)) fail('ids must be non-negative integers.');
        const ids = new Set(payload.ids);
        for (const item of notify.items) if (ids.has(item.id)) item.read = true;
      }
      notifySave();
      return { accepted: true, cursor: notify.cursor, readThrough: notify.readThrough };
    }
    if (endpoint === 'notifications-unregister') {
      notify.leases = {};
      notifySave();
      return { accepted: true };
    }
    if (endpoint === 'notifications-background-register') {
      rejectFields(payload, []);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      notify.leases[token] = expiresAt;
      notifySave();
      return { token, cursor: notify.cursor, expiresAt };
    }
    if (endpoint === 'notifications-background-unregister') {
      notify.leases = {};
      notifySave();
      return { accepted: true };
    }
    if (endpoint === 'notifications-register' || endpoint === 'notifications-test') {
      const error = new Error('云推送要 Apple 的推送凭据（APNs），这台主机没有配。用「后台通知」可以在 App 运行时收到提醒。');
      error.status = 422;
      error.code = 'unsupported';
      throw error;
    }
    const error = new Error(unsupported);
    error.status = 501;
    throw error;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://bridge.local');
    const path = url.pathname;
    const send = (status, value) => {
      if (status >= 400 && !value?.error?.code) value = { error: { code: status === 401 ? 'unauthorized' : status === 501 ? 'unsupported' : 'request_failed', message: value?.message || 'Request failed.' } };
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
      // The native background receiver authenticates with its own short lease,
      // not with the phone's access token.
      if (request.method === 'POST' && (path === '/mobile/v1/notifications/background' || path === '/api/mobile/v1/notifications/background')) {
        const header = request.headers.authorization || '';
        const lease = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
        const expiresAt = lease ? notify.leases[lease] : undefined;
        if (!expiresAt || expiresAt < Date.now()) {
          send(401, { message: 'The background registration expired. Reopen the app and reconnect.' });
          return;
        }
        const body = await readJson(request);
        const since = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
        send(200, {
          cursor: notify.cursor,
          deliveryEnabled: notify.preferences.enabled,
          items: notify.items
            .filter((item) => item.id > since && notify.preferences.categories.includes(item.kind))
            .slice(-50)
            .map((item) => ({ id: item.id, conversationId: item.conversationId, kind: item.kind, createdAt: item.createdAt })),
        });
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
        const limit = Number(url.searchParams.get('limit') ?? 40);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('limit must be an integer from 1 to 500.');
        const query = new URLSearchParams({ limit: String(limit) });
        const before = url.searchParams.get('cursor') || url.searchParams.get('before');
        if (before) query.set('before', before);
        const page = await api('GET', `/api/chats/${chatId}/messages?${query}`);
        const list = (page.messages || []).flatMap(messageView);
        send(200, { messages: list, cursor: page.nextBefore || null, hasMore: !!page.hasMore, replacedMessageIds: (page.messages || []).map((message) => message.id), sessionId: list.at(-1)?.sessionId || chatId, busy: (state.busyChats || []).includes(chatId) });
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
        rejectFields(body, ['conversationId', 'sessionId', 'requestId', 'text', 'attachments']);
        if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 0)) fail('Attachments are not supported by this mobile bridge.', 422, 'unsupported');
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.requestId)) fail('A valid requestId is required.');
        const result = await api('POST', `/api/chats/${chatId}/messages`, { text: body.text, clientMessageId: body.requestId });
        send(200, receipt(result.message, body.conversationId, chatId));
        broadcast();
        return;
      }
      const submission = /^\/api\/mobile\/v1\/submissions\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && submission) {
        const requestId = decodeURIComponent(submission[1]);
        const state = await api('GET', '/api/state');
        const requested = url.searchParams.get('conversationId');
        const chats = requested ? [chatIdOf(requested, state)] : [...new Set([
          ...Object.keys(state.chats || {}), ...(state.bots || []).map((bot) => `bot:${bot.id}`), ...(state.groups || []).map((group) => `group:${group.id}`),
        ])];
        let found;
        for (const chatId of chats) {
          let before;
          const seen = new Set();
          do {
            const query = new URLSearchParams({ limit: '500', ...(before ? { before } : {}) });
            const page = await api('GET', `/api/chats/${chatId}/messages?${query}`);
            const message = (page.messages || []).find((item) => item.role === 'user' && item.clientMessageId === requestId);
            if (message) {
              if (found) fail('Receipt id exists in multiple conversations; provide conversationId.', 409, 'ambiguous_receipt');
              found = receipt(message, chatId.replace(/^(bot|group):/, ''), chatId);
              break;
            }
            before = page.hasMore ? page.nextBefore : null;
            if (before && seen.has(before)) fail('Upstream history cursor did not advance.', 502, 'upstream_error');
            seen.add(before);
          } while (before);
        }
        if (!found) fail('No durable receipt was found in upstream history.', 404, 'not_found');
        send(200, found);
        return;
      }
      const cancel = /^\/api\/mobile\/v1\/conversations\/([^/]+)\/cancel$/.exec(path);
      if (request.method === 'POST' && cancel) {
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(decodeURIComponent(cancel[1]), state);
        send(200, await api('POST', `/api/chats/${chatId}/cancel`));
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
      send(error.status || (error instanceof SyntaxError ? 400 : 500), { error: { code: error.code || (error instanceof SyntaxError ? 'invalid_json' : 'request_failed'), message: error.message || '请求失败' } });
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
      broadcast();
    });
    ws.on('close', () => { clearTimeout(timer); sockets.delete(ws); });
  });

  function broadcast() {
    // One queue covers auth, mutation and timer snapshots: no older fetch can overtake a newer one.
    broadcastQueue = broadcastQueue.then(broadcastSnapshot).catch(() => {});
    return broadcastQueue;
  }

  async function broadcastSnapshot() {
    const grouped = new Map();
    for (const ws of sockets) {
      if (!ws.conversationId) continue;
      const ids = grouped.get(ws.conversationId) || [];
      ids.push(ws);
      grouped.set(ws.conversationId, ids);
    }
    for (const [conversationId, clients] of grouped) {
      let snapshot;
      try {
        const state = await api('GET', '/api/state');
        const chatId = chatIdOf(conversationId, state);
        const page = await api('GET', `/api/chats/${chatId}/messages?limit=40`);
        snapshot = { type: 'reset', conversationId, messages: (page.messages || []).flatMap(messageView), replacedMessageIds: (page.messages || []).map((message) => message.id), busy: (state.busyChats || []).includes(chatId) };
      } catch { continue; }
      const event = JSON.stringify(snapshot);
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(event);
      }
    }
  }

  // Message text and parts can change while lastTs stays fixed. Always sample subscribed chats.
  const poll = setInterval(() => {
    if (sockets.size && !pollPending) {
      pollPending = true;
      broadcast().finally(() => { pollPending = false; });
    }
  }, options.pollIntervalMs || 1500);
  let pollPending = false;

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => { clearInterval(poll); clearInterval(notifyPoll); clearTimeout(notifyWriteTimer); for (const ws of sockets) ws.terminate(); wss.close(); server.close(); },
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
