import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acpModelValue, catalogFromModels, ensureConfiguredModel, toCatalogModel } from '../src/models.mjs';

test('turns a Magpie model into the picker shape', () => {
  const model = toCatalogModel({
    id: 'group/cursor-grok-4.7-500k',
    display_name: 'Cursor Grok 4.7 @ 500k',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }],
  });
  assert.equal(model.providerId, 'custom_provider:magpie');
  assert.equal(model.modelId, 'group/cursor-grok-4.7-500k');
  assert.deepEqual(model.thinking.efforts, ['low', 'high']);
  assert.equal(model.thinking.default, 'high');
  assert.deepEqual(model.variants, ['thinking', '']);
});

test('uses the 500k Grok model as the default and skips blank ids', () => {
  const catalog = catalogFromModels({
    data: [{ id: '' }, { id: 'server/auto/other', display_name: 'Other' }, { id: 'group/cursor-grok-4.7-500k' }],
  });
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.default.modelId, 'group/cursor-grok-4.7-500k');
});

test('adds a selected Magpie model without dropping the existing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minimax-bot-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'custom_provider:',
    '  magpie:',
    '    models:',
    '      group/cursor-grok-4.7-500k:',
    '        reasoning: true',
    '',
  ].join('\n'));
  const model = { providerId: 'custom_provider:magpie', modelId: 'group/cursor-opus-5' };
  assert.equal(ensureConfiguredModel(path, model), true);
  assert.equal(ensureConfiguredModel(path, model), false);
  const saved = readFileSync(path, 'utf8');
  assert.match(saved, /group\/cursor-grok-4\.7-500k:/);
  assert.match(saved, /group\/cursor-opus-5:/);
  assert.match(saved, /reasoning: true/);
  rmSync(dir, { recursive: true, force: true });
});

test('encodes a selected model as an ACP config value', () => {
  assert.equal(
    acpModelValue({ providerId: 'custom_provider:magpie', modelId: 'group/cursor-opus-5', variant: '' }),
    'm:custom_provider%3Amagpie:group%2Fcursor-opus-5:v:',
  );
  assert.equal(acpModelValue({}), '');
});
