// @ts-check
/**
 * A minimal JSON-RPC client for one Agent Client Protocol process.
 *
 * ACP speaks newline-delimited JSON-RPC on stdio. Requests we send wait for a
 * matching response. Requests the agent sends back (permission prompts) are
 * dispatched to `onRequest` and answered with `respond`. Notifications such as
 * `session/update` go to `onNotification`.
 */

export class AcpError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
  }
}

export class AcpClient {
  /**
   * @param {{ write: (line: string) => void, onNotification?: (method: string, params: any) => void, onRequest?: (method: string, params: any) => Promise<unknown> }}
   *   handlers
   */
  constructor(handlers) {
    this.write = handlers.write;
    this.onNotification = handlers.onNotification ?? (() => {});
    this.onRequest = handlers.onRequest ?? (async () => {
      throw new AcpError('unhandled request');
    });
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
  }

  /** @param {string} chunk */
  push(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  /** @param {string} method @param {unknown} [params] */
  request(method, params) {
    if (this.closed) return Promise.reject(new AcpError('ACP connection closed', -32000));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Register before writing. A transport may answer inside write, and the
      // response would otherwise arrive before this request is waiting for it.
      this.pending.set(id, { resolve, reject });
      this.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
    });
  }

  /** @param {string} method @param {unknown} [params] */
  notify(method, params) {
    if (this.closed) return;
    this.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  /** @param {number | string} id @param {unknown} result */
  respond(id, result) {
    if (this.closed) return;
    this.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  /** @param {number | string} id @param {{ code: number, message: string }} error */
  respondError(id, error) {
    if (this.closed) return;
    this.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  }

  /** @param {string} line */
  #dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      Promise.resolve(this.onRequest(message.method, message.params ?? {}))
        .then((result) => this.respond(message.id, result ?? {}))
        .catch((error) => this.respondError(message.id, { code: -32000, message: error?.message ?? 'request failed' }));
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new AcpError(message.error.message ?? 'ACP error', message.error.code));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params ?? {});
  }
}
