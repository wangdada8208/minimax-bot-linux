import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBotAgent } from '../src/native-agent.mjs';

function queue(signal) {
  const items = []; let wake;
  const abort = () => { wake?.(); };
  signal?.addEventListener('abort', abort, { once: true });
  return {
    push(value) { items.push(value); wake?.(); },
    async *[Symbol.asyncIterator]() {
      try {
        while (!signal?.aborted) {
          if (items.length) yield items.shift();
          else await new Promise(resolve => { wake = resolve; if (signal?.aborted || items.length) resolve(); });
        }
      } finally { signal?.removeEventListener('abort', abort); }
    },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let bus, next = 0;
  const calls = [], sessions = new Map(), questions = new Map(), permissions = [];
  const adapter = {
    async *watchEvents(signal) { bus = queue(signal); yield* bus; },
    async createSession(input) { const session = { sessionId: `s${++next}`, agentName: 'mavis' }; sessions.set(session.sessionId, session); calls.push(['create', input]); return session; },
    async getSession(id) { if (!sessions.has(id)) throw Error('Unknown session'); return sessions.get(id); },
    async configureSessionMcpServers(...args) { calls.push(['mcp', ...args]); },
    async setPermissionMode(mode) { calls.push(['permissionMode', mode]); },
    async selectSessionModel(...args) { calls.push(['model', ...args]); return true; },
    async selectModel() { throw Error('Bot turns must not change the global default model'); },
    async getPendingQuestionnaire(name, id) { calls.push(['pending', name, id]); return questions.get(id); },
    async getActiveRun(id) { return { state: 'idle', sessionId: id }; },
    async listPendingPermissions() { return permissions; },
    async replyPermission(...args) { calls.push(['permission', ...args]); return true; },
    async abortSession(req) { calls.push(['abort', req]); return true; },
    async replyQuestionnaire(name, requestId, answers) {
      calls.push(['answer', name, requestId, answers]);
      const [id] = [...questions].find(([, question]) => question.id === requestId);
      questions.delete(id);
      bus.push({ type: 'session.start', sessionId: id, turnId: `continuation-${id}` });
      await tick(); return true;
    },
    async dismissQuestionnaire(name, id) { calls.push(['dismiss', name, id]); for (const [sessionId, question] of questions) if (question.id === id) questions.delete(sessionId); return true; },
    async *sendMessage(req) { calls.push(['send', req]); yield { type: 'delta', messageId: 'm1', content: 'Hello' }; yield { type: 'message', message: { id: 'm1', role: 'assistant', content: 'Hello' } }; yield { type: 'done' }; },
    async *watchSessionTurn(id, turnId) { calls.push(['watch', id, turnId]); yield { type: 'message', message: { id: 'm2', role: 'assistant', content: 'Continued' } }; yield { type: 'done' }; },
    async listModels() { return [{ providerId: 'p', modelId: 'm', selected: true, supportedVariants: ['fast'], effortOptions: ['low', 'high'], defaultEffort: 'high' }]; },
  };
  const runtime = { adapter };
  return { adapter, runtime, calls, sessions, questions, permissions, emit: event => bus.push(event),
    agent: options => new NativeBotAgent({ runtime, cwd: '/workspace', ...options }) };
}
function question(sessionId, mode = 'feature-enable') {
  return { schemaVersion: 2, id: `original-${sessionId}`, mode, modePayload: { featureKey: 'browser-use', extra: { raw: true } }, expiresAt: 9999999999999,
    requester: { sessionId, agentName: 'mavis' }, presentation: { replaceComposer: true },
    steps: [{ id: 'enable', question: 'Enable Browser Use?', selectionMode: 'single', options: [{ id: 'yes', label: 'Enable' }], allowOther: true, required: true }] };
}

test('native run sends official request, selects official model, projects events without duplicate final text', async () => {
  const f = fixture(); const agent = f.agent({ mcpUrl: 'http://localhost/team', mcpToken: 'token' });
  const events = [], model = { providerId: 'p', modelId: 'm', thinking: { effort: 'high' } };
  try {
    const result = await agent.run({ text: 'hello', model }, { onEvent: event => events.push(event) });
    assert.equal(result.text, 'Hello'); assert.equal(result.status, 'finished');
    assert.deepEqual(events.map(event => event.type), ['turn.started', 'text.delta', 'message.committed', 'turn.finished']);
    assert.deepEqual(f.calls.find(call => call[0] === 'send')[1], { id: 's1', turnId: result.turnId, content: 'hello', model });
    assert.deepEqual(f.calls.find(call => call[0] === 'model'), ['model', model, 's1']);
    assert.deepEqual(f.calls.find(call => call[0] === 'permissionMode'), ['permissionMode', 'bypassPermissions']);
    assert.equal(f.calls.find(call => call[0] === 'mcp')[2][0].headers.Authorization, 'Bearer token');
    assert.equal(f.calls.find(call => call[0] === 'mcp')[2][0].name, 'minimax_bot', 'MCP alias must be a valid identifier for official run_code');
    await agent.run({ text: 'again', sessionId: result.sessionId });
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  } finally { await agent.dispose(); }
});

test('raw questionnaire releases a still-active reader; answer observes exact official continuation', async () => {
  const f = fixture(); const agent = f.agent(); const events = [];
  f.adapter.sendMessage = async function* (req, signal) {
    const pending = question(req.id); f.questions.set(req.id, pending);
    f.emit({ type: 'questionnaire.ask', sessionId: req.id, agentName: 'mavis', request: pending });
    yield* queue(signal);
  };
  try {
    const result = await agent.run({ text: 'browse' }, { onEvent: event => events.push(event) });
    assert.deepEqual(result.pendingQuestion, { requestId: 'original-s1', mode: 'feature-enable', request: question('s1') });
    assert.equal(events.at(-1).type, 'turn.finished');
    assert.equal(f.calls.some(call => call[0] === 'abort'), false);
    const answers = [{ stepId: 'enable', selectedOptionIds: ['yes'], selectedOther: false }];
    const continued = await agent.answer({ sessionId: 's1', requestId: 'original-s1', answers });
    assert.equal(continued.turnId, 'continuation-s1'); assert.equal(continued.text, 'Continued');
    assert.deepEqual(f.calls.find(call => call[0] === 'answer'), ['answer', 'mavis', 'original-s1', answers]);
    assert.deepEqual(f.calls.find(call => call[0] === 'watch'), ['watch', 's1', 'continuation-s1']);
  } finally { await agent.dispose(); }
});

test('stream-ending questionnaires recover even when ask event was missed; pending survives Agent replacement', async () => {
  const f = fixture(); let agent = f.agent();
  f.adapter.sendMessage = async function* (req) {
    f.questions.set(req.id, question(req.id, 'plan'));
    yield { type: 'error', message: 'Questionnaire requires user input' }; yield { type: 'done' };
  };
  const first = await agent.run({ text: 'plan' });
  assert.equal(first.status, 'finished'); assert.equal(first.error, undefined);
  await agent.dispose(); agent = f.agent();
  try {
    const recovered = await agent.run({ sessionId: first.sessionId, text: 'do not send this' });
    assert.deepEqual(recovered.pendingQuestion, first.pendingQuestion);
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
    const continued = await agent.answer({ sessionId: first.sessionId, requestId: first.pendingQuestion.requestId, answers: [] });
    assert.equal(continued.turnId, 'continuation-s1');
  } finally { await agent.dispose(); }
});

test('explicit Browser Use decline uses official dismiss and never answers or enables', async () => {
  const f = fixture(); f.sessions.set('saved', { sessionId: 'saved', agentName: 'custom' }); f.questions.set('saved', question('saved'));
  const agent = f.agent();
  try {
    await assert.rejects(agent.dismiss({ sessionId: 'saved', requestId: 'wrong' }), { code: 'INVALID_ARGUMENTS' });
    assert.deepEqual(await agent.dismiss({ sessionId: 'saved', requestId: 'original-saved' }), { sessionId: 'saved', status: 'finished' });
    assert.deepEqual(f.calls.find(call => call[0] === 'dismiss'), ['dismiss', 'custom', 'original-saved']);
    assert.equal(f.calls.some(call => call[0] === 'answer' || call[0] === 'permissionMode'), false);
  } finally { await agent.dispose(); }
});

test('independent Bot sessions run concurrently while duplicate same-session operations reject BUSY', async () => {
  const f = fixture(); const agent = f.agent(); let release;
  const latch = new Promise(resolve => { release = resolve; });
  f.adapter.sendMessage = async function* (req) { await latch; yield { type: 'message', message: { role: 'assistant', content: req.id } }; yield { type: 'done' }; };
  try {
    const a = agent.run({ text: 'a' }); const b = agent.run({ text: 'b' }); await tick();
    await assert.rejects(agent.run({ sessionId: 's1', text: 'collision' }), { code: 'BUSY' });
    release(); const results = await Promise.all([a, b]); assert.deepEqual(results.map(result => result.sessionId), ['s1', 's2']);
  } finally { release(); await agent.dispose(); }
});

test('permissions preserve request identity and delegated session; reply uses durable inventory', async () => {
  const f = fixture(); const agent = f.agent({ bypassPermissions: false }); const events = [];
  f.adapter.sendMessage = async function* (req) {
    f.sessions.set('child', { sessionId: 'child', parentSessionId: req.id, agentName: 'worker' });
    f.permissions.push({ sessionId: 'child', requestId: 'official-permission', agentName: 'worker', toolName: 'bash', toolInput: '{"command":"pwd"}', reason: 'approval' });
    f.emit({ type: 'permission.ask', request: f.permissions[0] }); await tick(); await tick(); yield { type: 'done' };
  };
  try {
    await agent.run({ text: 'delegate' }, { onEvent: event => { events.push(event); } });
    const permission = events.find(event => event.type === 'permission.requested');
    assert.equal(permission.sessionId, 'child'); assert.equal(permission.requestId, 'official-permission');
    await agent.reply({ sessionId: 'child', requestId: permission.requestId, decision: 'deny' });
    assert.deepEqual(f.calls.find(call => call[0] === 'permission'), ['permission', 'worker', 'official-permission', 'deny']);
    await assert.rejects(agent.reply({ sessionId: 's1', requestId: permission.requestId, decision: 'allowOnce' }), { code: 'REQUEST_NOT_FOUND' });
    await assert.rejects(agent.reply({ sessionId: 'child', requestId: permission.requestId, decision: 'allowAlways' }), { code: 'INVALID_ARGUMENTS' });
  } finally { await agent.dispose(); }
});

test('official model roster supplies selectable variants and effort choices without endpoint fetches', async () => {
  const f = fixture(); const agent = f.agent();
  try {
    const catalog = await agent.loadModels();
    assert.equal(catalog.models[0].supported, true);
    assert.deepEqual(catalog.models[0].variants, ['fast']);
    assert.deepEqual(catalog.models[0].thinking, { efforts: ['low', 'high'], default: 'high' });
    assert.deepEqual(catalog.default, { providerId: 'p', modelId: 'm', thinking: { effort: 'high' } });
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
  } finally { await agent.dispose(); }
});

test('cancellation only reports aborted after official confirmation; pre-dispatch abort sends nothing', async () => {
  const f = fixture(); const agent = f.agent();
  f.adapter.sendMessage = async function* (_req, signal) { yield* queue(signal); };
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(agent.run({ text: 'cancel' }, { signal: before.signal }), { code: 'REQUEST_CANCELLED' });
    assert.equal(f.calls.length, 0);
    const controller = new AbortController();
    const promise = agent.run({ text: 'running' }, { signal: controller.signal }); await tick(); controller.abort();
    assert.equal((await promise).status, 'aborted');
    f.adapter.abortSession = async () => false;
    const unknown = new AbortController(); const next = agent.run({ text: 'unknown' }, { signal: unknown.signal }); await tick(); unknown.abort();
    await assert.rejects(next, { code: 'AGENT_OUTCOME_UNKNOWN', retryable: false });
  } finally { await agent.dispose(); }
});

test('custom root agent uses official cliService creation without editing builtins', async () => {
  const f = fixture();
  f.runtime.host = { cliService: { async createSession(req) { f.calls.push(['customCreate', req]); f.sessions.set('custom', { sessionId: 'custom', agentName: req.name }); return { sessionId: 'custom' }; } } };
  const agent = f.agent({ agentName: 'bot-no-browser' });
  try {
    const result = await agent.run({ text: 'hello' }); assert.equal(result.sessionId, 'custom');
    assert.deepEqual(f.calls.find(call => call[0] === 'customCreate'), ['customCreate', { name: 'bot-no-browser', workspaceDir: '/workspace' }]);
  } finally { await agent.dispose(); }
});

test('questionnaire tool result recovers a missed bus event while its reader stays active', async () => {
  const f = fixture(); const agent = f.agent();
  f.adapter.sendMessage = async function* (req, signal) {
    f.questions.set(req.id, question(req.id));
    yield { type: 'delta', toolCalls: [{ id: 'ask', name: 'ask_user_question', status: 2, output: { details: { waiting_for_user: true } } }] };
    yield* queue(signal);
  };
  try {
    const result = await agent.run({ text: 'question' });
    assert.equal(result.pendingQuestion.requestId, 'original-s1');
  } finally { await agent.dispose(); }
});

test('answer cannot run inline before the paused run releases its slot', async () => {
  const f = fixture(); const agent = f.agent(); let inline;
  f.adapter.sendMessage = async function* (req, signal) {
    const pending = question(req.id); f.questions.set(req.id, pending);
    f.emit({ type: 'questionnaire.ask', sessionId: req.id, request: pending }); yield* queue(signal);
  };
  try {
    await agent.run({ text: 'question' }, { onEvent: event => {
      if (event.type === 'question.requested') inline = assert.rejects(agent.answer({ sessionId: event.sessionId, requestId: event.requestId, answers: [] }), { code: 'BUSY' });
    } });
    await inline;
  } finally { await agent.dispose(); }
});

test('fast continuation questionnaire is recovered before attaching its active reader', async () => {
  const f = fixture(); f.sessions.set('saved', { sessionId: 'saved', agentName: 'mavis' }); f.questions.set('saved', question('saved'));
  f.adapter.replyQuestionnaire = async () => {
    f.questions.set('saved', { ...question('saved', 'plan'), id: 'second' });
    f.emit({ type: 'session.start', sessionId: 'saved', turnId: 'next' }); await tick(); return true;
  };
  f.adapter.watchSessionTurn = async function* (_id, _turnId, signal) { yield* queue(signal); };
  const agent = f.agent();
  try {
    const result = await agent.answer({ sessionId: 'saved', requestId: 'original-saved', answers: [] });
    assert.equal(result.pendingQuestion.requestId, 'second'); assert.equal(result.turnId, 'next');
  } finally { await agent.dispose(); }
});

test('permission without a renderer is explicitly denied through the official API', async () => {
  const f = fixture(); const agent = f.agent();
  f.adapter.sendMessage = async function* (req) {
    f.emit({ type: 'permission.ask', request: { requestId: 'unattended', sessionId: req.id, agentName: 'mavis' } });
    await tick(); await tick(); yield { type: 'done' };
  };
  try {
    await agent.run({ text: 'unattended' });
    assert.deepEqual(f.calls.find(call => call[0] === 'permission'), ['permission', 'mavis', 'unattended', 'deny']);
  } finally { await agent.dispose(); }
});

test('invalid interaction identities never create accidental sessions', async () => {
  const f = fixture(); const agent = f.agent();
  try {
    await assert.rejects(agent.answer({ requestId: 'id', answers: [] }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(agent.dismiss({ requestId: 'id' }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(agent.run({ text: 'hello', sessionId: '' }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(agent.reply({ requestId: 'id', decision: 'deny' }), { code: 'INVALID_ARGUMENTS' });
    assert.equal(f.calls.length, 0);
  } finally { await agent.dispose(); }
});

test('tool snapshots deduplicate lifecycle events and delta-only messages are committed', async () => {
  const f = fixture(); const agent = f.agent(); const events = [];
  f.adapter.sendMessage = async function* () {
    yield { type: 'delta', messageId: 'answer', content: 'Final', toolCalls: [{ id: 'tool', name: 'bash', status: '1' }] };
    yield { type: 'delta', toolCalls: [{ id: 'tool', name: 'bash', status: 'succeeded' }] };
    yield { type: 'delta', toolCalls: [{ id: 'tool', name: 'bash', status: 2 }] };
    yield { type: 'done' };
  };
  try {
    const result = await agent.run({ text: 'tools' }, { onEvent: event => events.push(event) });
    assert.equal(result.text, 'Final');
    assert.equal(events.filter(event => event.type === 'tool.started').length, 1);
    assert.equal(events.filter(event => event.type === 'tool.finished').length, 1);
    assert.equal(events.find(event => event.type === 'tool.finished').ok, true);
    assert.equal(events.filter(event => event.type === 'message.committed').length, 1);
    assert.equal(events.at(-1).type, 'turn.finished');
  } finally { await agent.dispose(); }
});

test('answer waits past the original still-running turn for its queued official continuation', async () => {
  const f = fixture(); f.sessions.set('saved', { sessionId: 'saved', agentName: 'mavis' });
  const pending = question('saved'); pending.requester.runId = 'original-turn'; f.questions.set('saved', pending);
  f.adapter.replyQuestionnaire = async () => { f.questions.delete('saved'); return true; };
  f.adapter.getActiveRun = async () => {
    f.emit({ type: 'session.start', sessionId: 'saved', turnId: 'original-turn' });
    setImmediate(() => f.emit({ type: 'session.start', sessionId: 'saved', turnId: 'queued-continuation' }));
    return { state: 'running', turnId: 'original-turn' };
  };
  const agent = f.agent();
  try {
    const result = await agent.answer({ sessionId: 'saved', requestId: pending.id, answers: [] });
    assert.equal(result.turnId, 'queued-continuation');
    assert.deepEqual(f.calls.find(call => call[0] === 'watch'), ['watch', 'saved', 'queued-continuation']);
  } finally { await agent.dispose(); }
});

test('legacy browser wait is declined and future work moves to official custom policy without replay', async () => {
  const f = fixture(); f.sessions.set('legacy', { sessionId: 'legacy', agentName: 'mavis' });
  f.questions.set('legacy', question('legacy'));
  f.adapter.getMessages = async id => { assert.equal(id, 'legacy'); return [{ role: 'user', content: 'Earlier task' }, { role: 'assistant', content: 'Earlier result' }]; };
  f.runtime.host = { cliService: { async createSession(input) { assert.equal(input.name, 'minimax-bot-linux'); f.sessions.set('custom', { sessionId: 'custom', agentName: input.name }); return { sessionId: 'custom' }; } } };
  const agent = f.agent({ agentName: 'minimax-bot-linux', logger: { info() {} } });
  try {
    const result = await agent.run({ sessionId: 'legacy', text: 'New read-only task' });
    assert.equal(result.sessionId, 'custom');
    assert.ok(f.sessions.has('legacy'));
    assert.deepEqual(f.calls.find(c => c[0] === 'dismiss'), ['dismiss', 'mavis', 'original-legacy']);
    const sends = f.calls.filter(c => c[0] === 'send'); assert.equal(sends.length, 1);
    assert.equal(sends[0][1].id, 'custom'); assert.match(sends[0][1].content, /historical-reference/);
    assert.match(sends[0][1].content, /Current request:\nNew read-only task/);
    assert.equal(f.calls.some(c => c[0] === 'answer'), false);
    assert.equal(agent.slots.size, 0);
  } finally { await agent.dispose(); }
});

test('migrated sessions restore official standing identity for automatic team result routing', async () => {
  const f = fixture(); f.sessions.set('custom', { sessionId: 'custom', agentName: 'minimax-bot-linux' });
  const brief = '<minimax-bot-context>\nAlways set caller_bot_id to bot_chief.\n</minimax-bot-context>';
  const reference = JSON.stringify([{ role: 'user', content: brief + '\nOld request' }]);
  f.adapter.getMessages = async () => [{ role: 'user', content: `This conversation now uses the administrator-configured official Custom Agent. Old session retained.\n<historical-reference>\n${reference}\n</historical-reference>\nCurrent request: old` }];
  const agent = f.agent({ agentName: 'minimax-bot-linux' });
  try {
    await agent.run({ sessionId: 'custom', text: 'New task' });
    assert.equal(f.calls.find(c => c[0] === 'send')[1].content, `${brief}\n\nNew task`);
    assert.equal(f.calls.some(c => c[0] === 'create'), false);
  } finally { await agent.dispose(); }
});

test('legacy genuine questionnaire stays pending instead of migrating or replaying work', async () => {
  const f = fixture(); f.sessions.set('legacy', { sessionId: 'legacy', agentName: 'mavis' });
  f.questions.set('legacy', question('legacy', 'questionnaire'));
  const agent = f.agent({ agentName: 'minimax-bot-linux' });
  try {
    const r = await agent.run({ sessionId: 'legacy', text: 'New task' });
    assert.equal(r.pendingQuestion.requestId, 'original-legacy');
    assert.equal(f.calls.some(c => ['send', 'dismiss', 'answer', 'create'].includes(c[0])), false);
  } finally { await agent.dispose(); }
});

test('accepted answer without an observable continuation rejects outcome unknown, never resends user text', async () => {
  const f = fixture(); f.sessions.set('saved', { sessionId: 'saved', agentName: 'mavis' }); f.questions.set('saved', question('saved'));
  f.adapter.replyQuestionnaire = async () => { f.questions.delete('saved'); return true; };
  const agent = f.agent({ continuationTimeoutMs: 5 });
  try {
    await assert.rejects(agent.answer({ sessionId: 'saved', requestId: 'original-saved', answers: [] }), { code: 'AGENT_OUTCOME_UNKNOWN', retryable: false });
    assert.equal(f.calls.some(call => call[0] === 'send'), false);
  } finally { await agent.dispose(); }
});
