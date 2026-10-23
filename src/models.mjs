// @ts-check
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument as parseYaml } from 'yaml';

/**
 * The model list behind the Bot settings picker.
 *
 * Magpie exposes its catalog through an OpenAI-compatible `/models` endpoint.
 * The official page expects the desktop host's shape: provider, model id,
 * display name, and the reasoning levels a model can run at. `mcode acp`
 * only offers its own short model list, so the catalog comes from Magpie and
 * the selected id is applied to the ACP session before the turn.
 */

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** @param {any} item */
export function toCatalogModel(item) {
  const modelId = text(item?.id);
  if (!modelId) return undefined;
  const levels = [...new Set(
    (Array.isArray(item?.supported_reasoning_levels) ? item.supported_reasoning_levels : [])
      .map((level) => text(level?.effort))
      .filter(Boolean),
  )];
  const fallback = Array.isArray(item?.reasoning_levels)
    ? item.reasoning_levels.map(text).filter(Boolean)
    : [];
  const efforts = levels.length ? levels : [...new Set(fallback)];
  return {
    providerId: 'custom_provider:magpie',
    modelId,
    displayName: text(item?.display_name) || text(item?.magpie_label) || modelId,
    ...(efforts.length ? {
      variants: ['thinking', ''],
      thinking: { efforts, default: efforts.includes('high') ? 'high' : efforts[0] },
    } : {}),
  };
}

/** @param {unknown} payload */
export function catalogFromModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(/** @type {any} */ (payload)?.data) ? /** @type {any} */ (payload).data : [];
  const models = rows.map(toCatalogModel).filter(Boolean);
  const preferred = models.find((model) => model.modelId === 'group/cursor-grok-4.7-500k') ?? models[0];
  return {
    models,
    ...(preferred ? { default: { providerId: preferred.providerId, modelId: preferred.modelId } } : {}),
  };
}

/**
 * ACP's model selector stores a provider and model as one opaque option value.
 * @param {{ providerId?: string, modelId?: string, variant?: string }} model
 */
/**
 * ACP only accepts a model it already advertises. Registering the selected
 * Magpie model in mcode's config makes the next session advertise it.
 * @param {string} configPath
 * @param {{ providerId?: string, modelId?: string }} model
 */
export function ensureConfiguredModel(configPath, model) {
  const providerId = text(model?.providerId);
  const modelId = text(model?.modelId);
  if (!providerId.startsWith('custom_provider:') || !modelId) return false;
  const providerKey = providerId.slice('custom_provider:'.length);
  const raw = readFileSync(configPath, 'utf8');
  const doc = parseYaml(raw);
  const models = doc.getIn(['custom_provider', providerKey, 'models'], true);
  if (!models || typeof models.get !== 'function' || models.get(modelId)) return false;
  const template = models.items?.[0]?.value;
  if (!template) return false;
  models.set(modelId, template.clone());
  const next = String(doc);
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, next.endsWith('\n') ? next : `${next}\n`);
  renameSync(temporary, configPath);
  return true;
}

export function acpModelValue(model) {
  const providerId = text(model?.providerId);
  const modelId = text(model?.modelId);
  if (!providerId || !modelId) return '';
  const variant = model?.variant === '' || typeof model?.variant === 'string' ? model.variant : 'thinking';
  return `m:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}:v:${encodeURIComponent(variant)}`;
}
