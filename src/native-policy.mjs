import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOT_AGENT_NAME = 'minimax-bot-linux';
const DESCRIPTION = 'MiniMax Bot Linux with administrator-managed optional browser access.';

export const BOT_BROWSER_POLICY = `## Administrator policy for Bot browser access

Optional Browser Use feature enablement is managed by the administrator outside this Bot conversation. Never invoke request_feature_enable, ask the user to enable Browser Use, or wait for an optional feature enablement questionnaire. When optional Browser Use is unavailable, continue with available tools and clearly explain any task limitation.

For browser tasks, an independently authorized Browser Harness may be used through the normal shell tool. Resolve its executable from MINIMAX_BOT_BROWSER_HARNESS when configured by the administrator, otherwise use browser-harness from PATH. Use only the access and browser sessions that this Harness already authorizes. Do not bypass access controls, grant permissions, enable an unavailable feature, or substitute another identity. If the Harness is unavailable or denies access, report that limitation and continue the parts of the task that remain possible.

For MiniMax Bot team tools, always pass caller_bot_id using the Bot identity in the official <minimax-bot-context> block. Omitting it creates a detached task without automatic result delivery to the caller. Do not treat task receipt as execution or completion.

Use tool names from the current tool inventory, not names remembered from earlier sessions. Within run_code, access tool names containing punctuation with bracket notation, such as tools["exact-name"], rather than treating punctuation as JavaScript operators.

Preserve ask_user for genuine questions, choices, and confirmations about the user's task. This browser policy does not suppress normal user questions or authorize actions requiring the user's consent.`;

const officialModules = new Map();

async function loadOfficialPolicyModules(officialRoot) {
  const root = path.resolve(officialRoot);
  if (!officialModules.has(root)) {
    const loading = (async () => {
      const nativeBundle = path.join(root, 'dist/bot-native.mjs');
      if (existsSync(nativeBundle)) return import(pathToFileURL(nativeBundle).href);
      // Source-only policy tests use the official loader; execution always uses
      // the complete built Runtime and its worker/resource-location profile.
      // Reuse the canonical storage implementation rather than our own codec.
      const requireOfficial = createRequire(path.join(root, 'package.json'));
      const { tsImport } = requireOfficial('tsx/esm/api');
      const options = {
        parentURL: pathToFileURL(path.join(root, 'package.json')).href,
        tsconfig: path.join(root, 'tsconfig.standalone.json'),
      };
      const storage = path.join(root, 'packages/local-runtime-v2/src/service/agent/storage');
      const [files, canonical] = await Promise.all([
        tsImport(path.join(storage, 'agent-files.ts'), options),
        tsImport(path.join(storage, 'canonical-agent-config.ts'), options),
      ]);
      return { ...files, ...canonical };
    })();
    officialModules.set(root, loading);
    loading.catch(() => officialModules.delete(root));
  }
  return officialModules.get(root);
}

/**
 * Call after the official runtime has initialized its builtin canonical mirror,
 * before creating Bot sessions. Existing sessions keep their original binding.
 *
 * The current official CliService has no Agent CRUD. If a compatible host adds
 * createAgent, use its public initialDefinition API for initial publication;
 * updates still use the official canonical CAS writer because updateAgent does
 * not accept tool selectors. No builtin or official checkout file is written.
 *
 * @param {{officialRoot: string, dataDir: string, cliService?: object}} options
 * @returns {Promise<{agentName: string}>}
 */
export async function ensureBotAgentPolicy({ officialRoot, dataDir, cliService }) {
  if (!officialRoot || !dataDir) throw new TypeError('officialRoot and dataDir are required');
  const root = path.resolve(dataDir);
  const { AgentFiles, readBuiltinCanonicalAgentConfig, serializeCanonicalAgentConfig } =
    await loadOfficialPolicyModules(officialRoot);
  const files = new AgentFiles(root);
  const { config: builtin } = await readBuiltinCanonicalAgentConfig({
    agentDir: files.builtinAgentDir('mavis'),
    routeName: 'mavis',
    trustedRoot: root,
  });
  if (!builtin.systemPrompt.trim()) throw new Error('Official mavis system prompt is empty');
  // Deliberately copy only the prompt: absent selectors inherit the official
  // inventory; an absent model inherits runtime model selection.
  const config = {
    name: BOT_AGENT_NAME,
    description: DESCRIPTION,
    disallowedTools: ['request_feature_enable'],
    systemPrompt: `${builtin.systemPrompt}\n\n${BOT_BROWSER_POLICY}`,
  };
  const content = serializeCanonicalAgentConfig({ config });
  let current;
  try {
    current = await files.readCanonicalDocument(BOT_AGENT_NAME);
  } catch (error) {
    if (error.code !== 'AGENT_CONFIG_NOT_FOUND') throw error;
  }
  if (!current) {
    if (typeof cliService?.createAgent === 'function') {
      const created = await cliService.createAgent({
        name: BOT_AGENT_NAME,
        definitionOnly: true,
        initialDefinition: config,
      });
      if (created.name !== BOT_AGENT_NAME) {
        throw new Error('Official Agent API returned an unexpected Bot Agent name');
      }
    } else {
      await files.publishCanonicalConfigIfAbsent(BOT_AGENT_NAME, config);
    }
    // Read back through the official parser: API success alone is insufficient.
    current = await files.readCanonicalDocument(BOT_AGENT_NAME);
  }
  if (current.content !== content) {
    await files.replaceCanonicalDocument({
      name: BOT_AGENT_NAME,
      content,
      expectedRevision: current.revision,
    });
  }
  const saved = await files.getCanonicalConfig(BOT_AGENT_NAME);
  if (saved.systemPrompt !== config.systemPrompt ||
      saved.disallowedTools?.length !== 1 ||
      saved.disallowedTools[0] !== 'request_feature_enable') {
    throw new Error('Official Bot Agent policy verification failed');
  }
  return { agentName: BOT_AGENT_NAME };
}
