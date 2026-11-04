// @ts-check
// Integration only: lifecycle, IPC, readiness, retry, and cleanup are the pinned
// official implementations bundled unchanged by scripts/build-official.mjs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizePluginRoot,
  computeMiniAppPackageDigests,
  createMiniAppNodeRuntimeAdapter,
  readMiniAppManifest,
  readMiniAppMcode,
  readOfficialMcpFile,
  readPluginJsonObject,
  HostMiniAppPortRegistry,
  miniAppCandidateFromPackage,
  readLocalMiniMaxPluginPackage,
  sameMiniAppCandidate,
  WorkspaceMiniAppStorage,
} from './vendor/official-miniapp.mjs';

export { HostMiniAppPortRegistry } from './vendor/official-miniapp.mjs';
const defaultRegistry = new HostMiniAppPortRegistry();
const unavailableLocalRoot = async () => { throw new Error('Local package installation is not part of this host'); };

async function readBotPackage(packageRoot) {
  try {
    return await readLocalMiniMaxPluginPackage(packageRoot, { rejectHardlinks: true, requireMiniApp: true });
  } catch (error) {
    if (!['MINIAPP_MANIFEST_SCHEMA_INVALID', 'MINIAPP_SURFACE_INVALID'].includes(error?.code)) throw error;
    // The public runtime predates the Bot's Agent capability and desktop window
    // hints. Project only those two integration fields out of the in-memory
    // manifest, then use the original official validators and digest algorithm.
    // The on-disk manifest and all payload bytes remain untouched and hashed.
    const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
    const { value: packageJson } = await readPluginJsonObject(root, 'package.json', { portable: true });
    const manifestPath = readMiniAppMcode(packageJson.mcode);
    const { value: manifest } = await readPluginJsonObject(root, manifestPath, { portable: true });
    const { agentAccess, surface, ...rest } = manifest;
    if (agentAccess !== undefined && (!Array.isArray(agentAccess) || agentAccess.some((access) => access !== 'session.run'))) {
      throw new Error('This ACP bridge supports only agentAccess session.run');
    }
    const { window: windowHints, ...surfaceContract } = surface ?? {};
    if (agentAccess === undefined && windowHints === undefined) throw error;
    const { value: identity } = await readPluginJsonObject(root, '.minimax-plugin/plugin.json', { portable: true });
    const mcpGroups = await Promise.all((identity.mcpServers ?? []).map((file) => readOfficialMcpFile(root, file)));
    const contribution = await readMiniAppManifest(root, { ...rest, surface: surfaceContract },
      mcpGroups.flatMap((group) => group.servers.map((server) => server.name)),
      manifestPath.startsWith('liveboard/') ? 'liveboard' : 'miniapp');
    const digests = await computeMiniAppPackageDigests(root.path, contribution.artifacts, { rejectHardlinks: true });
    return { plugin: { name: identity.name, rootPath: root.path, miniapp: { ...contribution, ...digests } } };
  }
}

/**
 * Start the official Node runtime in a child. The child owns its AcpAgent.
 * `preferredPort` follows official policy: only 49152–65535 is accepted;
 * otherwise the official plugin-id hash selects a port in that range.
 * @param {{
 *   pluginRoot: string, dataDir: string, cwd?: string, mcode?: string, node?: string,
 *   modelsUrl?: string, modelsApiKey?: string, preferredPort?: number,
 *   processGeneration?: string, signal?: AbortSignal,
 *   portRegistry?: HostMiniAppPortRegistry,
 *   logger?: Partial<Record<'debug'|'info'|'warn'|'error', Function>>,
 *   env?: NodeJS.ProcessEnv, runnerStartTimeoutMs?: number, maxPortAttempts?: number,
 * }} options
 */
export async function startOfficialBotRuntime(options) {
  const storage = new WorkspaceMiniAppStorage(path.resolve(options.dataDir), {
    stageAccepted: unavailableLocalRoot,
    acceptImported: unavailableLocalRoot,
  });
  const readCandidate = async (root) => miniAppCandidateFromPackage(await readBotPackage(root));
  const candidate = await readCandidate(path.resolve(options.pluginRoot));
  const registry = options.portRegistry ?? defaultRegistry;
  const sourceEnv = options.env ?? process.env;
  // The official runner deliberately filters the environment. Its exported spawn
  // seam adds only our ACP bridge configuration; no lifecycle protocol changes.
  const bridgeEnv = {
    MINIMAX_BOT_CWD: path.resolve(options.cwd ?? sourceEnv.MINIMAX_BOT_CWD ?? process.cwd()),
    MINIMAX_BOT_MCODE: options.mcode ?? sourceEnv.MINIMAX_BOT_MCODE ?? 'mcode',
    MINIMAX_BOT_NODE: options.node ?? sourceEnv.MINIMAX_BOT_NODE ?? process.execPath,
    MINIMAX_BOT_MODELS_URL: options.modelsUrl ?? sourceEnv.MINIMAX_BOT_MODELS_URL ?? '',
    MINIMAX_BOT_MODELS_API_KEY: options.modelsApiKey ?? sourceEnv.MINIMAX_BOT_MODELS_API_KEY ?? sourceEnv.magpie ?? '',
    // ACP previously inherited the host's environment. Keep that behavior scoped
    // to the ACP subprocess rather than replacing the official runner's filter.
    MINIMAX_BOT_ACP_ENV: JSON.stringify(sourceEnv),
  };
  const adapter = createMiniAppNodeRuntimeAdapter({
    resolvePluginDataDir: () => path.resolve(options.dataDir),
    materializePackage: (input) => storage.materializeRuntimePackage(input),
    verifyCandidate: async (accepted) => {
      try {
        return sameMiniAppCandidate(await readCandidate(accepted.packageRoot), accepted);
      } catch {
        return false;
      }
    },
    isPortReserved: (input) => registry.isReserved(input),
    reservePort: (input) => registry.reserve(input),
    runnerPath: fileURLToPath(new URL('./official-runner.mjs', import.meta.url)),
    execPath: options.node ?? process.execPath,
    env: sourceEnv,
    spawn: (command, args, spawnOptions) => spawn(command, args, {
      ...spawnOptions, env: { ...spawnOptions.env, ...bridgeEnv },
    }),
    runnerStartTimeoutMs: options.runnerStartTimeoutMs,
    maxPortAttempts: options.maxPortAttempts,
  });
  return adapter.prepare({
    candidate,
    processGeneration: options.processGeneration ?? randomUUID(),
    preferredPort: options.preferredPort,
    signal: options.signal ?? new AbortController().signal,
    onLog: (event) => options.logger?.[event.level]?.(event.message, { fieldKeys: event.fieldKeys }),
  });
}
