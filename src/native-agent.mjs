import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class NativeAgentError extends Error {
  constructor(code, message, retryable = false) {
    super(message); this.name = 'AgentError'; this.code = code; this.retryable = retryable;
  }
}
const fail = (code, message, retryable) => new NativeAgentError(code, message, retryable);
function classify(error) {
  if (error instanceof NativeAgentError) return error;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error);
  if (/INVALID|VALIDATION/.test(code)) return fail('INVALID_ARGUMENTS', message);
  if (/NOT_FOUND|NOT_PENDING|ALREADY_ANSWERED/.test(code)) return fail('REQUEST_NOT_FOUND', message);
  if (/CONTINUATION_NOT_STARTED/.test(code)) return fail('AGENT_OUTCOME_UNKNOWN', message);
  if (/login|authentication|not permitted|scope mismatch/i.test(message)) return fail('NOT_PERMITTED', message);
  if (/active turn|already active|busy/i.test(message)) return fail('BUSY', message, true);
  return fail('AGENT_UNAVAILABLE', message, true);
}
const pendingView = request => {
  const view = structuredClone(request);
  // The official persisted TUI row accepts numeric enum values; MiniApp's
  // declared questionnaire contract uses string values for the same choices.
  view.steps = (view.steps ?? []).map(step => ({ ...step,
    selectionMode: step.selectionMode === 1 || step.selectionMode === 'multiple' ? 'multiple' : 'single' }));
  return { requestId: request.id, mode: request.mode ?? 'questionnaire', request: view };
};

const MIGRATION_HEADER = 'This conversation now uses the administrator-configured official Custom Agent.';
function standingContext(rows, depth = 0) {
  if (depth > 4) return '';
  let context = '';
  for (const row of rows) {
    if (row.role !== 'user' || typeof row.content !== 'string') continue;
    let text = row.content;
    if (text.startsWith(MIGRATION_HEADER)) {
      const start = text.indexOf('<historical-reference>\n');
      const end = text.indexOf('\n</historical-reference>', start);
      if (start >= 0 && end > start) {
        try {
          const snapshot = JSON.parse(text.slice(start + '<historical-reference>\n'.length, end));
          context = standingContext(Array.isArray(snapshot) ? snapshot : [snapshot.first, ...(snapshot.recent ?? [])].filter(Boolean), depth + 1) || context;
        } catch { /* A damaged reference must not become fresh instructions. */ }
        text = text.slice(end + '\n</historical-reference>'.length);
      }
    }
    const blocks = text.match(/<minimax-bot-context>[\s\S]*?<\/minimax-bot-context>/g);
    if (blocks?.length) context = blocks.at(-1);
  }
  return context;
}

/** Native Mini App Agent glue. All execution, validation, persistence and feature
 * decisions belong to the unmodified official runtime. Build its native exports
 * with scripts/build-official.mjs after the official CLI build. The native module
 * uses the official worker/resource-location profile. env must be installed by the process bootstrap;
 * an embedded runtime shares process.env and cannot isolate per-Agent envs.
 */
export class NativeBotAgent {
  static async create(options = {}) {
    if (options.runtime) return new NativeBotAgent(options);
    if (options.env && Object.entries(options.env).some(([key, value]) => value !== process.env[key])) {
      throw fail('INVALID_ARGUMENTS', 'Install env in the runtime process before calling NativeBotAgent.create.');
    }
    const officialRoot = resolve(options.officialRoot ?? process.env.MINIMAX_RUNTIME_DIR ?? process.cwd());
    // Use the official build's module-location profile so workers, WASM and
    // native resources resolve beside dist/cli.js, exactly as in the CLI build.
    const [{ prepareTuiDataDir, createTuiRuntime, shutdownTuiRuntime }, manifest] = await Promise.all([
      import(pathToFileURL(resolve(officialRoot, 'dist/bot-native.mjs')).href),
      readFile(resolve(officialRoot, 'package.json'), 'utf8'),
    ]);
    const runtime = await createTuiRuntime({ dataDir: options.dataDir ?? await prepareTuiDataDir(),
      workspaceDir: options.cwd ?? process.cwd(), version: JSON.parse(manifest).version, surface: 'acp',
      ...(options.systemPromptOverrides ? { systemPromptOverrides: options.systemPromptOverrides } : {}) });
    try { return new NativeBotAgent({ ...options, runtime, shutdown: shutdownTuiRuntime }); }
    catch (error) { await shutdownTuiRuntime(runtime); throw error; }
  }

  constructor({ runtime, shutdown, cwd = process.cwd(), mcpUrl, mcpToken, agentName,
    bypassPermissions = true, continuationTimeoutMs = 10_000, logger = console } = {}) {
    if (!runtime) throw fail('INVALID_ARGUMENTS', 'An official runtime is required.');
    this.runtime = runtime; this.adapter = runtime.adapter ?? runtime; this.shutdown = shutdown;
    this.cwd = cwd; this.agentName = agentName; this.bypassPermissions = bypassPermissions;
    this.continuationTimeoutMs = continuationTimeoutMs; this.logger = logger;
    // A JavaScript-safe MCP alias also works with official programmatic tools.
    // The endpoint and all official team-tool implementations remain unchanged.
    this.servers = mcpUrl ? [{ name: 'minimax_bot', type: 'http', url: mcpUrl,
      ...(mcpToken ? { headers: { Authorization: `Bearer ${mcpToken}` } } : {}) }] : [];
    this.slots = new Set(); this.observers = new Map(); this.listeners = new Set();
    this.controller = new AbortController(); this.disposed = false;
    this.events = this.#watchEvents();
  }

  #assert(signal) {
    if (this.disposed) throw fail('AGENT_UNAVAILABLE', 'The native runtime is disposed.', true);
    if (this.eventError) throw classify(this.eventError);
    if (signal?.aborted) throw fail('REQUEST_CANCELLED', 'Cancelled before dispatch.');
  }
  async #watchEvents() {
    try {
      for await (const event of this.adapter.watchEvents(this.controller.signal)) {
        for (const listener of this.listeners) listener(event);
        await this.#interaction(event);
      }
      if (!this.disposed) throw new Error('Official runtime event stream ended.');
    } catch (error) {
      if (!this.disposed) {
        this.eventError = error;
        for (const observer of this.observers.values()) observer.fail(classify(error));
      }
    }
  }
  async #owner(sessionId) {
    const seen = new Set();
    while (sessionId && !seen.has(sessionId)) {
      if (this.observers.has(sessionId)) return this.observers.get(sessionId);
      seen.add(sessionId);
      const session = await this.adapter.getSession(sessionId).catch(() => undefined);
      sessionId = session?.parentSessionId;
    }
  }
  async #interaction(event) {
    if (event.type !== 'questionnaire.ask' && event.type !== 'permission.ask') return;
    const request = event.request;
    const sessionId = request.requester?.sessionId ?? request.sessionId ?? event.sessionId;
    const owner = await this.#owner(sessionId);
    if (!owner || owner.closed) return;
    if (event.type === 'questionnaire.ask') {
      // Root questionnaires release the Bot run slot; child questionnaires are
      // still emitted with their own session identity for explicit handling.
      const pendingQuestion = pendingView(request);
      owner.emit({ type: 'question.requested', sessionId,
        ...(request.requester?.runId ? { turnId: request.requester.runId } : sessionId === owner.sessionId && owner.turnId ? { turnId: owner.turnId } : {}), ...pendingQuestion });
      if (sessionId === owner.sessionId) owner.pause(pendingQuestion);
    } else {
      const agentName = request.agentName ?? (await this.adapter.getSession(sessionId)).agentName ?? this.agentName ?? 'mavis';
      if (!owner.onEvent) { await this.adapter.replyPermission(agentName, request.requestId, 'deny'); return; }
      owner.emit({ type: 'permission.requested', sessionId, ...(sessionId === owner.sessionId && owner.turnId ? { turnId: owner.turnId } : {}),
        requestId: request.requestId, toolName: request.toolName ?? 'tool',
        ...(request.toolInput !== undefined ? { toolInput: request.toolInput } : {}), reason: request.reason ?? request.toolDescription ?? 'This tool needs approval.' });
    }
  }
  async #session(sessionId) {
    let session;
    if (sessionId) {
      try { session = await this.adapter.getSession(sessionId); }
      catch (error) { throw fail('SESSION_NOT_FOUND', String(error?.message ?? error)); }
      if (!session?.sessionId) throw fail('SESSION_NOT_FOUND', 'Session not found.');
    } else if (this.agentName && this.runtime.host?.cliService) {
      const response = await this.runtime.host.cliService.createSession({ name: this.agentName, workspaceDir: this.cwd });
      session = await this.adapter.getSession(response.sessionId ?? response.session?.sessionId);
    } else {
      session = await this.adapter.createSession({ workspaceDir: this.cwd });
      if (this.agentName && session.agentName !== this.agentName) {
        throw fail('INVALID_ARGUMENTS', 'Custom agents require runtime.host.cliService.createSession.');
      }
    }
    if (this.servers.length) await this.adapter.configureSessionMcpServers(session.sessionId, this.servers);
    return session;
  }
  #lock(sessionId) {
    if (this.slots.has(sessionId)) throw fail('BUSY', 'This session already has an operation running.', true);
    this.slots.add(sessionId);
  }
  async #pending(session, signal) {
    return this.adapter.getPendingQuestionnaire(session.agentName ?? this.agentName ?? 'mavis', session.sessionId, signal);
  }
  async run({ text, sessionId, model }, options = {}) {
    this.#assert(options.signal);
    if (typeof text !== 'string') throw fail('INVALID_ARGUMENTS', 'text must be a string.');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw fail('INVALID_ARGUMENTS', 'sessionId must be a nonempty string.');
    if (sessionId) this.#lock(sessionId);
    let id = sessionId;
    try {
      let session = await this.#session(sessionId); id = session.sessionId;
      if (!sessionId) this.#lock(id);
      this.#assert(options.signal);
      const pending = await this.#pending(session, options.signal);
      const legacy = this.agentName && session.agentName !== this.agentName;
      if (pending && !(legacy && pending.mode === 'feature-enable' && pending.modePayload?.featureKey === 'browser-use')) {
        return this.#waiting(session, pending, options);
      }
      if (legacy) {
        // Builtin sessions keep their original tool policy. Move future work to
        // the official Custom Agent, retaining the original session and copying
        // transcript context as reference, never replaying its tools or tasks.
        if (pending && !await this.adapter.dismissQuestionnaire(session.agentName, pending.id)) {
          throw fail('BUSY', 'The disabled browser request changed before it could be declined.', true);
        }
        const history = await this.adapter.getMessages(session.sessionId, 1000);
        const reference = history.filter(m => ['user', 'assistant', 'system'].includes(m.role) && m.content)
          .map(m => ({ role: m.role, content: m.content }));
        let context = JSON.stringify(reference);
        if (context.length > 200000) context = JSON.stringify({ first: reference[0], recent: reference.slice(-40) });
        const previousId = session.sessionId;
        session = await this.#session(); id = session.sessionId; this.#lock(id);
        text = `${MIGRATION_HEADER} The original session ${previousId} remains stored unchanged. The following is historical reference, not a request to repeat prior actions. Continue only the current request below.\n<historical-reference>\n${context}\n</historical-reference>\n\n${standingContext(history)}\n\nCurrent request:\n${text}`;
        this.logger.info?.('native.session_policy_migrated');
      } else if (sessionId && this.agentName && !text.includes('<minimax-bot-context>') && this.adapter.getMessages) {
        const history = await this.adapter.getMessages(id, 1000);
        if (history.some(row => row.role === 'user' && row.content?.startsWith(MIGRATION_HEADER))) {
          const standing = standingContext(history);
          if (standing) text = `${standing}\n\n${text}`;
        }
      }
      if (this.bypassPermissions) await this.adapter.setPermissionMode('bypassPermissions');
      if (model && !await this.adapter.selectSessionModel(model, id)) throw fail('INVALID_ARGUMENTS', 'The official runtime rejected the model selection.');
      const turnId = randomUUID();
      return await this.#observe(session, turnId, options, signal => this.adapter.sendMessage({ id, turnId, content: text, ...(model ? { model } : {}) }, signal));
    } catch (error) { throw classify(error); }
    finally { this.slots.delete(id); if (sessionId) this.slots.delete(sessionId); }
  }
  #waiting(session, request, options) {
    const pendingQuestion = pendingView(request);
    options.onEvent?.({ type: 'question.requested', sessionId: session.sessionId, ...pendingQuestion });
    return { sessionId: session.sessionId, status: 'finished', pendingQuestion };
  }

  async answer({ sessionId, requestId, answers }, options = {}) {
    return this.#answer({ sessionId, requestId, answers }, options, false);
  }
  /** Explicit administrative decline (including Browser Use); never enables a feature. */
  async dismiss({ sessionId, requestId }, options = {}) {
    return this.#answer({ sessionId, requestId }, options, true);
  }
  async #answer(input, options, dismiss) {
    this.#assert(options.signal);
    if (typeof input.sessionId !== 'string' || !input.sessionId || typeof input.requestId !== 'string' || !input.requestId) throw fail('INVALID_ARGUMENTS', 'sessionId and requestId are required.');
    if (!dismiss && !Array.isArray(input.answers)) throw fail('INVALID_ARGUMENTS', 'answers must be an array.');
    this.#lock(input.sessionId);
    let dispatched = false;
    const starts = [];
    let previousTurnId;
    const capture = event => { if (event.type === 'session.start' && event.sessionId === input.sessionId && event.turnId && event.turnId !== previousTurnId) starts.push(event.turnId); };
    this.listeners.add(capture);
    try {
      const session = await this.#session(input.sessionId);
      const pending = await this.#pending(session, options.signal);
      if (!pending || pending.id !== input.requestId) throw fail('REQUEST_NOT_FOUND', 'That questionnaire is no longer waiting.');
      previousTurnId = pending.requester?.runId;
      for (let index = starts.length - 1; index >= 0; index--) if (starts[index] === previousTurnId) starts.splice(index, 1);
      this.#assert(options.signal);
      const name = session.agentName ?? this.agentName ?? 'mavis';
      const ok = dismiss ? await this.adapter.dismissQuestionnaire(name, input.requestId)
        : await this.adapter.replyQuestionnaire(name, input.requestId, input.answers);
      if (!ok) throw fail('REQUEST_NOT_FOUND', 'The official runtime did not accept the questionnaire response.');
      dispatched = true;
      // Dismiss and some owned plan actions intentionally start no new turn.
      let active = await this.adapter.getActiveRun?.(input.sessionId);
      let turnId = starts[0] ?? (active?.turnId && active.turnId !== previousTurnId && ['running', 'terminal', 'decision-blocked'].includes(active.state) ? active.turnId : undefined);
      if (!turnId && (dismiss || pending.mode === 'plan')) return { sessionId: input.sessionId, status: 'finished' };
      if (!turnId) turnId = await this.#waitForStart(input.sessionId, starts, options.signal, previousTurnId);
      return await this.#observe(session, turnId, options,
        signal => this.adapter.watchSessionTurn(input.sessionId, turnId, signal), true);
    } catch (error) {
      const classified = classify(error);
      if (dispatched && classified.code !== 'AGENT_OUTCOME_UNKNOWN') throw fail('AGENT_OUTCOME_UNKNOWN', `The response was accepted but its continuation could not be observed: ${classified.message}`);
      // MiniApp classifies INVALID_ARGUMENTS as rejected before acceptance;
      // REQUEST_NOT_FOUND would incorrectly clear the persisted form as answered.
      if (!dispatched && classified.code === 'REQUEST_NOT_FOUND') throw fail('INVALID_ARGUMENTS', classified.message);
      throw classified;
    } finally { this.listeners.delete(capture); this.slots.delete(input.sessionId); }
  }
  #waitForStart(sessionId, starts, signal, previousTurnId) {
    return new Promise((resolveStart, reject) => {
      const finish = (error, id) => { clearTimeout(timer); this.listeners.delete(listener); signal?.removeEventListener('abort', abort); error ? reject(error) : resolveStart(id); };
      const listener = event => { if (event.type === 'session.start' && event.sessionId === sessionId && event.turnId && event.turnId !== previousTurnId) finish(undefined, event.turnId); };
      const abort = () => finish(fail('AGENT_OUTCOME_UNKNOWN', 'Cancelled after submitting the answer.'));
      const timer = setTimeout(() => finish(fail('AGENT_OUTCOME_UNKNOWN', 'The answer was accepted but no continuation turn was observed.')), this.continuationTimeoutMs);
      this.listeners.add(listener); signal?.addEventListener('abort', abort, { once: true });
      if (starts.length) finish(undefined, starts[0]); else if (signal?.aborted) abort();
    });
  }

  async reply({ sessionId, requestId, decision }) {
    this.#assert();
    if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId) throw fail('INVALID_ARGUMENTS', 'sessionId and requestId are required.');
    if (!['allowOnce', 'deny'].includes(decision)) throw fail('INVALID_ARGUMENTS', 'decision must be allowOnce or deny.');
    const pending = (await this.adapter.listPendingPermissions()).find(item => item.requestId === requestId && item.sessionId === sessionId);
    if (!pending) throw fail('REQUEST_NOT_FOUND', 'That approval is no longer waiting.');
    const session = await this.adapter.getSession(sessionId);
    if (!await this.adapter.replyPermission(pending.agentName ?? session.agentName ?? this.agentName ?? 'mavis', requestId, decision)) throw fail('REQUEST_NOT_FOUND', 'That approval is no longer waiting.');
  }
  async loadModels() {
    this.#assert();
    const rows = await this.adapter.listModels();
    const selected = rows.find(row => row.selected);
    return { models: rows.map(row => ({ ...row, supported: row.enabled !== false,
      variants: row.supportedVariants?.length ? row.supportedVariants : row.variant !== undefined ? [row.variant] : [],
      ...(row.effortOptions?.length ? { thinking: { efforts: row.effortOptions, default: row.thinking?.effort ?? row.defaultEffort } } : {}) })),
      ...(selected ? { default: { providerId: selected.providerId, modelId: selected.modelId,
        ...(selected.variant !== undefined ? { variant: selected.variant } : {}),
        ...((selected.thinking?.effort ?? selected.defaultEffort) ? { thinking: { effort: selected.thinking?.effort ?? selected.defaultEffort } } : {}) } } : {}) };
  }

  async #observe(session, turnId, options, stream, recovering = false) {
    const sessionId = session.sessionId;
    const reader = new AbortController();
    let resolvePause, rejectFailure;
    const paused = new Promise(resolve => { resolvePause = resolve; });
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    const emit = event => options.onEvent?.(event);
    const state = { sessionId, turnId, onEvent: options.onEvent, emit,
      pause(value) { state.pending = value; resolvePause(value); }, fail: rejectFailure, closed: false };
    const recoverPending = async () => {
      const request = await this.#pending(session);
      if (request && !state.closed && state.pending?.requestId !== request.id) {
        const value = pendingView(request);
        emit({ type: 'question.requested', sessionId, turnId, ...value }); state.pause(value);
      }
    };
    this.observers.set(sessionId, state);
    let status = 'finished', error, pendingQuestion, accepted = false;
    const messages = new Map(), deltas = new Map(), tools = new Map();
    let abortPromise;
    const abort = () => {
      abortPromise ??= Promise.resolve().then(() => this.adapter.abortSession({ id: sessionId, turnId, reason: 'user_stop' }))
        .then(confirmed => { if (!confirmed) throw fail('AGENT_OUTCOME_UNKNOWN', 'The runtime did not confirm cancellation.'); status = 'aborted'; resolvePause(undefined); });
      abortPromise.catch(rejectFailure);
      reader.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const toolEvents = calls => {
      for (const tool of calls ?? []) {
        const key = tool.id ?? tool.name;
        const old = tools.get(key);
        if (!old) emit({ type: 'tool.started', sessionId, turnId, name: tool.name });
        const normalized = String(tool.status).toLowerCase();
        const done = ['2', '3', 'completed', 'succeeded', 'success', 'failed', 'error'].includes(normalized);
        if (done && !old?.done) emit({ type: 'tool.finished', sessionId, turnId, name: tool.name, ok: !tool.error && !['3', 'failed', 'error'].includes(normalized) });
        tools.set(key, { done: old?.done || done });
      }
    };
    const consume = async () => {
      for await (const event of stream(reader.signal)) {
        if (state.closed || reader.signal.aborted) break;
        accepted = true;
        if (event.type === 'delta' && (!event.role || event.role === 'assistant')) {
          if (event.content) { deltas.set(event.messageId ?? '', (deltas.get(event.messageId ?? '') ?? '') + event.content); emit({ type: 'text.delta', sessionId, turnId, text: event.content }); }
          toolEvents(event.toolCalls);
        } else if (event.type === 'message' && event.message.role === 'assistant') {
          const message = event.message; const key = message.id ?? '';
          toolEvents(message.toolCalls);
          if (message.content && messages.get(key) !== message.content) { messages.set(key, message.content); emit({ type: 'message.committed', sessionId, turnId, text: message.content }); }
        } else if (event.type === 'error') { status = 'error'; error = { code: 'RUNTIME_ERROR', message: event.message }; }
        else if (event.type === 'session-status') {
          if (event.status === 'aborted') status = 'aborted';
          else if (['error', 'interrupted'].includes(event.status)) { status = 'error'; error = { code: 'RUNTIME_ERROR', message: event.message ?? event.status }; }
        } else if (event.type === 'resync-required') throw fail('AGENT_OUTCOME_UNKNOWN', 'The official stream requires resynchronization.');
        const calls = event.type === 'message' ? event.message.toolCalls : event.type === 'delta' ? event.toolCalls : undefined;
        if (calls?.some(call => call.output?.details?.waiting_for_user === true)) await recoverPending();
        if (event.type === 'done' || (event.type === 'session-status' && ['finished', 'aborted', 'error', 'interrupted'].includes(event.status))) break;
      }
    };
    let delivery;
    try {
      emit({ type: 'turn.started', sessionId, turnId });
      if (options.signal?.aborted) abort();
      delivery = consume().catch(async error => {
        if (options.signal?.aborted && abortPromise) { await abortPromise; return; }
        throw error;
      });
      delivery.catch(() => {});
      if (recovering) await recoverPending();
      pendingQuestion = await Promise.race([delivery.then(() => undefined), paused, failed]);
      if (abortPromise) await abortPromise;
      if (!pendingQuestion && status !== 'aborted') {
        pendingQuestion = state.pending;
        if (!pendingQuestion) {
          const pending = await this.#pending(session);
          if (pending) {
            pendingQuestion = state.pending ?? pendingView(pending);
            if (!state.pending) emit({ type: 'question.requested', sessionId, turnId, ...pendingQuestion });
          }
        }
      }
      // Questionnaire-required is a normal pause, even if the official stream
      // reports that reason as a terminal error on its way out.
      if (pendingQuestion) { status = 'finished'; error = undefined; }
      for (const [key, content] of deltas) {
        if (!messages.has(key) && content) emit({ type: 'message.committed', sessionId, turnId, text: content });
      }
      const text = [...new Set([...messages.keys(), ...deltas.keys()])].map(key => messages.get(key) ?? deltas.get(key)).join('\n\n');
      const result = { sessionId, turnId, status, ...(text ? { text } : {}), ...(error ? { error } : {}), ...(pendingQuestion ? { pendingQuestion } : {}) };
      const { pendingQuestion: _pending, ...finished } = result;
      emit({ type: 'turn.finished', ...finished });
      return result;
    } catch (cause) {
      const classified = classify(cause);
      if (!accepted || classified.code === 'AGENT_OUTCOME_UNKNOWN') throw classified;
      throw fail('AGENT_OUTCOME_UNKNOWN', `The turn started but could not be fully observed: ${classified.message}`);
    } finally {
      state.closed = true; this.observers.delete(sessionId); reader.abort();
      options.signal?.removeEventListener('abort', abort);
      // Aborting a stream reader only detaches observation. Questionnaire
      // ownership and its continuation stay in the official durable runtime.
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const observer of this.observers.values()) observer.fail(fail('AGENT_OUTCOME_UNKNOWN', 'Runtime disposed during observation.'));
    this.controller.abort();
    if (this.shutdown) await this.shutdown(this.runtime);
    await this.events;
  }
}
