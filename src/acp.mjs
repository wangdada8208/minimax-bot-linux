// @ts-check
/**
 * ACP client built on the official SDK.
 *
 * Upstream `minimax-code` speaks ACP through `@agentclientprotocol/sdk`
 * (packages/tui/src/acp/stdio.ts), so this host uses the same library instead
 * of a hand-written JSON-RPC loop. The public surface stays the small one the
 * rest of the host already uses: `request`, `notify`, and the two handlers for
 * notifications and agent-initiated requests.
 */
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export class AcpError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
  }
}

/** Custom methods mcode adds on top of ACP. */
export const EXTENSIONS = Object.freeze({
  steer: 'mcode/session/steer',
  queueEnqueue: 'mcode/session/queue/enqueue',
  queueList: 'mcode/session/queue/list',
});

export class AcpClient {
  /**
   * @param {{
   *   input: Readable,
   *   output: Writable,
   *   onNotification?: (method: string, params: any) => void,
   *   onRequest?: (method: string, params: any) => Promise<unknown>,
   *   clientInfo?: { name: string, version: string },
   * }} handlers
   */
  constructor(handlers) {
    this.onNotification = handlers.onNotification ?? (() => {});
    this.onRequest = handlers.onRequest ?? (async () => {
      throw new AcpError('unhandled request');
    });
    this.app = acp.client({
      name: handlers.clientInfo?.name ?? 'minimax-bot-linux',
      version: handlers.clientInfo?.version ?? '0.1.0',
    });
    this.app.onRequest('*', async (ctx) => this.onRequest(ctx.method, ctx.params));
    this.app.onNotification('*', (ctx) => {
      this.onNotification(ctx.method, ctx.params);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(handlers.output),
      Readable.toWeb(handlers.input),
    );
    this.connection = this.app.connect(stream);
    this.context = this.connection.agent;
    this.closed = false;
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  request(method, params) {
    if (this.closed) return Promise.reject(new AcpError('ACP connection closed'));
    return /** @type {Promise<any>} */ (this.context.request(method, params ?? {}));
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    if (this.closed) return Promise.resolve();
    return /** @type {Promise<any>} */ (this.context.notify(method, params ?? {}));
  }

  /** Closes the connection and rejects anything still pending. */
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.connection.close(error);
  }

  /** Resolves when the connection ends. */
  get closedPromise() {
    return this.connection.closed;
  }
}
