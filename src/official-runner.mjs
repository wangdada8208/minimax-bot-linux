// @ts-check
// The official IPC runner and module lifecycle remain unmodified. This bootstrap
// supplies the Agent capability through the official loadModule extension seam.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeBotAgent } from './native-agent.mjs';
import { ensureBotAgentPolicy, BOT_BROWSER_POLICY } from './native-policy.mjs';
import { AcpAgent } from './agent.mjs';
import { runMiniAppHostRunner, startMiniAppModule } from './vendor/official-miniapp.mjs';

runMiniAppHostRunner({
  async start(init) {
    /** @type {AcpAgent | NativeBotAgent | undefined} */
    let acp;
    const emit = (message) => {
      if (process.connected && process.send) process.send(message);
    };
    try {
      const running = await startMiniAppModule(init, {
        emit,
        async loadModule(url) {
          const loaded = await import(url);
          // Let the official loader report START_EXPORT_MISSING itself.
          if (typeof loaded.start !== 'function') return loaded;
          return {
            ...loaded,
            async start(context) {
              const command = process.env.MINIMAX_BOT_MCODE ?? 'mcode';
              const target = path.resolve(command);
              if (process.env.MINIMAX_BOT_AGENT_BACKEND === 'native') {
                // This child owns the embedded official runtime and its profile.
                const inherited = JSON.parse(process.env.MINIMAX_BOT_ACP_ENV ?? '{}');
                for (const [key, value] of Object.entries(inherited)) {
                  if (typeof value === 'string') process.env[key] = value;
                }
                const officialRoot = process.env.MINIMAX_RUNTIME_DIR;
                const { prepareTuiDataDir } = await import(pathToFileURL(path.join(officialRoot, 'dist/bot-native.mjs')).href);
                const dataDir = await prepareTuiDataDir();
                acp = await NativeBotAgent.create({
                  officialRoot, dataDir, cwd: process.env.MINIMAX_BOT_CWD ?? process.cwd(),
                  systemPromptOverrides: { appendSystemPrompt: BOT_BROWSER_POLICY },
                  mcpUrl: `http://${init.listen.host}:${init.listen.port}/mcp/minimax-bot`,
                  logger: context.logger,
                });
                const { agentName } = await ensureBotAgentPolicy({
                  officialRoot, dataDir,
                  cliService: acp.runtime.host.cliService,
                });
                acp.agentName = agentName;
                context.logger.info('agent.native_ready alias=minimax_bot');
              } else acp = new AcpAgent({
                command: target.endsWith('.js') ? (process.env.MINIMAX_BOT_NODE ?? process.execPath) : command,
                args: target.endsWith('.js') ? [target, 'acp'] : ['acp'],
                cwd: process.env.MINIMAX_BOT_CWD ?? process.cwd(),
                env: process.env.MINIMAX_BOT_ACP_ENV ? JSON.parse(process.env.MINIMAX_BOT_ACP_ENV) : process.env,
                modelsUrl: process.env.MINIMAX_BOT_MODELS_URL ?? '',
                modelsApiKey: process.env.MINIMAX_BOT_MODELS_API_KEY ?? '',
                logger: context.logger,
              });
              acp.mcpUrl = `http://${init.listen.host}:${init.listen.port}/mcp/minimax-bot`;
              const agent = Object.freeze({
                run: (input, options) => acp.run(input, options),
                answer: (input, options) => acp.answer(input, options),
                reply: (input) => acp.reply(input),
                models: () => acp.loadModels(),
              });
              return loaded.start(Object.freeze({ ...context, agent }));
            },
          };
        },
      });
      return {
        async stop() {
          try {
            await running.stop();
          } finally {
            await acp?.dispose();
          }
        },
      };
    } catch (error) {
      await acp?.dispose();
      throw error;
    }
  },
});
