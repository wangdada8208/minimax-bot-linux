// @ts-check
/** ACP controls, rather than endpoint metadata, authorize a model selection. */
export function selectOptions(control) {
  return (control?.options ?? []).flatMap((item) => Array.isArray(item.options) ? item.options : [item]);
}

// Use the official wire codec itself, compiled from unchanged source.
import { parseModelConfigValue } from './vendor/official-miniapp.mjs';
export { parseModelConfigValue };

export function acpModelValue(model, controls) {
  if (!model?.providerId || !model?.modelId) return '';
  const control = controls?.find((item) => item.id === 'model');
  const candidates = selectOptions(control).filter(({ value }) => {
    const selection = parseModelConfigValue(value);
    return selection.providerId === model.providerId && selection.modelId === model.modelId
      && (model.variant === undefined || model.variant === selection.variant);
  });
  const selected = candidates.find(({ value }) => value === control.currentValue)
    ?? candidates.find(({ value }) => parseModelConfigValue(value).variant === undefined)
    ?? candidates[0];
  if (!selected) throw new Error('The selected model/variant is not advertised by MiniMax Code. Configure it with the official provider controls first.');
  return selected.value;
}

export function catalogFromControls(controls = []) {
  const modelControl = controls.find((item) => item.id === 'model');
  const effortControl = controls.find((item) => item.id === 'thinkingEffort');
  const models = [];
  for (const option of selectOptions(modelControl)) {
    const selection = parseModelConfigValue(option.value);
    let model = models.find((row) => row.providerId === selection.providerId && row.modelId === selection.modelId);
    if (!model) {
      model = { providerId: selection.providerId, modelId: selection.modelId, displayName: option.name, supported: true };
      models.push(model);
    }
    if (selection.variant !== undefined) model.variants = [...new Set([...(model.variants ?? []), selection.variant])];
    // Effort options describe only the currently selected model.
    if (option.value === modelControl.currentValue && effortControl) {
      model.thinking = { efforts: selectOptions(effortControl).map(({ value }) => value), default: effortControl.currentValue };
    }
  }
  const selected = modelControl?.currentValue ? parseModelConfigValue(modelControl.currentValue) : undefined;
  return { models, ...(selected ? { default: selected } : {}) };
}

/** Endpoint entries are retained for discovery, with ACP support made explicit. */
export function toCatalogModel(item) {
  if (typeof item?.id !== 'string' || !item.id.trim()) return undefined;
  return { providerId: 'custom_provider:magpie', modelId: item.id.trim(),
    displayName: item.display_name || item.magpie_label || item.id.trim(), supported: false,
    unsupportedReason: 'Not advertised by MiniMax Code; configure this model with the official provider controls.' };
}

export function catalogFromModels(payload, controls = []) {
  const configured = catalogFromControls(controls);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const models = [...configured.models];
  for (const row of rows.map(toCatalogModel).filter(Boolean)) {
    if (!models.some((model) => model.providerId === row.providerId && model.modelId === row.modelId)) {
      models.push({ ...row, displayName: `${row.displayName} (not configured)` });
    }
  }
  return { ...configured, models };
}
