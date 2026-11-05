// Build-time compatibility only. Importing this module does not read or modify sources.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const nativeCompatibilityRevision = '6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reason = 'Respect an Agent denial of request_feature_enable in native Browser Use reminders without changing availability, tool admission, or safety policy.';

// Raw exact-source evidence is exported for build provenance and review.
export const nativeCompatibilityPatchSpec = Object.freeze([
  {
    path: 'packages/local-runtime-v2/src/service/browser-use/contracts.ts',
    originalSha256: 'bc944130f3f9b4340bf5b981d6d8f434497f02836c39cd42b3b7bf9de19b69e0',
    replacements: [{
      before: "export interface BrowserUseTurnReminderInput {\n  readonly sessionId: string;",
      after: "export interface BrowserUseTurnReminderInput {\n  readonly featureEnableDenied?: boolean;\n  readonly sessionId: string;",
    }],
  },
  {
    path: 'packages/local-runtime-v2/src/application/agent/runtime-agent-product.ts',
    originalSha256: '2910e502f18487eebacc7270fc8e2010c95441c0fb73c50cd0a0aa855e1a7fb3',
    replacements: [{
      before: '            userPrompt: input.promptText,\n            ...allowedExtensionSkillNames(input.agentConfig),',
      after: "            userPrompt: input.promptText,\n            featureEnableDenied: browserFeatureEnableDenied(input.agentConfig),\n            ...allowedExtensionSkillNames(input.agentConfig),",
    }, {
      before: 'function allowedExtensionSkillNames(agentConfig: Readonly<Record<string, unknown>>): {',
      after: [
        'function browserFeatureEnableDenied(agentConfig: Readonly<Record<string, unknown>>): boolean {',
        '  const profile = isRecord(agentConfig.agent_profile) ? agentConfig.agent_profile : undefined;',
        '  const selection = isRecord(profile?.config_selection) ? profile.config_selection : undefined;',
        '  const value = selection?.disallowedTools;',
        "  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')",
        "    ? value.some((entry) => entry.trim() === 'request_feature_enable')",
        '    : false;',
        '}',
        '',
        'function allowedExtensionSkillNames(agentConfig: Readonly<Record<string, unknown>>): {',
      ].join('\n'),
    }],
  },
  {
    path: 'packages/local-runtime-v2/src/service/browser-use/browser-use.service.ts',
    originalSha256: '5e9176941c55980cf79c1be188b82a22a06ac42687f27c02242eb54c3d771142',
    replacements: [{
      before: 'const DESKTOP_PLUGIN_DISABLED_GUIDANCE =',
      after: [
        'const ADMINISTRATOR_DISABLED_BROWSER_GUIDANCE = [',
        "  'Built-in Browser Use is disabled by the administrator for this Agent. Do not request or enable it.',",
        "  'This restriction applies to the native Browser Use capability. Independently authorized tools retain their own policy.',",
        "  'Do not bypass credentials or access controls.',",
        "].join('\\n');",
        '',
        'const DESKTOP_PLUGIN_DISABLED_GUIDANCE =',
      ].join('\n'),
    }, {
      before: [
        '    const disabledGuidance = resolveDisabledGuidance(',
        '      this.options.activationMode,',
        '      browserDisabledGuidanceInjected,',
        '    );',
      ].join('\n'),
      after: [
        '    const disabledGuidance =',
        "      this.options.activationMode === 'explicit-config' &&",
        '      browserDisabledGuidanceInjected &&',
        '      input.featureEnableDenied === true',
        '        ? ADMINISTRATOR_DISABLED_BROWSER_GUIDANCE',
        '        : resolveDisabledGuidance(',
        '            this.options.activationMode,',
        '            browserDisabledGuidanceInjected,',
        '          );',
      ].join('\n'),
    }],
  },
].map((spec) => Object.freeze({
  ...spec,
  replacements: Object.freeze(spec.replacements.map((replacement) => Object.freeze(replacement))),
})));

function patchSource(spec, bytes) {
  const originalSha256 = sha256(bytes);
  if (originalSha256 !== spec.originalSha256) {
    throw new Error(`Native compatibility upstream drift in ${spec.path}: expected ${spec.originalSha256}, found ${originalSha256} (pinned ${nativeCompatibilityRevision})`);
  }
  let contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  for (const { before, after } of spec.replacements) {
    if (contents.split(before).length !== 2) {
      throw new Error(`Native compatibility expected exactly one source snippet in ${spec.path}: ${JSON.stringify(before)}`);
    }
    contents = contents.replace(before, () => after);
  }
  return { contents, originalSha256, patchedSha256: sha256(contents) };
}

/** Validate all three pinned UTF-8 sources up front; never writes to the checkout. */
export async function prepareNativeCompatibilityPatchset({ officialRoot }) {
  if (typeof officialRoot !== 'string' || !officialRoot) throw new TypeError('officialRoot is required');
  const root = path.resolve(officialRoot);
  const sources = new Map();
  const changes = [];
  for (const spec of nativeCompatibilityPatchSpec) {
    const absolutePath = path.join(root, spec.path);
    const patched = patchSource(spec, await readFile(absolutePath));
    sources.set(absolutePath, { spec, contents: patched.contents });
    changes.push(Object.freeze({
      path: spec.path,
      revision: nativeCompatibilityRevision,
      reason,
      originalSha256: patched.originalSha256,
      patchedSha256: patched.patchedSha256,
      replacements: spec.replacements,
    }));
  }
  return { sources, changes: Object.freeze(changes) };
}

/** Attach this plugin only to the native esbuild call, never CLI/minimal lifecycle builds. */
export async function createNativeCompatibilityPlugin({ officialRoot }) {
  const { sources, changes } = await prepareNativeCompatibilityPatchset({ officialRoot });
  const plugin = {
    name: 'native-browser-feature-policy-compatibility',
    setup(build) {
      build.onLoad({ filter: /(?:contracts|runtime-agent-product|browser-use\.service)\.ts$/, namespace: 'file' }, async ({ path: sourcePath }) => {
        const source = sources.get(path.resolve(sourcePath));
        if (!source) return undefined;
        // Validate again on load so source edits after preparation cannot be hidden.
        const { contents } = patchSource(source.spec, await readFile(sourcePath));
        return { contents, loader: 'ts', resolveDir: path.dirname(sourcePath) };
      });
    },
  };
  return { plugin, changes };
}
