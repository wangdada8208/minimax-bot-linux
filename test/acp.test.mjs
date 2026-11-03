import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AcpClient } from '../src/acp.mjs';

/** A client wired to in-memory streams, with a reader for what it writes. */
function harness(handlers = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const client = new AcpClient({ input: fromAgent, output: toAgent, ...handlers });
  const written = [];
  let buffer = '';
  toAgent.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) written.push(JSON.parse(line));
    }
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const reply = (message) => fromAgent.write(`${JSON.stringify(message)}\n`);
  return { client, written, reply, settle };
}

test('waits for the matching response', async () => {
  const { client, written, reply, settle } = harness();
  const pending = client.request('initialize', { protocolVersion: 1 });
  await settle();
  const sent = written.find((message) => message.method === 'initialize');
  assert.ok(sent, 'the request reached the agent');
  reply({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1 } });
  assert.deepEqual(await pending, { protocolVersion: 1 });
});

test('routes notifications to the notification handler', async () => {
  const seen = [];
  const { reply, settle } = harness({ onNotification: (method, params) => seen.push([method, params]) });
  // A custom method: the SDK type-checks built-in ones, and mcode's extension
  // notifications take this path too.
  reply({ jsonrpc: '2.0', method: 'mcode/session/queue_update', params: { sessionId: 's', items: [] } });
  await settle();
  assert.equal(seen[0]?.[0], 'mcode/session/queue_update');
  assert.equal(seen[0]?.[1].sessionId, 's');
});

test('answers an agent-initiated request through onRequest', async () => {
  const { written, reply, settle } = harness({
    onRequest: async (method, params) => ({ outcome: params.toolCall.toolCallId }),
  });
  reply({
    jsonrpc: '2.0',
    id: 7,
    method: 'session/request_permission',
    params: { toolCall: { toolCallId: 'call_1' }, options: [] },
  });
  await settle();
  const answer = written.find((message) => message.id === 7);
  assert.ok(answer, 'the client answered the agent');
  assert.equal(answer.result.outcome, 'call_1');
});

test('rejects pending work when the connection closes', async () => {
  const { client, settle } = harness();
  const pending = client.request('session/prompt', {});
  await settle();
  client.fail(new Error('gone'));
  await assert.rejects(pending);
});
