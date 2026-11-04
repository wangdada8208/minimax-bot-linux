import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AcpAgent } from '../src/agent.mjs';

function fakeProcess(onLine) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(JSON.parse(line));
    }
  });
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};
  return child;
}

function agentWith(script, options = {}) {
  const children = [];
  const configDir = mkdtempSync(join(tmpdir(), 'minimax-bot-agent-'));
  const configPath = join(configDir, 'config.yaml');
  writeFileSync(configPath, 'custom_provider:\n  magpie:\n    models:\n      group/cursor-grok-4.7-500k:\n        reasoning: true\n');
  const agent = new AcpAgent({
    command: 'mcode',
    cwd: '/workspace',
    configPath,
    spawnImpl: () => {
      const child = fakeProcess((message) => child.onLine?.(message));
      children.push(child);
      script(child);
      return child;
    },
    shell: false,
    logger: { info() {}, warn() {}, error() {} },
    ...options,
  });
  return { agent, get child() { return children.at(-1); }, children };
}

test('a prompt turn streams text and finishes with the session id', async () => {
  const events = [];
  const { agent, children } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
      } else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_1', configOptions: [{ id: 'model', currentValue: 'm:custom_provider%3Amagpie:group%2Fcursor-grok-4.7-500k:u', options: [{ value: 'm:custom_provider%3Amagpie:group%2Fcursor-grok-4.7-500k:u', name: 'Grok' }] }, { id: 'thinkingEffort', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }] } })}\n`);
      } else if (message.method === 'session/set_config_option') {
        if (message.params.configId === 'model') {
          assert.equal(message.params.value, 'm:custom_provider%3Amagpie:group%2Fcursor-grok-4.7-500k:u');
        }
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      } else if (message.method === 'session/prompt') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } })}\n`);
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`);
      }
    };
  });
  const result = await agent.run({ text: 'hi', model: { providerId: 'custom_provider:magpie', modelId: 'group/cursor-grok-4.7-500k', thinking: { effort: 'high' } } }, { onEvent: (event) => events.push(event.type) });
  assert.equal(result.sessionId, 'sess_1');
  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(events, ['turn.started', 'text.delta', 'message.committed', 'turn.finished']);
  children.at(-1).emit('exit', 0);
});

test('a login refusal is reported as not permitted instead of a temporary outage', async () => {
  const { agent } = agentWith((proc) => {
    proc.onLine = (message) => {
      const result = message.method === 'initialize'
        ? { protocolVersion: 1 }
        : undefined;
      if (result) proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required: Run `mcode login` and try again.' } })}\n`);
      }
    };
  });
  await assert.rejects(agent.run({ text: 'hi' }), (error) => {
    assert.equal(error.code, 'NOT_PERMITTED');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('a follow-up waits out a cancelled turn instead of being refused', async () => {
  let attempts = 0;
  const { agent } = agentWith((proc) => {
    proc.runTurn = (text) => {
      proc.currPrompt = text;
      proc.promptId = 1;
    };
    proc.onLine = (message) => {
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
      } else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_s' } })}\n`);
      } else if (message.method === 'session/set_config_option') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      } else if (message.method === 'session/prompt') {
        attempts += 1;
        const text = message.params.prompt[0].text;
        // mcode refuses a prompt while the cancelled turn is still settling.
        if (text === 'follow up' && attempts < 3) {
          proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'MiniMax Code Runtime failed: Session already has an active Turn.' } })}\n`);
          return;
        }
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_s', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })}\n`);
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`);
      }
    };
  });
  const result = await agent.run({ text: 'follow up', sessionId: 'sess_s' }, { settleMs: 5000 });
  assert.equal(result.status, 'finished');
  assert.equal(result.text, 'ok');
  assert.ok(attempts >= 3, 'the prompt was retried while the session settled');
});

test('an approval maps allowOnce onto the ACP allow-once option', async () => {
  let allowed = false;
  const { agent } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
      } else if (message.method === 'session/new') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_2' } })}\n`);
      } else if (message.method === 'session/set_config_option') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      } else if (message.method === 'session/prompt') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'session/request_permission', params: { sessionId: 'sess_2', toolCall: { toolCallId: 'call_9', title: 'Run tests', name: 'shell' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }] } })}\n`);
        proc.promptId = message.id;
      } else if (message.id === 90) {
        allowed = message.result.outcome.optionId === 'allow-once';
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: proc.promptId, result: { stopReason: 'end_turn' } })}\n`);
      }
    };
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

test('exposes the catalog through loadModels without shadowing it', async () => {
  const { agent } = agentWith(() => {});
  // The plugin probes `agent.models`, which the host maps to loadModels().
  assert.equal(typeof agent.loadModels, 'function');
  assert.equal(typeof agent.models, 'undefined', 'a class field must not claim the name');
});


function respond(proc, message, result) {
  proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
function notify(proc, method, params, id) {
  proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })}\n`);
}
const modelValue = (model) => `m:p:${model}:u`;
const modelControls = (model) => [{ id: 'model', currentValue: modelValue(model), options: [{ value: modelValue(model), name: model }] }];

test('MCP wire headers remain arrays on new and resume; effort uses refreshed model controls', async () => {
  const methods = [];
  const { agent } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (!message.method || message.method === 'initialized') return;
      methods.push(message);
      if (message.method === 'initialize') respond(proc, message, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
      else if (['session/new', 'session/resume'].includes(message.method)) {
        assert.deepEqual(message.params.mcpServers[0].headers, [{ name: 'Authorization', value: 'Bearer synthetic-token' }]);
        respond(proc, message, { sessionId: 's', configOptions: modelControls('one') });
      } else if (message.method === 'session/set_config_option') {
        if (message.params.configId === 'model') respond(proc, message, { configOptions: [...modelControls('one'), { id: 'thinkingEffort', currentValue: 'low', options: [{ value: 'high', name: 'High' }] }] });
        else { assert.equal(message.params.configId, 'thinkingEffort'); assert.equal(message.params.value, 'high'); respond(proc, message, {}); }
      } else if (message.method === 'session/prompt') respond(proc, message, { stopReason: 'end_turn' });
    };
  }, { mcpUrl: 'http://127.0.0.1:9000/mcp', mcpToken: 'synthetic-token' });
  await agent.run({ text: 'hello', model: { providerId: 'p', modelId: 'one', thinking: { effort: 'high' } } });
  await agent.run({ text: 'again', sessionId: 's' });
  assert.equal(methods.filter((m) => m.method === 'session/resume').length, 1);
});

test('selecting an unsupported model cannot restart or interrupt another session', async () => {
  let activePrompt;
  let activeStarted;
  const started = new Promise((resolve) => { activeStarted = resolve; });
  let count = 0;
  const { agent, children } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') respond(proc, message, { protocolVersion: 1 });
      else if (message.method === 'session/new') respond(proc, message, { sessionId: `s${++count}`, configOptions: modelControls('one') });
      else if (message.method === 'session/prompt') { activePrompt = message; activeStarted(); }
    };
  });
  const running = agent.run({ text: 'working' });
  await started;
  await assert.rejects(agent.run({ text: 'other', model: { providerId: 'p', modelId: 'unconfigured' } }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(children.length, 1);
  respond(children[0], activePrompt, { stopReason: 'end_turn' });
  assert.equal((await running).status, 'finished');
});

test('official form pauses run, validates answers, and observes the same prompt continuation', async () => {
  let prompt;
  let content;
  let earlyAnswer;
  let prompts = 0;
  const { agent } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') {
        assert.deepEqual(message.params.clientCapabilities.elicitation, { form: {} });
        respond(proc, message, { protocolVersion: 1 });
      } else if (message.method === 'session/new') respond(proc, message, { sessionId: 'q' });
      else if (message.method === 'session/prompt') {
        prompts++;
        prompt = message;
        notify(proc, 'elicitation/create', { mode: 'form', sessionId: 'q', message: 'Choose', requestedSchema: { type: 'object', required: ['text'], properties: {
          choice: { type: 'string', title: 'Choice', oneOf: [{ const: 'a', title: 'A' }] },
          choice__other: { type: 'string', title: 'Choice — Other' },
          multi: { type: 'array', title: 'Several', items: { anyOf: [{ const: 'b', title: 'B' }, { const: 'c', title: 'C' }] } },
          text: { type: 'string', title: 'Notes' },
        } } }, 501);
      } else if (message.id === 501) {
        assert.equal(message.result.action, 'accept');
        content = message.result.content;
        notify(proc, 'session/update', { sessionId: 'q', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued' } } });
        respond(proc, prompt, { stopReason: 'end_turn' });
      }
    };
  });
  const first = await agent.run({ text: 'ask' }, { onEvent(event) {
    if (event.type === 'question.requested') earlyAnswer = agent.answer({ sessionId: event.sessionId, requestId: event.requestId, answers: [] }).catch((error) => error.code);
  } });
  assert.equal(await earlyAnswer, 'BUSY');
  assert.equal(first.status, 'finished');
  assert.equal(first.pendingQuestion.request.steps.length, 3);
  const input = { sessionId: 'q', requestId: first.pendingQuestion.requestId, answers: [] };
  await assert.rejects(agent.answer(input), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(agent.answer({ ...input, sessionId: 'wrong' }), { code: 'REQUEST_NOT_FOUND' });
  await assert.rejects(agent.answer({ ...input, answers: [{ stepId: 'choice', selectedOptionIds: ['unknown'] }] }), { code: 'INVALID_ARGUMENTS' });
  const events = [];
  const result = await agent.answer({ ...input, answers: [
    { stepId: 'choice', selectedOther: true, otherText: 'custom', selectedOptionIds: [] },
    { stepId: 'multi', selectedOptionIds: ['b', 'c'] },
    { stepId: 'text', selectedOther: true, otherText: 'notes' },
  ] }, { onEvent: (event) => events.push(event.type) });
  assert.deepEqual(content, { choice__other: 'custom', multi: ['b', 'c'], text: 'notes' });
  assert.equal(prompts, 1, 'answer must complete the elicitation, never send a replacement text prompt');
  assert.equal(result.text, 'Continued');
  assert.deepEqual(events, ['turn.started', 'text.delta', 'message.committed', 'turn.finished']);
  await assert.rejects(agent.answer(input), { code: 'REQUEST_NOT_FOUND' });
});


test('a paused questionnaire does not block other sessions and dispose cancels its ACP request', async () => {
  let session = 0;
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const { agent, children } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') respond(proc, message, { protocolVersion: 1 });
      else if (message.method === 'session/new') respond(proc, message, { sessionId: `isolated-${++session}` });
      else if (message.method === 'session/prompt') {
        if (message.params.sessionId === 'isolated-1') {
          notify(proc, 'elicitation/create', { mode: 'form', sessionId: 'isolated-1', message: 'Question', requestedSchema: { type: 'object', properties: { note: { type: 'string' } } } }, 601);
        } else respond(proc, message, { stopReason: 'end_turn' });
      } else if (message.id === 601) cancelled(message.result.action);
    };
  });
  const paused = await agent.run({ text: 'ask' });
  assert.ok(paused.pendingQuestion);
  assert.equal((await agent.run({ text: 'independent' })).status, 'finished');
  await assert.rejects(agent.run({ sessionId: paused.sessionId, text: 'must answer first' }), { code: 'BUSY' });
  assert.equal(children.length, 1);
  await agent.dispose();
  // Disposal may close stdio before the response drains. Pending state must still
  // be withdrawn immediately, and no replacement process may be started.
  await assert.rejects(agent.answer({ sessionId: paused.sessionId, requestId: paused.pendingQuestion.requestId, answers: [] }), { code: 'REQUEST_NOT_FOUND' });
  await assert.rejects(agent.start(), { code: 'AGENT_UNAVAILABLE' });
});

test('answer reports unknown outcome when ACP fails after the answer is sent', async () => {
  const { agent } = agentWith((proc) => {
    proc.onLine = (message) => {
      if (message.method === 'initialize') respond(proc, message, { protocolVersion: 1 });
      else if (message.method === 'session/new') respond(proc, message, { sessionId: 'lost' });
      else if (message.method === 'session/prompt') {
        proc.prompt = message;
        notify(proc, 'elicitation/create', { mode: 'form', sessionId: 'lost', message: 'Notes', requestedSchema: { type: 'object', properties: { note: { type: 'string' } } } }, 701);
      } else if (message.id === 701) {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: proc.prompt.id, error: { code: -32603, message: 'connection failed after recording answer' } })}\n`);
      }
    };
  });
  const paused = await agent.run({ text: 'ask' });
  await assert.rejects(agent.answer({ sessionId: 'lost', requestId: paused.pendingQuestion.requestId, answers: [] }), { code: 'AGENT_OUTCOME_UNKNOWN', retryable: false });
});
