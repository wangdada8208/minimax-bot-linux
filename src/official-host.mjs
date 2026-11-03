// @ts-check
/**
 * Port of MiniMax-AI/minimax-code, `startMiniAppModule`.
 *
 * Source: packages/local-runtime-v2/src/service/miniapp/process/node-runtime/host-runner.ts
 * Upstream commit 6e062ae8. The flow, the checks and the lifecycle are kept
 * as upstream wrote them: resolve the package root, resolve the entry and
 * refuse one outside the package, refuse a module without `start`, hand the
 * plugin a frozen context, and stop by aborting a signal before awaiting
 * `dispose`.
 *
 * The only addition is `agent`. Upstream's context has no Agent because the
 * desktop app injects that from the closed host; the open-source runtime never
 * defines it. A Mini App that declares `agentAccess` (MiniMax Bot does) cannot
 * run at all without it, so the caller supplies one and it is frozen with the
 * rest of the context.
 */
import { realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Port of `HostMiniAppPortRegistry` from
 * `node-runtime/port-registry.ts`. Upstream reserves a loopback port per
 * process generation so two runtimes cannot claim the same one; reserving is
 * what makes a retry on `EADDRINUSE` meaningful instead of racy.
 */
export class HostMiniAppPortRegistry {
  /** @param {Iterable<number>} [productReserved] */
  constructor(productReserved = []) {
    this.productReserved = new Set(productReserved);
    /** @type {Map<number, { pluginId: string, processGeneration: string }>} */
    this.owners = new Map();
  }

  /** @param {{ pluginId: string, port: number }} input */
  isReserved(input) {
    return this.productReserved.has(input.port) || this.owners.has(input.port);
  }

  /**
   * @param {{ pluginId: string, port: number, processGeneration: string }} input
   * @returns {{ release(): void } | undefined}
   */
  reserve(input) {
    if (this.productReserved.has(input.port) || this.owners.has(input.port)) return undefined;
    const owner = Object.freeze({
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    });
    this.owners.set(input.port, owner);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.owners.get(input.port) === owner) this.owners.delete(input.port);
      },
    };
  }
}

/** Upstream `retryablePortError`: a busy port is worth another candidate. */
function retryablePortError(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).code === 'EADDRINUSE');
}

/**
 * Upstream readiness: after `start` resolves, the port must accept a
 * connection. `node-runtime.ts` retries until a deadline and reports
 * `READINESS_TIMEOUT`; the same rule applies here.
 * @param {{ host: string, port: number, timeoutMs: number, retryMs: number, signal?: AbortSignal }} input
 */
export async function connectMiniAppPort(input) {
  const deadline = Date.now() + input.timeoutMs;
  /** @type {unknown} */
  let lastError;
  for (;;) {
    if (input.signal?.aborted) throw input.signal.reason;
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: input.host, port: input.port });
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error);
          else resolve(undefined);
        };
        socket.once('connect', () => finish(undefined));
        socket.once('error', (error) => finish(error));
      });
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new OfficialHostError('READINESS_TIMEOUT', 'TCP readiness timed out', { cause: lastError });
    }
    await new Promise((resolve) => setTimeout(resolve, input.retryMs));
  }
}

/** Upstream `MiniAppRunnerErrorCode`; kept so the same failures read the same. */
export class OfficialHostError extends Error {
  /** @param {string} code @param {string} message @param {any} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MiniAppRunnerError';
    this.code = code;
  }
}

/**
 * Upstream `startMiniAppModule`, with an Agent added to the context.
 *
 * @param {{
 *   pluginId: string,
 *   processGeneration: string,
 *   packageRoot: string,
 *   nodeEntry: string,
 *   dataDir: string,
 *   listen: { host: '127.0.0.1', port: number },
 *   logger?: Readonly<Record<string, (message: string, fields?: Readonly<Record<string, unknown>>) => void>>,
 *   agent?: unknown,
 * }} init
 * @param {{
 *   emit?: (message: any) => void,
 *   resolveRealPath?: (target: string) => Promise<string>,
 *   loadModule?: (url: string) => Promise<unknown>,
 *   awaitReadiness?: boolean,
 *   readinessTimeoutMs?: number,
 *   readinessRetryMs?: number,
 *   registry?: HostMiniAppPortRegistry,
 * }} [options]
 * @returns {Promise<{ stop: () => Promise<void>, port: number }>}
 */
export async function startMiniAppModule(init, options = {}) {
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const packageRoot = await resolveRealPath(init.packageRoot);
  const start = await loadStartFunction(init, packageRoot, resolveRealPath, options.loadModule);
  // Upstream reserves the loopback port before spawning the runner, then turns
  // an `EADDRINUSE` into a retry on the next candidate port. Without the
  // reservation two starts can pick the same port and the loser dies late.
  const registry = options.registry ?? defaultRegistry;
  const maxAttempts = options.maxPortAttempts ?? 3;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = init.listen.port + attempt;
    const reservation = registry.reserve({
      pluginId: init.pluginId,
      port,
      processGeneration: init.processGeneration,
    });
    if (!reservation) {
      lastError ??= new OfficialHostError('NO_CANDIDATE_PORT', `Port ${port} is already reserved`);
      continue;
    }
    try {
      return await startOnPort(init, options, { packageRoot, start, port, reservation });
    } catch (error) {
      reservation.release();
      lastError = error;
      if (!retryablePortError(error) || attempt + 1 >= maxAttempts) throw error;
      init.logger?.warn?.(`port ${port} busy, trying ${port + 1}`);
    }
  }
  throw lastError ?? new OfficialHostError('NO_CANDIDATE_PORT', 'No loopback port is available');
}

/** The process-wide registry, as upstream keeps one per runtime. */
const defaultRegistry = new HostMiniAppPortRegistry();

/**
 * One start attempt on a reserved port.
 * @param {any} init @param {any} options
 * @param {{ packageRoot: string, start: (context: any) => any, port: number, reservation: { release(): void } }} attempt
 */
async function startOnPort(init, options, attempt) {
  const abortController = new AbortController();
  const logger = createLogger(options.emit, init.logger);
  const context = Object.freeze({
    pluginId: init.pluginId,
    pluginRoot: attempt.packageRoot,
    dataDir: init.dataDir,
    generationId: init.processGeneration,
    listen: Object.freeze({ ...init.listen, port: attempt.port }),
    signal: abortController.signal,
    logger,
    ...(init.agent ? { agent: init.agent } : {}),
  });
  /** @type {any} */
  let result;
  try {
    result = await attempt.start(context);
  } catch (error) {
    abortController.abort();
    throw error;
  }
  // Upstream treats a start that returns before the port accepts connections as
  // not ready; the page would otherwise be served against a dead listener.
  const dispose = readDispose(result, abortController);
  if (options.awaitReadiness !== false) {
    try {
      await connectMiniAppPort({
        host: init.listen.host,
        port: attempt.port,
        timeoutMs: options.readinessTimeoutMs ?? 10000,
        retryMs: options.readinessRetryMs ?? 100,
        signal: abortController.signal,
      });
    } catch (error) {
      abortController.abort();
      await dispose?.();
      throw error;
    }
  }
  /** @type {Promise<void> | undefined} */
  let stopPromise;
  return {
    port: attempt.port,
    stop() {
      stopPromise ??= (async () => {
        try {
          abortController.abort();
          await dispose?.();
        } finally {
          attempt.reservation.release();
        }
      })();
      return stopPromise;
    },
  };
}

/**
 * @param {any} init
 * @param {string} packageRoot
 * @param {(target: string) => Promise<string>} resolveRealPath
 * @param {((url: string) => Promise<unknown>) | undefined} loadModule
 */
async function loadStartFunction(init, packageRoot, resolveRealPath, loadModule) {
  const entryPath = await resolveRealPath(path.resolve(packageRoot, init.nodeEntry));
  if (!isInside(packageRoot, entryPath)) {
    throw new OfficialHostError(
      'ENTRY_OUTSIDE_ARTIFACT',
      'Mini App Node entry resolved outside its package artifact',
    );
  }
  const loaded = /** @type {any} */ (await (loadModule ?? ((url) => import(url)))(pathToFileURL(entryPath).href));
  if (typeof loaded.start !== 'function') {
    throw new OfficialHostError('START_EXPORT_MISSING', 'Mini App Node entry must export a named start function');
  }
  return /** @type {(context: any) => any} */ (loaded.start);
}

/**
 * @param {any} result
 * @param {AbortController} abortController
 * @returns {(() => void | Promise<void>) | undefined}
 */
function readDispose(result, abortController) {
  if (result === undefined) return undefined;
  if (!isRecord(result) || typeof result.dispose !== 'function') {
    abortController.abort();
    throw new OfficialHostError('RUNNER_LIFECYCLE_INVALID', 'Mini App start must return void or include dispose()');
  }
  return /** @type {() => void | Promise<void>} */ (result.dispose.bind(result));
}

/**
 * Upstream keeps four levels and one bound per message. A caller can pass its
 * own sink; without one the logs go nowhere, exactly as upstream.
 * @param {((message: any) => void) | undefined} emit
 * @param {Readonly<Record<string, any>> | undefined} logger
 */
function createLogger(emit, logger) {
  const MAX_LOG_MESSAGE_LENGTH = 4 * 1024;
  /** @param {'debug' | 'info' | 'warn' | 'error'} level */
  const log = (level, message, fields) => {
    const text = boundedLogMessage(message, MAX_LOG_MESSAGE_LENGTH);
    if (logger?.[level]) {
      logger[level](text, fields);
      return;
    }
    emit?.({ type: 'miniapp:log', level, message: text, fieldKeys: Object.keys(fields ?? {}) });
  };
  return Object.freeze({
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  });
}

/** @param {unknown} message @param {number} max */
function boundedLogMessage(message, max) {
  const text = String(message ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

/** @param {string} root @param {string} candidate */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
