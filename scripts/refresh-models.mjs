// Glue only: invoke the official provider application's refresh operation.
// The official implementation owns discovery, merge, revisions and persistence.
// From the official checkout:
// TSX_TSCONFIG_PATH="$PWD/tsconfig.standalone.json" node \
//   --import ./node_modules/tsx/dist/loader.mjs /path/to/this/script.mjs [providerId] [--apply]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const official = resolve(process.env.MINIMAX_RUNTIME_DIR ?? process.cwd());
const source = (path) => pathToFileURL(resolve(official, 'packages/tui/src', path)).href;
const { prepareTuiDataDir } = await import(source('runtime/data-dir.ts'));
const { createTuiRuntime, shutdownTuiRuntime } = await import(source('runtime/lifecycle.ts'));
const { McodeProviderApplication } = await import(source('provider/application.ts'));
const { version } = JSON.parse(await readFile(resolve(official, 'package.json'), 'utf8'));
const providerId = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'custom_provider:magpie';
let runtime;
try {
  runtime = await createTuiRuntime({
    dataDir: await prepareTuiDataDir(),
    workspaceDir: process.env.MINIMAX_BOT_CWD ?? process.cwd(),
    version,
    surface: 'headless',
  });
  const application = new McodeProviderApplication(runtime.adapter);
  const snapshot = await application.snapshot();
  const provider = snapshot.providers.find((item) => item.providerId === providerId);
  if (!provider) throw new Error(`Configured provider not found: ${providerId}`);
  const applied = process.argv.includes('--apply');
  const added = applied ? await application.refreshModels(provider) : 0;
  let reasoningModels = 0;
  if (process.argv.includes('--sync-reasoning')) {
    // Provider-specific extension: the generic official discoverer returns IDs
    // and labels, while Magpie also publishes explicit effort options. Translate
    // only those declared options into the official candidate-save contract.
    const url = process.env.MINIMAX_BOT_MODELS_URL;
    if (!url) throw new Error('--sync-reasoning requires MINIMAX_BOT_MODELS_URL');
    const key = process.env.MINIMAX_BOT_MODELS_API_KEY ?? process.env.magpie;
    const response = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Provider metadata returned HTTP ${response.status}`);
    const payload = await response.json();
    const metadata = new Map((Array.isArray(payload) ? payload : payload.data ?? []).map((row) => {
      const raw = row.supported_reasoning_levels?.map((item) => item.effort) ?? row.reasoning_levels ?? [];
      return [row.id, [...new Set(raw.filter((effort) => typeof effort === 'string' && effort.trim()).map((effort) => effort.trim()))]];
    }));
    const current = (await application.snapshot()).providers.find((item) => item.providerId === providerId);
    const models = current.models.map(({ modelId }) => {
      const effortOptions = metadata.get(modelId);
      if (!effortOptions?.length) return { modelId };
      reasoningModels++;
      return { modelId, effortOptions };
    });
    if (applied && reasoningModels) {
      const result = await application.saveCandidate({
        providerId, expectedRevision: current.configRevision, baseUrl: current.baseUrl,
        models, modelId: models.find((model) => model.effortOptions)?.modelId,
        skipConnectionTest: true, saveAndUse: false,
      });
      if (!result.success) throw new Error(result.status?.lastErrorMessage ?? 'Could not save declared effort options');
    }
  }
  // Runtime intentionally redirects console methods into diagnostics.
  process.stdout.write(JSON.stringify({ providerId, configured: provider.models.length, added, reasoningModels, applied }) + '\n');
} catch (error) {
  process.stderr.write(`Official provider refresh failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) await shutdownTuiRuntime(runtime);
}
