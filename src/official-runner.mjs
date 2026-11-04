// @ts-check
// The official IPC runner and module lifecycle remain unmodified. This bootstrap
// supplies the Agent capability through the official loadModule extension seam.
import path from 'node:path';
import { AcpAgent } from './agent.mjs';
import { runMiniAppHostRunner, startMiniAppModule } from './vendor/official-miniapp.mjs';

runMiniAppHostRunner({
  async start(init) {
    /** @type {AcpAgent | undefined} */
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
              acp = new AcpAgent({
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
