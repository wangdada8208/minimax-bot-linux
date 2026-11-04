import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOT_AGENT_NAME, BOT_BROWSER_POLICY, ensureBotAgentPolicy } from '../src/native-policy.mjs';

const officialRoot = path.resolve(process.env.MINIMAX_RUNTIME_DIR ?? process.env.MINIMAX_CODE_OFFICIAL_ROOT ??
  fileURLToPath(new URL('../../minimax-code-official', import.meta.url)));
const requireOfficial = createRequire(path.join(officialRoot, 'package.json'));
const { tsImport } = requireOfficial('tsx/esm/api');
const options = { parentURL: import.meta.url, tsconfig: path.join(officialRoot, 'tsconfig.standalone.json') };
const source = (relative) => tsImport(path.join(officialRoot, 'packages/local-runtime-v2/src', relative), options);
const { AgentFiles } = await source('service/agent/storage/agent-files.ts');
const { BuiltinAgentFiles } = await source('service/agent/storage/builtin-agent-files.ts');
const { createLocalAgentCapabilitySelector } = await source('service/turn-system/agent-host/assembly/local-turn-tool-catalog.ts');

async function profile(t, prompt = 'Official mavis prompt.\n\nKeep every original instruction.\n') {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'minimax-native-policy-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const files = new AgentFiles(dataDir);
  const builtins = new BuiltinAgentFiles(files, dataDir);
  await builtins.seed('mavis', {
    name: 'mavis', description: 'Official builtin', systemPrompt: prompt,
    model: 'provider/model-that-must-not-be-copied', tools: ['ask_user'],
    skills: ['builtin-skill'], features: { mavis: true, delegation: true, webSearch: true },
  });
  return { dataDir, files, builtins, prompt };
}

// This uses the official canonical codec and actual turn capability selector,
// not a mock implementation of denylist filtering. No real profile is opened.
test('custom policy denies feature enablement while preserving default tools and prompt', async (t) => {
  const { dataDir, files, prompt } = await profile(t);
  const builtinFile = path.join(files.builtinAgentDir('mavis'), 'agent.md');
  const before = await readFile(builtinFile, 'utf8');
  assert.deepEqual(await ensureBotAgentPolicy({ officialRoot, dataDir }), { agentName: BOT_AGENT_NAME });
  const config = await files.getCanonicalConfig(BOT_AGENT_NAME);
  assert.equal(config.systemPrompt, `${prompt}\n\n${BOT_BROWSER_POLICY}`);
  assert.deepEqual(config.disallowedTools, ['request_feature_enable']);
  for (const field of ['model', 'effort', 'tools', 'skills', 'mcpServers', 'xMavis']) {
    assert.equal(Object.hasOwn(config, field), false, `${field} should inherit runtime defaults`);
  }
  const selector = createLocalAgentCapabilitySelector(config);
  assert.equal(selector.allowsTool('request_feature_enable'), false);
  assert.equal(selector.allowsTool('request_feature_enable', undefined, { featureOwned: true }), false);
  for (const name of ['ask_user', 'shell', 'web_search', 'mcp__authorized__browser']) {
    assert.equal(selector.allowsTool(name), true, `${name} remains available to other runtime gates`);
  }
  assert.equal(selector.allowsMcpServer('authorized'), true);
  assert.equal(selector.allowsSkill('default-skill'), true);
  assert.equal(await readFile(builtinFile, 'utf8'), before);
  assert.match(BOT_BROWSER_POLICY, /independently authorized Browser Harness/);
  assert.match(BOT_BROWSER_POLICY, /MINIMAX_BOT_BROWSER_HARNESS/);
  assert.doesNotMatch(config.systemPrompt, /\/data\//);
});

test('policy is idempotent and updates only the managed custom Agent from current builtin prompt', async (t) => {
  const { dataDir, files, builtins } = await profile(t);
  await ensureBotAgentPolicy({ officialRoot, dataDir });
  const customFile = path.join(files.agentDir(BOT_AGENT_NAME), 'agent.md');
  const before = await stat(customFile);
  await ensureBotAgentPolicy({ officialRoot, dataDir });
  assert.equal((await stat(customFile)).mtimeMs, before.mtimeMs);
  await files.writeCanonicalConfig(BOT_AGENT_NAME, {
    name: BOT_AGENT_NAME, description: 'outdated', systemPrompt: 'old',
    tools: [], disallowedTools: ['ask_user'], model: 'other/old',
  });
  const builtinDocument = await files.readCanonicalDocument('mavis', true);
  await builtins.reload('mavis', {
    name: 'mavis', description: 'Updated official builtin', systemPrompt: 'Updated official prompt.',
    features: { mavis: true, delegation: true, webSearch: true },
  }, builtinDocument.revision);
  await ensureBotAgentPolicy({ officialRoot, dataDir });
  const config = await files.getCanonicalConfig(BOT_AGENT_NAME);
  assert.equal(config.systemPrompt, `Updated official prompt.\n\n${BOT_BROWSER_POLICY}`);
  assert.deepEqual(config.disallowedTools, ['request_feature_enable']);
  assert.equal(Object.hasOwn(config, 'tools'), false);
  assert.equal(Object.hasOwn(config, 'model'), false);
  assert.equal(config.systemPrompt.split(BOT_BROWSER_POLICY).length, 2);
});

test('uses public createAgent initialDefinition when provided and verifies persisted canonical config', async (t) => {
  const { dataDir, files } = await profile(t);
  const requests = [];
  const cliService = {
    async createAgent(request) {
      requests.push(request);
      await files.publishCanonicalConfigIfAbsent(request.name, request.initialDefinition);
      return { name: request.name };
    },
  };
  await ensureBotAgentPolicy({ officialRoot, dataDir, cliService });
  await ensureBotAgentPolicy({ officialRoot, dataDir, cliService });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].definitionOnly, true);
  assert.deepEqual(Object.keys(requests[0].initialDefinition).sort(),
    ['description', 'disallowedTools', 'name', 'systemPrompt']);
});

test('missing builtin prompt fails before creating a custom Agent', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'minimax-native-policy-empty-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(ensureBotAgentPolicy({ officialRoot, dataDir }),
    { code: 'AGENT_CONFIG_NOT_FOUND' });
  const files = new AgentFiles(dataDir);
  await assert.rejects(files.getCanonicalConfig(BOT_AGENT_NAME), { code: 'AGENT_CONFIG_NOT_FOUND' });
});

test('official storage refuses a linked custom config without modifying its target', async (t) => {
  const { dataDir, files } = await profile(t);
  await files.ensureLayout(BOT_AGENT_NAME);
  const target = path.join(dataDir, 'untouched.md');
  await writeFile(target, 'must remain unchanged');
  await symlink(target, path.join(files.agentDir(BOT_AGENT_NAME), 'agent.md'));
  await assert.rejects(ensureBotAgentPolicy({ officialRoot, dataDir }));
  assert.equal(await readFile(target, 'utf8'), 'must remain unchanged');
});
