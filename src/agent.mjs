// @ts-check
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AcpClient, AcpError } from './acp.mjs';
import { acpModelValue, catalogFromModels, catalogFromControls, selectOptions } from './models.mjs';

/**
 * The object MiniMax Bot expects as `context.agent`.
 *
 * One `mcode acp` process owns every Bot session. `run` maps to `session/prompt`,
 * `reply` answers permission requests. `answer` completes an official ACP form
 * elicitation and observes the continuation of the original ACP prompt.
 */

export class AgentError extends Error {
  /** @param {import('./types').AgentErrorCode} code @param {string} message @param {boolean} retryable */
  constructor(code, message, retryable) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

const UNAVAILABLE = () => new AgentError('AGENT_UNAVAILABLE', 'MiniMax Code ACP is not running.', true);

/** Login and argument failures will not succeed by retrying the same turn. */
function classify(error, missingSession) {
  if (error instanceof AgentError) return error;
  const message = String(error?.message ?? 'MiniMax Code ACP failed.');
  if (missingSession) return new AgentError('SESSION_NOT_FOUND', message, false);
  if (/authentication required|mcode login|not signed in/i.test(message)) {
    return new AgentError('NOT_PERMITTED', message, false);
  }
  return new AgentError('AGENT_UNAVAILABLE', message, true);
}

export class AcpAgent {
  /**
   * @param {{
   *   command: string,
   *   args?: string[],
   *   cwd: string,
   *   env?: NodeJS.ProcessEnv,
   *   spawnImpl?: typeof spawn,
   *   logger?: { info: Function, warn: Function, error: Function },
   *   modelsUrl?: string,
   *   modelsApiKey?: string,
   *   fetchImpl?: typeof fetch,
   *   shell?: boolean,
   *   settleMs?: number,
   *   mcpUrl?: string,
   *   mcpToken?: string,
   * }}
   */
  constructor(options) {
    this.command = options.command;
    this.args = options.args ?? ['acp'];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.shell = options.shell ?? false;
    this.catalogUrl = options.modelsUrl ?? '';
    this.catalogApiKey = options.modelsApiKey ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    // How long mcode may keep a cancelled turn alive before the next prompt.
    this.settleMs = options.settleMs ?? 60_000;
    this.mcpUrl = options.mcpUrl ?? '';
    this.mcpToken = options.mcpToken ?? '';
    this.sessionControls = new Map();
    this.questions = new Map();
    this.preparing = new Set();
    /** Sessions whose turn was cancelled and is still settling inside mcode. */
    this.settling = new Set();
    this.logger = options.logger ?? console;
    this.client = /** @type {AcpClient | undefined} */ (undefined);
    this.child = /** @type {import('node:child_process').ChildProcess | undefined} */ (undefined);
    this.ready = /** @type {Promise<void> | undefined} */ (undefined);
    /** @type {Map<string, { sessionId: string, resolve: (value: any) => void, turnId: string, text: string, message: string, tools: Map<string, string>, emit: (event: any) => void, signal: AbortSignal }>} */
    this.turns = new Map();
    /** @type {Map<string, { sessionId: string, resolve: (value: any) => void }>} */
    this.permissions = new Map();
    this.disposed = false;
  }

  start() {
    if (this.disposed) return Promise.reject(UNAVAILABLE());
    if (this.ready) return this.ready;
    this.ready = this.#start();
    return this.ready;
  }

  async #start() {
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // mcode is installed as an npm shim with its own shebang. A direct
      // spawn fails with ENOENT when that interpreter is not on PATH.
      shell: this.shell,
    });
    this.child = child;
    if (!child.stdin || !child.stdout) throw UNAVAILABLE();
    // The official SDK owns the JSON-RPC framing; it reads and writes the
    // child's stdio directly.
    const client = new AcpClient({
      input: child.stdout,
      output: child.stdin,
      clientInfo: { name: 'minimax-bot-linux', version: '0.1.0' },
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
    });
    this.client = client;
    child.on('error', (error) => {
      this.ready = undefined;
      client.fail(new AgentError('AGENT_UNAVAILABLE', `MiniMax Code ACP failed to start: ${error.message}`, true));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logger.info('acp.stderr', { text: text.slice(0, 2000) });
    });
    child.on('exit', (code) => {
      this.ready = undefined;
      client.fail(new AgentError('AGENT_UNAVAILABLE', `MiniMax Code ACP exited (${code ?? 'signal'}).`, true));
      for (const pending of this.questions.values()) pending.resolve({ action: 'cancel' });
      this.questions.clear();
      this.sessionControls.clear();
      for (const [id, permission] of this.permissions) {
        permission.resolve({ outcome: { outcome: 'cancelled' } });
        this.permissions.delete(id);
      }
    });
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'minimax-bot-linux', title: 'MiniMax Bot Linux', version: '0.1.0' },
      clientCapabilities: { elicitation: { form: {} }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.capabilities = initialized?.agentCapabilities ?? {};
    client.notify('initialized', {});
    this.logger.info('acp.ready', { protocol: initialized?.protocolVersion });
  }

  /** @param {string} method @param {any} params */
  #onNotification(method, params) {
    if (method !== 'session/update') return;
    const update = params.update ?? {};
    if (update.sessionUpdate === 'config_option_update') this.sessionControls.set(params.sessionId, update.configOptions ?? []);
    const turn = this.turns.get(params.sessionId);
    if (!turn) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = String(update.content.text ?? '');
      if (!text) return;
      turn.message += text;
      turn.text += text;
      turn.emit({ type: 'text.delta', sessionId: turn.sessionId, turnId: turn.turnId, text });
    } else if (update.sessionUpdate === 'tool_call') {
      const name = String(update.name || update.title || 'tool');
      turn.tools.set(String(update.toolCallId), name);
      turn.emit({ type: 'tool.started', sessionId: turn.sessionId, turnId: turn.turnId, name });
    } else if (update.sessionUpdate === 'tool_call_update') {
      const name = turn.tools.get(String(update.toolCallId)) ?? 'tool';
      const status = String(update.status ?? '');
      if (status === 'completed' || status === 'failed') {
        turn.emit({ type: 'tool.finished', sessionId: turn.sessionId, turnId: turn.turnId, name, ok: status === 'completed' });
      }
    }
  }

  /** @param {string} method @param {any} params */
  async #onRequest(method, params) {
    if (method === 'elicitation/create') return this.#elicit(params);
    if (method !== 'session/request_permission') {
      throw new AcpError(`unsupported ACP request: ${method}`);
    }
    const turn = this.turns.get(params.sessionId);
    if (!turn) return { outcome: { outcome: 'cancelled' } };
    const tool = params.toolCall ?? {};
    const requestId = `perm_${randomUUID()}`;
    const option = (kind) => (params.options ?? []).find((item) => item.kind === kind);
    const allow = option('allow_once');
    const deny = option('reject_once') ?? option('reject_always');
    const decision = await new Promise((resolve) => {
      // Register before telling the page. Its handler may answer inline, and the
      // decision would otherwise arrive before this request is waiting for it.
      this.permissions.set(requestId, { sessionId: turn.sessionId, resolve, allow: allow?.optionId, deny: deny?.optionId });
      turn.emit({
        type: 'permission.requested',
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        requestId,
        toolName: String(tool.name || tool.title || 'tool'),
        toolInput: clip(JSON.stringify(tool.rawInput ?? tool.content ?? ''), 1500),
        reason: String(tool.title || tool.name || 'This tool needs approval.'),
      });
      const cancel = () => {
        if (!this.permissions.has(requestId)) return;
        this.permissions.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      };
      if (turn.signal.aborted) cancel();
      else turn.signal.addEventListener('abort', cancel, { once: true });
    });
    return decision;
  }

  /**
   * @param {{ text: string, sessionId?: string, model?: any }} input
   * @param {{ signal?: AbortSignal, onEvent?: (event: any) => void }} [options]
   */
  async run(input, options = {}) {
    const text = String(input.text ?? '');
    // Wait for cancelled prompts to settle before sending a follow-up.
    if (input.sessionId && this.questions.has(String(input.sessionId))) throw new AgentError('BUSY', 'Answer the pending questionnaire before starting another turn.', true);
    if (input.sessionId) await this.#waitIdle(String(input.sessionId), options.signal);
    return this.#turn(input.sessionId, text, options, input.model);
  }

  /**
   * Sends one prompt, retrying while mcode still considers the previous,
   * cancelled turn active. Any other failure is returned as it is.
   * @param {AcpClient} client
   * @param {string} sessionId
   * @param {string} text
   * @param {AbortSignal | undefined} signal
   */
  async #promptWhenIdle(client, sessionId, text, signal) {
    const deadline = Date.now() + this.settleMs;
    for (;;) {
      try {
        return await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      } catch (error) {
        const message = String(error?.message ?? '');
        if (!/active Turn|already active/i.test(message) || Date.now() >= deadline || signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  /**
   * Waits until mcode reports the session idle. mcode keeps a cancelled turn
   * alive briefly and refuses a new prompt until it settles; it reports that
   * refusal synchronously, so the caller simply waits out the window.
   * @param {string} sessionId
   * @param {AbortSignal | undefined} signal
   */
  async #waitIdle(sessionId, signal) {
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      if (!this.turns.has(sessionId) && !this.settling.has(sessionId) && !this.preparing.has(sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Retains endpoint discovery while ACP controls determine selectable models. */
  async loadModels() {
    await this.start();
    const session = await this.client.request('session/new', { cwd: this.cwd, mcpServers: this.#mcpServers() });
    this.sessionControls.set(session.sessionId, session.configOptions ?? []);
    if (!this.catalogUrl) return catalogFromControls(session.configOptions);
    const response = await this.fetchImpl(this.catalogUrl, {
      headers: this.catalogApiKey ? { authorization: `Bearer ${this.catalogApiKey}` } : {},
    });
    if (!response.ok) throw new AgentError('AGENT_UNAVAILABLE', `Model catalog returned ${response.status}.`, true);
    return catalogFromModels(await response.json(), session.configOptions);
  }

  /** @param {{ sessionId: string, requestId: string, decision: 'allowOnce' | 'deny' }} input */
  async reply(input) {
    const pending = this.permissions.get(input.requestId);
    if (!pending || pending.sessionId !== input.sessionId) {
      throw new AgentError('REQUEST_NOT_FOUND', 'That approval is no longer waiting.', false);
    }
    this.permissions.delete(input.requestId);
    const optionId = input.decision === 'allowOnce' ? pending.allow : pending.deny;
    pending.resolve(optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  /** @param {string | undefined} sessionId @param {string} text @param {{ signal?: AbortSignal, onEvent?: (event: any) => void }} options @param {any} [model] */
  async #turn(sessionId, text, options, model) {
    if (options.signal?.aborted) throw new AgentError('REQUEST_CANCELLED', 'Cancelled before the turn started.', false);
    try {
      await this.start();
    } catch (error) {
      throw error instanceof AgentError ? error : new AgentError('AGENT_UNAVAILABLE', error?.message ?? 'MiniMax Code ACP is not running.', true);
    }
    const client = this.client;
    if (!client) throw UNAVAILABLE();
    let created = false;
    if (sessionId) {
      if (this.turns.has(sessionId) || this.preparing.has(sessionId) || this.questions.has(sessionId)) throw new AgentError('BUSY', 'This session already has a turn running.', true);
      this.preparing.add(sessionId);
    }
    try {
      if (!sessionId) {
        const createdSession = await client.request('session/new', { cwd: this.cwd, mcpServers: this.#mcpServers() });
        sessionId = String(createdSession.sessionId);
        this.sessionControls.set(sessionId, createdSession.configOptions ?? []);
        created = true;
      } else if (this.capabilities?.sessionCapabilities?.resume) {
        const resumed = await client.request('session/resume', { sessionId, cwd: this.cwd, mcpServers: this.#mcpServers() });
        this.sessionControls.set(sessionId, resumed.configOptions ?? []);
      }
    } catch (error) {
      this.preparing.delete(sessionId);
      throw classify(error, created ? undefined : sessionId);
    }
    const id = /** @type {string} */ (sessionId);
    if (this.turns.has(id) || this.questions.has(id)) {
      throw new AgentError('BUSY', 'This session already has a turn running.', true);
    }
    this.preparing.add(id);
    try {
      let controls = this.sessionControls.get(id) ?? [];
      const permission = controls.find((item) => item.id === 'permissionMode');
      if (selectOptions(permission).some(({ value }) => value === 'bypassPermissions') && permission.currentValue !== 'bypassPermissions') {
        const result = await client.request('session/set_config_option', { sessionId: id, configId: 'permissionMode', value: 'bypassPermissions' });
        if (result.configOptions) controls = result.configOptions;
      }
      const value = acpModelValue(model, controls);
      if (value) {
        const result = await client.request('session/set_config_option', { sessionId: id, configId: 'model', value });
        if (result.configOptions) controls = result.configOptions;
      }
      const effort = model?.thinking?.effort;
      if (effort !== undefined) {
        const control = controls.find((item) => item.id === 'thinkingEffort');
        if (!selectOptions(control).some(({ value }) => value === effort)) throw new Error('The selected thinking effort is not advertised for this model.');
        const result = await client.request('session/set_config_option', { sessionId: id, configId: 'thinkingEffort', value: effort });
        if (result.configOptions) controls = result.configOptions;
      }
      this.sessionControls.set(id, controls);
      return await this.#observe(id, options, () => this.#promptWhenIdle(client, id, text, options.signal));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('INVALID_ARGUMENTS', error?.message ?? 'Invalid session controls.', false);
    } finally {
      this.preparing.delete(id);
    }
  }

  async #observe(id, options, startPrompt) {
    const client = this.client;
    const turnId = `turn_${randomUUID()}`;
    let pause;
    const paused = new Promise((resolve) => { pause = resolve; });
    const turn = { sessionId: id, turnId, text: '', message: '', tools: new Map(),
      signal: options.signal ?? new AbortController().signal, emit: (event) => options.onEvent?.(event), pause };
    this.turns.set(id, turn);
    turn.emit({ type: 'turn.started', sessionId: id, turnId });
    const onAbort = () => {
      const question = this.questions.get(id);
      if (question) { this.questions.delete(id); question.resolve({ action: 'cancel' }); }
      client.notify('session/cancel', { sessionId: id });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const prompt = Promise.resolve().then(startPrompt);
    // A paused prompt remains pending across answer(), with rejection observed.
    prompt.catch(() => {
      const question = this.questions.get(id);
      if (question?.prompt === prompt) {
        this.questions.delete(id);
        question.resolve({ action: 'cancel' });
      }
    });
    let result;
    try {
      result = await Promise.race([prompt, paused]);
    } catch (error) {
      throw options.signal?.aborted ? new AgentError('AGENT_OUTCOME_UNKNOWN', 'The turn was cancelled after it started.', false) : classify(error);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.turns.delete(id);
      this.settling.delete(id);
    }
    const pending = this.questions.get(id);
    if (pending && result?.pendingQuestion) pending.prompt = prompt;
    const stopReason = result?.stopReason ?? 'end_turn';
    const status = stopReason === 'cancelled' ? 'aborted' : stopReason === 'end_turn' ? 'finished' : 'error';
    const textOut = turn?.text ?? '';
    const pendingQuestion = result?.pendingQuestion;
    if (turn?.message) {
      turn.emit({ type: 'message.committed', sessionId: id, turnId, text: turn.message });
    }
    const event = {
      type: 'turn.finished',
      sessionId: id,
      turnId,
      status,
      ...(textOut ? { text: textOut } : {}),
      ...(status === 'error' ? { error: { code: stopReason, message: `The Agent stopped: ${stopReason}.` } } : {}),
    };
    turn?.emit(event);
    return { sessionId: id, turnId, status, ...(textOut ? { text: textOut } : {}), ...(event.error ? { error: event.error } : {}), ...(pendingQuestion ? { pendingQuestion } : {}) };
  }

  // Official interactions.ts emits form fields only; questionnaire mode/payload
  // and original runtime request ID are not part of the ACP wire projection.
  async #elicit(params) {
    const turn = this.turns.get(params.sessionId);
    if (!turn || params.mode !== 'form' || this.questions.has(params.sessionId)) return { action: 'cancel' };
    const properties = params.requestedSchema?.properties ?? {};
    const otherFields = new Map();
    for (const [id, field] of Object.entries(properties)) {
      if (!(field.oneOf || field.items?.anyOf)) continue;
      const other = Object.entries(properties).find(([key, candidate]) => key.startsWith(`${id}__other`) && /^_*$/.test(key.slice(`${id}__other`.length)) && candidate.title === `${field.title} — Other` && candidate.type === 'string');
      if (other) otherFields.set(id, other[0]);
    }
    const requestId = `question_${randomUUID()}`;
    const request = { schemaVersion: 2, id: requestId, title: params.message,
      steps: Object.entries(properties).filter(([id]) => ![...otherFields.values()].includes(id)).map(([id, field]) => ({ id, question: field.title ?? id,
        description: field.description, selectionMode: field.type === 'array' ? 'multiple' : 'single',
        options: (field.oneOf ?? field.items?.anyOf ?? []).map((option) => ({ id: option.const, label: option.title ?? option.const, description: option.description })),
        allowOther: true })) };
    const pendingQuestion = { requestId, mode: 'questionnaire', request };
    return new Promise((resolve) => {
      this.questions.set(params.sessionId, { resolve, properties, otherFields, required: params.requestedSchema?.required ?? [], requestId });
      turn.emit({ type: 'question.requested', sessionId: params.sessionId, turnId: turn.turnId, ...pendingQuestion });
      turn.pause({ pendingQuestion });
    });
  }

  async answer(input, options = {}) {
    if (this.turns.has(input.sessionId) || this.preparing.has(input.sessionId)) throw new AgentError('BUSY', 'Wait for the paused run to resolve before answering.', true);
    const pending = this.questions.get(input.sessionId);
    if (!pending || pending.requestId !== input.requestId) throw new AgentError('REQUEST_NOT_FOUND', 'That questionnaire is no longer waiting.', false);
    if (options.signal?.aborted) throw new AgentError('REQUEST_CANCELLED', 'Cancelled before answering.', false);
    const content = Object.create(null);
    const seen = new Set();
    for (const answer of input.answers ?? []) {
      const field = pending.properties[answer.stepId];
      if (!field || seen.has(answer.stepId)) throw new AgentError('INVALID_ARGUMENTS', 'Unknown or duplicate questionnaire field.', false);
      seen.add(answer.stepId);
      if (answer.skipped) continue;
      const choices = answer.selectedOptionIds ?? [];
      const allowed = (field.oneOf ?? field.items?.anyOf ?? []).map((option) => option.const);
      if (choices.some((id) => !allowed.includes(id)) || (field.type !== 'array' && choices.length > 1)) throw new AgentError('INVALID_ARGUMENTS', 'Invalid questionnaire option.', false);
      if (answer.selectedOther) {
        const otherId = pending.otherFields.get(answer.stepId);
        if ((!otherId && (allowed.length || field.type !== 'string')) || typeof answer.otherText !== 'string') throw new AgentError('INVALID_ARGUMENTS', 'This official form does not accept Other for this field.', false);
        content[otherId ?? answer.stepId] = answer.otherText;
        if (field.type === 'array') content[answer.stepId] = choices;
      } else if (field.type === 'array') content[answer.stepId] = choices;
      else if (choices.length) content[answer.stepId] = choices[0];
    }
    if (pending.required.some((id) => content[id] === undefined)) throw new AgentError('INVALID_ARGUMENTS', 'A required questionnaire field is missing.', false);
    this.questions.delete(input.sessionId);
    return this.#observe(input.sessionId, options, () => {
      pending.resolve({ action: 'accept', content });
      return pending.prompt;
    }).catch((error) => {
      throw new AgentError('AGENT_OUTCOME_UNKNOWN', `The answer was sent but its continuation could not be observed: ${error.message}`, false);
    });
  }

  /**
   * The plugin publishes its team tools — list_team, message_bot,
   * dispatch_tasks and the rest — as an HTTP MCP endpoint declared in its
   * manifest (`mcpEndpoints`). Without registering it here the Bots have no
   * team tools at all: they can be seen on the page but not addressed.
   */
  #mcpServers() {
    if (!this.mcpUrl) return [];
    return [
      {
        name: 'minimax-bot',
        type: 'http',
        url: this.mcpUrl,
        // ACP's wire contract uses name/value pairs; the official Agent
        // converts these to its internal HTTP header object.
        headers: this.mcpToken ? [{ name: 'Authorization', value: `Bearer ${this.mcpToken}` }] : [],
      },
    ];
  }

  async dispose() {
    this.disposed = true;
    for (const pending of this.questions.values()) pending.resolve({ action: 'cancel' });
    this.questions.clear();
    for (const id of [...this.turns.keys()]) this.client?.notify('session/cancel', { sessionId: id });
    this.child?.kill('SIGTERM');
    this.client?.fail(UNAVAILABLE());
  }
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}\u2026` : value;
}
