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
 * }} [options]
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startMiniAppModule(init, options = {}) {
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const packageRoot = await resolveRealPath(init.packageRoot);
  const start = await loadStartFunction(init, packageRoot, resolveRealPath, options.loadModule);
  const abortController = new AbortController();
  const logger = createLogger(options.emit, init.logger);
  const context = Object.freeze({
    pluginId: init.pluginId,
    pluginRoot: packageRoot,
    dataDir: init.dataDir,
    generationId: init.processGeneration,
    listen: Object.freeze({ ...init.listen }),
    signal: abortController.signal,
    logger,
    ...(init.agent ? { agent: init.agent } : {}),
  });
  /** @type {any} */
  let result;
  try {
    result = await start(context);
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
        port: init.listen.port,
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
    stop() {
      stopPromise ??= (async () => {
        abortController.abort();
        await dispose?.();
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
