import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AcpAgent } from '../src/agent.mjs';

function fakeProcess() {
  const stdin = new EventEmitter();
  stdin.write = (line) => {
    stdin.emit('line', line);
    return true;
  };
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  stderr.setEncoding = () => {};
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};
  return child;
}

function agentWith(script) {
  const children = [];
  const configDir = mkdtempSync(join(tmpdir(), 'minimax-bot-agent-'));
  const configPath = join(configDir, 'config.yaml');
  writeFileSync(configPath, 'custom_provider:\n  magpie:\n    models:\n      group/cursor-grok-4.7-500k:\n        reasoning: true\n');
  const agent = new AcpAgent({
    command: 'mcode',
    cwd: '/workspace',
    configPath,
    spawnImpl: () => {
      const child = fakeProcess();
      children.push(child);
      script(child);
      return child;
    },
    shell: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { agent, get child() { return children.at(-1); }, children };
}

test('a prompt turn streams text and finishes with the session id', async () => {
  const events = [];
  const { agent, children } = agentWith((proc) => {
    proc.stdin.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
      } else if (message.method === 'session/new') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_1' } })}\n`);
      } else if (message.method === 'session/set_config_option') {
        assert.equal(message.params.configId, 'model');
        assert.equal(message.params.value, 'm:custom_provider%3Amagpie:group%2Fcursor-opus-5:v:thinking');
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      } else if (message.method === 'session/prompt') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } })}\n`);
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`);
      }
    });
  });
  const result = await agent.run({ text: 'hi', model: { providerId: 'custom_provider:magpie', modelId: 'group/cursor-opus-5', thinking: { effort: 'high' } } }, { onEvent: (event) => events.push(event.type) });
  assert.equal(result.sessionId, 'sess_1');
  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(events, ['turn.started', 'text.delta', 'message.committed', 'turn.finished']);
  assert.equal(children.length, 2);
  children.at(-1).emit('exit', 0);
});

test('a login refusal is reported as not permitted instead of a temporary outage', async () => {
  const { agent } = agentWith((proc) => {
    proc.stdin.on('line', (line) => {
      const message = JSON.parse(line);
      const result = message.method === 'initialize'
        ? { protocolVersion: 1 }
        : undefined;
      if (result) proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      else if (message.method === 'session/new') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required: Run `mcode login` and try again.' } })}\n`);
      }
    });
  });
  await assert.rejects(agent.run({ text: 'hi' }), (error) => {
    assert.equal(error.code, 'NOT_PERMITTED');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('an approval maps allowOnce onto the ACP allow-once option', async () => {
  let allowed = false;
  const { agent } = agentWith((proc) => {
    proc.stdin.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
      } else if (message.method === 'session/new') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_2' } })}\n`);
      } else if (message.method === 'session/set_config_option') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      } else if (message.method === 'session/prompt') {
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'session/request_permission', params: { sessionId: 'sess_2', toolCall: { toolCallId: 'call_9', title: 'Run tests', name: 'shell' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } })}\n`);
        proc.promptId = message.id;
      } else if (message.id === 90) {
        allowed = message.result.outcome.optionId === 'allow-once';
        proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: proc.promptId, result: { stopReason: 'end_turn' } })}\n`);
      }
    });
  });
  const result = await agent.run({ text: 'run tests' }, {
    onEvent(event) {
      if (event.type === 'permission.requested') {
        assert.equal(event.toolName, 'shell');
        void agent.reply({ sessionId: event.sessionId, requestId: event.requestId, decision: 'allowOnce' });
      }
    },
  });
  assert.equal(result.status, 'finished');
  assert.equal(allowed, true);
});
