import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpClient } from '../src/acp.mjs';

test('matches responses to requests and separates notifications', async () => {
  const lines = [];
  const notes = [];
  const client = new AcpClient({
    write: (line) => lines.push(line),
    onNotification: (method, params) => notes.push([method, params]),
  });
  const pending = client.request('initialize', { protocolVersion: 1 });
  client.push('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s"}}\n');
  client.push('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
  assert.deepEqual(await pending, { protocolVersion: 1 });
  assert.deepEqual(notes, [['session/update', { sessionId: 's' }]]);
  assert.equal(JSON.parse(lines[0]).method, 'initialize');
});

test('answers an agent request through onRequest', async () => {
  const lines = [];
  const client = new AcpClient({
    write: (line) => lines.push(line),
    onRequest: async (method, params) => ({ outcome: params.toolCall.toolCallId }),
  });
  client.push('{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"call_1"}}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  const answer = JSON.parse(lines[0]);
  assert.equal(answer.id, 7);
  assert.equal(answer.result.outcome, 'call_1');
});

test('rejects every waiter when the connection fails', async () => {
  const client = new AcpClient({ write: () => {} });
  const pending = client.request('session/prompt', {});
  client.fail(new Error('gone'));
  await assert.rejects(pending, /gone/);
});
