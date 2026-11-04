import assert from 'node:assert/strict';
import test from 'node:test';
import { acpModelValue, catalogFromModels, catalogFromControls, parseModelConfigValue } from '../src/models.mjs';

const plain = 'm:custom_provider%3Amagpie:group%2Fmodel:u';
const thinking = 'm:custom_provider%3Amagpie:group%2Fmodel:v:thinking';
const controls = [{ id: 'model', currentValue: plain, options: [{ value: plain, name: 'Model' }, { value: thinking, name: 'Model · thinking' }] }];

test('selects an advertised opaque value without forcing thinking', () => {
  const model = { providerId: 'custom_provider:magpie', modelId: 'group/model' };
  assert.equal(acpModelValue(model, controls), plain);
  assert.equal(acpModelValue({ ...model, variant: 'thinking' }, controls), thinking);
  assert.throws(() => acpModelValue({ ...model, variant: '' }, controls), /not advertised/);
  assert.equal(acpModelValue({}), '');
});

test('decodes official undefined and empty variants distinctly', () => {
  assert.deepEqual(parseModelConfigValue(plain), { providerId: 'custom_provider:magpie', modelId: 'group/model' });
  assert.deepEqual(parseModelConfigValue('m:p:m:v:'), { providerId: 'p', modelId: 'm', variant: '' });
  assert.throws(() => parseModelConfigValue('m:p:m:u:extra'), /Invalid/);
});

test('retains all 286 catalog models and marks unsupported choices explicitly', () => {
  const rows = Array.from({ length: 286 }, (_, index) => ({ id: index === 0 ? 'group/model' : `model-${index}` }));
  const catalog = catalogFromModels({ data: rows }, controls);
  assert.equal(catalog.models.length, 286);
  assert.equal(catalog.models[0].supported, true);
  assert.equal(catalog.models[1].supported, false);
  assert.match(catalog.models[1].displayName, /not configured/);
  assert.match(catalog.models[1].unsupportedReason, /official provider/);
  assert.equal(catalog.default.modelId, 'group/model');
  assert.throws(() => acpModelValue(catalog.models[1], controls), /not advertised/);
});

test('catalog reasoning levels come only from current official controls', () => {
  const catalog = catalogFromControls([...controls, { id: 'thinkingEffort', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }] }]);
  assert.deepEqual(catalog.models[0].thinking, { efforts: ['low', 'medium'], default: 'medium' });
  assert.deepEqual(catalog.models[0].variants, ['thinking']);
});
