import { EventEmitter } from 'node:events';
import { AcpAgent } from '../src/agent.mjs';

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

const agent = new AcpAgent({
  command: 'mcode',
  cwd: '/workspace',
  spawnImpl: () => child,
  logger: { info() {}, warn() {}, error() {} },
});
child.stdin.on('line', (line) => {
  const message = JSON.parse(line);
  console.log('IN', message.method || message.id);
  if (message.method === 'initialize') {
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`);
  } else if (message.method === 'session/new') {
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_1' } })}\n`);
  } else if (message.method === 'session/prompt') {
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } })}\n`);
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`);
  }
});
agent.run({ text: 'hi' }).then((result) => {
  console.log('RESULT', result.status, result.text);
}).catch((error) => {
  console.log('ERR', error.message);
});
