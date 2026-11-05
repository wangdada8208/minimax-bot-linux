import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createNativeCompatibilityPlugin,
  nativeCompatibilityPatchSpec,
  nativeCompatibilityRevision,
  prepareNativeCompatibilityPatchset,
} from '../src/runtime-compatibility.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const officialRoot = path.resolve(process.env.MINIMAX_RUNTIME_DIR ?? process.env.MINIMAX_CODE_OFFICIAL_ROOT ?? path.join(projectRoot, '../minimax-code-official'));
const serviceDirectory = 'packages/local-runtime-v2/src/service/browser-use';
const requireOfficial = createRequire(path.join(officialRoot, 'package.json'));
const { build } = requireOfficial('esbuild');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let temporaryRoot;
let original;
let patched;
let changes;
const services = [];

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'minimax-runtime-compatibility-'));
  await mkdir(path.join(temporaryRoot, 'assets'));
  await symlink(path.join(officialRoot, 'packages/local-runtime-v2/assets/agents'), path.join(temporaryRoot, 'assets/agents'), 'dir');
  const { packageExportEntries } = await import(pathToFileURL(path.join(officialRoot, 'scripts/lib/package-exports.mjs')));
  const { packageRoots } = JSON.parse(await readFile(path.join(officialRoot, 'release/extraction.json'), 'utf8'));
  const alias = Object.fromEntries(packageExportEntries(officialRoot, packageRoots).map(({ specifier, file }) => [specifier, path.join(officialRoot, file)]));
  const compatibility = await createNativeCompatibilityPlugin({ officialRoot });
  changes = compatibility.changes;
  for (const [name, plugins] of [['original', []], ['patched', [compatibility.plugin]]]) {
    const outfile = path.join(temporaryRoot, `${name}.mjs`);
    await build({
      stdin: {
        contents: `export { initializeBrowserUseService } from './${serviceDirectory}/initialize.ts';\nexport { BROWSER_CONTROL_DISABLED_GUIDANCE, buildInAppBrowserContext } from './${serviceDirectory}/reminders.ts';\nexport { createRuntimeAgentProduct } from './packages/local-runtime-v2/src/application/agent/runtime-agent-product.ts';`,
        resolveDir: officialRoot,
        sourcefile: 'browser-compatibility-test-entry.mjs',
      },
      absWorkingDir: officialRoot,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      alias,
      nodePaths: [path.join(officialRoot, 'node_modules')],
      plugins,
      outfile,
      banner: { js: `import { createRequire as __compatRequire } from 'node:module';\nconst require = __compatRequire(${JSON.stringify(pathToFileURL(path.join(officialRoot, 'package.json')).href)});` },
    });
    const module = await import(pathToFileURL(outfile));
    if (name === 'original') original = module;
    else patched = module;
  }
});

after(async () => {
  for (const service of services) service.close();
  // Only remove the exact mkdtemp directory created by this test.
  if (temporaryRoot && path.dirname(temporaryRoot) === os.tmpdir() && path.basename(temporaryRoot).startsWith('minimax-runtime-compatibility-')) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function service(module = patched, options = {}) {
  const instance = module.initializeBrowserUseService({
    activationMode: 'explicit-config',
    readConfig: () => ({ filePanelBrowserEnabled: false, browserUseToolingEnabled: false }),
    getImageEncoding: () => ({ maxWidth: 100, maxHeight: 100, maxBase64Bytes: 10000 }),
    registerGeneratedAsset: async () => { throw new Error('Unexpected screenshot registration'); },
    ...options,
  });
  services.push(instance);
  return instance;
}

function reminder(instance, overrides = {}) {
  return instance.reminders.buildTurnReminder({
    sessionId: 'compat-session', turnId: 'compat-turn',
    userPrompt: 'Open the in-app browser and click the login button.',
    ...overrides,
  });
}

function runtimeProduct(module, browserUse, baseReminder) {
  return module.createRuntimeAgentProduct({
    baseProduct: {
      preparation: { configBuilder: { skills: {} } },
      inputPreparation: { reminders: { buildSystem: async () => baseReminder } },
    },
    agentService: {},
    modelConfig: { read: () => ({}) },
    logger: {},
    nowMs: () => 0,
    runtimeOwnerKind: 'electron',
    miniappAvailable: false,
    implicitCustomProviderThinking: false,
    ensureSessionAgentDefinition: async () => undefined,
    agentReferenceProjection: {},
    internalTurnPromptReads: {},
    globalInstructions: { readForPrompt: async () => '' },
    browserUse,
  });
}

function preparedConfig(disallowedTools) {
  return {
    system_prompt: 'Prepared system prompt', tools: [], skills: [],
    agent_profile: {
      exact_owner_name: 'compat-agent', canonical_view_name: 'compat-agent',
      agent_role: 'primary', creation_source: 'user', surface: 'interactive',
      provenance_source: 'test', trusted_builtin: false,
      memory_agent_scope_enabled: false, memory_read_agent_names: [],
      config_selection: { disallowedTools, extensionSkills: ['authorized-skill'] },
    },
  };
}

const systemReminderInput = (agentConfig) => ({
  session: { sessionId: 'compat-session', workspaceDir: '/tmp', kind: 'normal' },
  turnId: 'compat-turn', promptText: 'Open the in-app browser and click the login button.',
  agentConfig,
});

test('actual patched agent product reads only explicit prepared-profile tool denial', async () => {
  const calls = [];
  const finalizeTelemetry = () => {};
  const baseReminder = {
    content: '<system-reminder>\nBase reminder\n</system-reminder>',
    diagnostic: { base: true }, finalizeTelemetry,
  };
  const product = runtimeProduct(patched, {
    extension: {},
    reminders: { buildTurnReminder(input) {
      calls.push(input);
      return { content: 'Browser reminder', diagnostic: { browserControlDisabled: false } };
    } },
  }, baseReminder);
  const malformedProfile = [];
  malformedProfile.config_selection = { disallowedTools: ['request_feature_enable'] };
  const malformedSelection = [];
  malformedSelection.disallowedTools = ['request_feature_enable'];
  const cases = [
    [preparedConfig(['request_feature_enable']), true],
    [preparedConfig(['other', '  request_feature_enable\t']), true],
    [preparedConfig([]), false],
    [preparedConfig(['browser', 'REQUEST_FEATURE_ENABLE', 'request_feature_enable_extra']), false],
    [preparedConfig(undefined), false],
    [preparedConfig('request_feature_enable'), false],
    [preparedConfig(['request_feature_enable', 42]), false],
    [{ tools: [], disallowedTools: ['request_feature_enable'] }, false],
    [{ agent_profile: null }, false],
    [{ agent_profile: malformedProfile }, false],
    [{ agent_profile: { config_selection: null } }, false],
    [{ agent_profile: { config_selection: malformedSelection } }, false],
  ];
  for (const [agentConfig, expected] of cases) {
    const result = await product.inputPreparation.reminders.buildSystem(systemReminderInput(agentConfig));
    assert.equal(calls.at(-1).featureEnableDenied, expected);
    assert.equal(result.content, '<system-reminder>\nBase reminder\nBrowser reminder\n</system-reminder>');
    assert.equal(result.finalizeTelemetry, finalizeTelemetry);
    assert.equal(result.diagnostic.base, true);
    if (agentConfig.agent_profile?.config_selection?.extensionSkills) {
      assert.deepEqual(calls.at(-1).allowedExtensionSkillNames, ['authorized-skill']);
    }
  }
});

test('actual agent-product reminders preserve base content and browser enabled/normal behavior', async () => {
  const base = { content: '<system-reminder>\nBase reminder\n</system-reminder>', diagnostic: { base: true } };
  for (const enabled of [false, true]) {
    const options = enabled ? {
      readConfig: () => ({ filePanelBrowserEnabled: true, browserUseToolingEnabled: true }),
      adapter: { getCapabilities: () => ({ provider: 'electron-file-panel' }), execute: async () => { throw new Error('Unexpected browser operation'); } },
    } : {};
    const compatible = runtimeProduct(patched, service(patched, options), base);
    const upstream = runtimeProduct(original, service(original, options), base);
    for (const config of [preparedConfig([]), preparedConfig(['request_feature_enable'])]) {
      const input = systemReminderInput(config);
      const actual = await compatible.inputPreparation.reminders.buildSystem(input);
      if (!enabled && config.agent_profile.config_selection.disallowedTools.length) {
        assert.match(actual.content, /Base reminder\nBuilt-in Browser Use is disabled by the administrator/);
        assert.doesNotMatch(actual.content, /Call `request_feature_enable`/);
        assert.equal(actual.diagnostic.base, true);
      } else {
        assert.deepEqual(actual, await upstream.inputPreparation.reminders.buildSystem(input));
      }
    }
  }
});

test('denied feature enable uses scoped guidance and retains ambient context and diagnostics', () => {
  const instance = service();
  instance.turnContext.record({ sessionId: 'compat-session', turnId: 'compat-turn', inAppBrowser: { visible: true, selectedTab: true } });
  const result = reminder(instance, { featureEnableDenied: true });
  assert.doesNotMatch(result.content, /Call `request_feature_enable`|Do not call `ask_user`/);
  assert.match(result.content, /Built-in Browser Use is disabled by the administrator/);
  assert.match(result.content, /Do not request or enable it/);
  assert.match(result.content, /restriction applies to the native Browser Use capability/);
  assert.match(result.content, /Independently authorized tools retain their own policy/);
  assert.match(result.content, /Do not bypass credentials or access controls/);
  assert.ok(result.content.startsWith(original.buildInAppBrowserContext({ visible: true, selectedTab: true, controlAuthorized: false })));
  assert.deepEqual(result.diagnostic, {
    browserControlDisabled: true, browserOperationIntentDetected: true,
    browserDisabledGuidanceInjected: true, browserSurfaceVisible: true,
    browserSurfaceSelected: true, browserControlAuthorized: false,
  });
});

test('absent and false flags preserve the original reminder byte for byte', () => {
  const upstream = service(original);
  const compatible = service();
  const expected = reminder(upstream);
  assert.equal(expected.content, original.BROWSER_CONTROL_DISABLED_GUIDANCE);
  assert.match(expected.content, /Call `request_feature_enable`/);
  assert.deepEqual(reminder(compatible), expected);
  assert.deepEqual(reminder(compatible, { featureEnableDenied: false }), expected);
});

test('native availability and actual browser tools remain unavailable when disabled', () => {
  const instance = service();
  reminder(instance, { featureEnableDenied: true });
  assert.equal(instance.isAvailable(), false);
  assert.equal(instance.builtinSkillDescriptor(), undefined);
  const askUser = { def: { name: 'ask_user' } };
  const result = instance.resolveTurnCapability({ sessionId: 'compat-session', turnId: 'compat-turn', workspaceRoot: temporaryRoot, baseTools: [askUser] });
  assert.equal(result.controlAuthorized, false);
  assert.deepEqual(result.tools, [askUser]);
});

test('denial does not alter an already enabled native browser capability', () => {
  const options = {
    readConfig: () => ({ filePanelBrowserEnabled: true, browserUseToolingEnabled: true }),
    adapter: { getCapabilities: () => ({ provider: 'electron-file-panel' }), execute: async () => { throw new Error('Unexpected browser operation'); } },
  };
  const compatible = service(patched, options);
  const upstream = service(original, options);
  assert.equal(compatible.isAvailable(), true);
  assert.deepEqual(reminder(compatible, { featureEnableDenied: true }), reminder(upstream));
  assert.deepEqual(compatible.builtinSkillDescriptor(), upstream.builtinSkillDescriptor());
});

test('normal questionnaires and desktop feature admission retain upstream behavior', () => {
  for (const activationMode of ['explicit-config', 'desktop-plugin']) {
    const compatible = service(patched, { activationMode });
    const upstream = service(original, { activationMode });
    for (const request of [
      {}, { mode: 'questionnaire' }, { mode: 'ask-user' },
      { mode: 'feature-enable', modePayload: { featureKey: 'unrelated-feature' } },
      { mode: 'feature-enable', modePayload: { featureKey: 'browser-use' } },
    ]) assert.deepEqual(compatible.admitQuestionnaireRequest({ request }), upstream.admitQuestionnaireRequest({ request }));
  }
});

test('desktop-plugin guidance and noninteractive behavior are unchanged', () => {
  const compatible = service(patched, { activationMode: 'desktop-plugin' });
  const upstream = service(original, { activationMode: 'desktop-plugin' });
  for (const surface of ['interactive', 'cli', 'task-child']) {
    assert.deepEqual(reminder(compatible, { featureEnableDenied: true, surface }), reminder(upstream, { surface }));
  }
});

test('unrelated prompts and bare links retain original behavior', () => {
  const compatible = service();
  const upstream = service(original);
  for (const userPrompt of ['What is two plus two?', 'https://example.com', 'What is Browser Use?']) {
    assert.deepEqual(reminder(compatible, { featureEnableDenied: true, userPrompt }), reminder(upstream, { userPrompt }));
  }
});

test('Browser safety takeover still requires ask_user and retains desktop enable guard', () => {
  const instance = service();
  const guard = instance.createTurnToolSafetyGuard();
  guard.afterToolCall({ toolCall: { name: 'browser', source: 'builtin' }, result: { details: { result: { safety: { requiredNextTool: 'ask_user' } } } } });
  assert.equal(guard.beforeToolCall({ toolCall: { name: 'web_fetch' } }).block, true);
  assert.equal(guard.beforeToolCall({ toolCall: { name: 'ask_user' } }), undefined);
  const desktop = service(patched, { activationMode: 'desktop-plugin' }).createTurnToolSafetyGuard();
  assert.equal(desktop.beforeToolCall({ toolCall: { name: 'request_feature_enable' }, args: { featureKey: 'browser-use' } }).block, true);
});

test('provenance records exact three-module replacement evidence and source hashes', async () => {
  assert.equal(changes.length, 3);
  const patchset = await prepareNativeCompatibilityPatchset({ officialRoot });
  for (const change of changes) {
    const bytes = await readFile(path.join(officialRoot, change.path));
    assert.equal(hash(bytes), change.originalSha256);
    assert.equal(change.revision, nativeCompatibilityRevision);
    let expected = bytes.toString('utf8');
    for (const { before, after } of change.replacements) {
      assert.equal(expected.split(before).length, 2);
      expected = expected.replace(before, () => after);
    }
    assert.equal(hash(expected), change.patchedSha256);
    assert.equal(patchset.sources.get(path.join(officialRoot, change.path)).contents, expected);
  }
  const product = changes.find(({ path: sourcePath }) => sourcePath.endsWith('runtime-agent-product.ts'));
  assert.match(product.replacements[0].after, /featureEnableDenied: browserFeatureEnableDenied\(input\.agentConfig\)/);
  assert.match(product.replacements[1].after, /isRecord\(agentConfig\.agent_profile\)/);
  assert.match(product.replacements[1].after, /isRecord\(profile\?\.config_selection\)/);
});

test('upstream drift fails closed even outside the replacement snippets', async () => {
  const fixtureRoot = path.join(temporaryRoot, 'drift-fixture');
  for (const spec of nativeCompatibilityPatchSpec) {
    const target = path.join(fixtureRoot, spec.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(officialRoot, spec.path)));
  }
  const serviceSpec = nativeCompatibilityPatchSpec[2];
  const target = path.join(fixtureRoot, serviceSpec.path);
  await writeFile(target, (await readFile(target, 'utf8')) + '\n// upstream drift\n');
  await assert.rejects(createNativeCompatibilityPlugin({ officialRoot: fixtureRoot }), /upstream drift.*browser-use\.service\.ts/);
});

test('plugin only handles its exact official module paths and rechecks source on load', async () => {
  const fixtureRoot = path.join(temporaryRoot, 'onload-fixture');
  for (const spec of nativeCompatibilityPatchSpec) {
    const target = path.join(fixtureRoot, spec.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(officialRoot, spec.path)));
  }
  const { plugin } = await createNativeCompatibilityPlugin({ officialRoot: fixtureRoot });
  let onLoad;
  plugin.setup({ onLoad(options, callback) { assert.equal(options.namespace, 'file'); onLoad = callback; } });
  assert.equal(await onLoad({ path: '/unrelated/contracts.ts' }), undefined);
  const sourcePath = path.join(fixtureRoot, nativeCompatibilityPatchSpec[0].path);
  const result = await onLoad({ path: sourcePath });
  assert.equal(result.loader, 'ts');
  assert.match(result.contents, /readonly featureEnableDenied\?: boolean/);
  await writeFile(sourcePath, (await readFile(sourcePath, 'utf8')).replace('readonly sessionId: string;', 'readonly sessionId: number;'));
  await assert.rejects(onLoad({ path: sourcePath }), /upstream drift/);
});
