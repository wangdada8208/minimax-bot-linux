// @ts-check
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpClient, AcpError } from './acp.mjs';
import { acpModelValue, catalogFromModels, ensureConfiguredModel } from './models.mjs';

/**
 * The object MiniMax Bot expects as `context.agent`.
 *
 * One `mcode acp` process owns every Bot session. `run` maps to `session/prompt`,
 * `reply` answers a waiting `session/request_permission`, and `answer` continues
 * the same session with the questionnaire written out as text. ACP has no
 * questionnaire object, so a question ends the turn as finished text rather than
 * `pendingQuestion`.
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
   *   configPath?: string,
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
    this.configPath = options.configPath ?? join(homedir(), '.minimax/config.yaml');
    // How long mcode may keep a cancelled turn alive before the next prompt.
    this.settleMs = options.settleMs ?? 60_000;
    this.configuredModels = new Set();
    /** Sessions whose turn was cancelled and is still settling inside mcode. */
    this.settling = new Set();
    this.logger = options.logger ?? console;
    this.client = /** @type {AcpClient | undefined} */ (undefined);
    this.child = /** @type {import('node:child_process').ChildProcess | undefined} */ (undefined);
    this.ready = /** @type {Promise<void> | undefined} */ (undefined);
    // Named `availableModels`: a class field named `models` would shadow the
    // `models()` method the plugin probes for.
    this.availableModels = /** @type {any[] | undefined} */ (undefined);
    /** @type {Map<string, { sessionId: string, resolve: (value: any) => void, turnId: string, text: string, message: string, tools: Map<string, string>, emit: (event: any) => void, signal: AbortSignal }>} */
    this.turns = new Map();
    /** @type {Map<string, { sessionId: string, resolve: (value: any) => void }>} */
    this.permissions = new Map();
    this.disposed = false;
  }

  start() {
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
      for (const [id, permission] of this.permissions) {
        permission.resolve({ outcome: { outcome: 'cancelled' } });
        this.permissions.delete(id);
      }
    });
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'minimax-bot-linux', title: 'MiniMax Bot Linux', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.capabilities = initialized?.agentCapabilities ?? {};
    this.availableModels = initialized?.models?.availableModels;
    client.notify('initialized', {});
    this.logger.info('acp.ready', { protocol: initialized?.protocolVersion });
  }

  /** @param {string} method @param {any} params */
  #onNotification(method, params) {
    if (method !== 'session/update') return;
    const turn = this.turns.get(params.sessionId);
    if (!turn) return;
    const update = params.update ?? {};
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
    if (method !== 'session/request_permission') {
      throw new AcpError(`unsupported ACP request: ${method}`);
    }
    const turn = this.turns.get(params.sessionId);
    if (!turn) return { outcome: { outcome: 'cancelled' } };
    const tool = params.toolCall ?? {};
    const requestId = `perm_${tool.toolCallId ?? Date.now()}`;
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
    // A follow-up that arrives while the session is mid-turn is queued on the
    // session instead of rejected. mcode answers a second prompt with
    // "Session already has an active Turn. Use queue send to deliver the
    // message after it." — the cancelled turn is still settling at that point —
    // so the queued text continues the session as the plugin's next turn and
    // the user's adjustment is not lost.
    // A cancelled turn keeps the session busy inside mcode for a moment, and a
    // prompt sent during that window is refused with "Session already has an
    // active Turn". Wait for the session to go idle instead of failing the
    // follow-up, so the user's adjustment still runs as the next turn.
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
      if (!this.turns.has(sessionId) && !this.settling.has(sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * The model catalog behind the Bot settings picker. It comes from the
   * configured OpenAI-compatible endpoint; the CLI at the pinned version does
   * not implement `providers/list`, so this is a host duty, not a port.
   * @returns {Promise<{ models: any[], default?: { providerId: string, modelId: string } }>}
   */
  async loadModels() {
    if (!this.catalogUrl) return { models: [] };
    const response = await this.fetchImpl(this.catalogUrl, {
      headers: this.catalogApiKey ? { authorization: `Bearer ${this.catalogApiKey}` } : {},
    });
    if (!response.ok) throw new AgentError('AGENT_UNAVAILABLE', `Model catalog returned ${response.status}.`, true);
    return catalogFromModels(await response.json());
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
    // Advertise before opening the session. Loading a new model restarts ACP,
    // and a session opened by the old process would not survive that restart.
    await this.#advertise(model);
    const client = this.client;
    if (!client) throw UNAVAILABLE();
    let created = false;
    try {
      if (!sessionId) {
        const createdSession = await client.request('session/new', { cwd: this.cwd, mcpServers: this.#mcpServers() });
        sessionId = String(createdSession.sessionId);
        created = true;
      } else if (this.capabilities?.sessionCapabilities?.resume) {
        await client.request('session/resume', { sessionId, cwd: this.cwd, mcpServers: this.#mcpServers() });
      }
    } catch (error) {
      throw classify(error, created ? undefined : sessionId);
    }
    const id = /** @type {string} */ (sessionId);
    // run() already queues a follow-up when this session is mid-turn; reaching
    // this point means that queue call failed, so report the session as busy.
    if (this.turns.has(id)) {
      throw new AgentError('BUSY', 'This session already has a turn running.', true);
    }
    // The operator asked every Bot to run with full tool access. This session
    // works only inside the configured workspace, so routine file and command
    // approvals are not shown one by one.
    try {
      await client.request('session/set_config_option', { sessionId: id, configId: 'permissionMode', value: 'bypassPermissions' });
    } catch (error) {
      this.logger.warn(`acp.permission_mode ${error?.message ?? 'unavailable'}`);
    }
    const modelValue = acpModelValue(model ?? {});
    if (modelValue) {
      try {
        await client.request('session/set_config_option', { sessionId: id, configId: 'model', value: modelValue });
      } catch (error) {
        throw error instanceof AgentError
          ? error
          : new AgentError('INVALID_ARGUMENTS', error?.message ?? 'The selected model is not available.', false);
      }
    }
    const turnId = `turn_${Date.now().toString(36)}`;
    let stopReason = 'end_turn';
    const done = new Promise((resolve, reject) => {
      const turn = {
        sessionId: id,
        turnId,
        text: '',
        message: '',
        tools: new Map(),
        signal: options.signal ?? new AbortController().signal,
        emit: (event) => options.onEvent?.(event),
        resolve,
        reject,
      };
      this.turns.set(id, turn);
      turn.emit({ type: 'turn.started', sessionId: id, turnId });
      // The plugin aborts this turn as soon as the user sends a follow-up, so the
      // abort is the only moment the running turn can still be adjusted. Give the
      // follow-up a short head start to steer that turn; if nothing arrives, end
      // the turn the normal way so the plugin can open a new one.
      const onAbort = () => {
        this.settling.add(id);
        setTimeout(() => this.settling.delete(id), this.settleMs);
        client.notify('session/cancel', { sessionId: id });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#promptWhenIdle(client, id, text, options.signal).then((result) => {
        stopReason = result?.stopReason ?? 'end_turn';
        resolve(undefined);
      }).catch(reject).finally(() => options.signal?.removeEventListener('abort', onAbort));
    });
    try {
      await done;
    } catch (error) {
      this.turns.delete(id);
      if (options.signal?.aborted) throw new AgentError('AGENT_OUTCOME_UNKNOWN', 'The turn was cancelled after it started.', false);
      throw classify(error);
    }
    const turn = this.turns.get(id);
    this.turns.delete(id);
    this.settling.delete(id);
    const status = stopReason === 'cancelled' ? 'aborted' : stopReason === 'end_turn' ? 'finished' : 'error';
    const textOut = turn?.text ?? '';
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
    return { sessionId: id, turnId, status, ...(textOut ? { text: textOut } : {}), ...(event.error ? { error: event.error } : {}) };
  }

  /** @param {any} model */
  async #advertise(model) {
    const modelId = typeof model?.modelId === 'string' ? model.modelId : '';
    if (!modelId || this.configuredModels.has(modelId)) return;
    let added = false;
    try {
      added = ensureConfiguredModel(this.configPath, model);
    } catch (error) {
      throw new AgentError('INVALID_ARGUMENTS', error?.message ?? 'The selected model could not be saved.', false);
    }
    this.configuredModels.add(modelId);
    if (!added || !this.child) return;
    // A running ACP process keeps the model list it read at startup.
    const child = this.child;
    const client = this.client;
    this.child = undefined;
    this.client = undefined;
    this.ready = undefined;
    client?.fail(new Error('MiniMax Code ACP is restarting to load a model.'));
    child.kill('SIGTERM');
    await this.start();
  }

  #mcpServers() {
    return [];
  }

  async dispose() {
    this.disposed = true;
    for (const id of [...this.turns.keys()]) this.client?.notify('session/cancel', { sessionId: id });
    this.child?.kill('SIGTERM');
    this.client?.fail(UNAVAILABLE());
  }
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}\u2026` : value;
}
