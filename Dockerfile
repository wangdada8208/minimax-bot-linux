FROM node:22-bookworm

ARG UPSTREAM_REPO=https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git
ARG RUNTIME_REPO=https://github.com/MiniMax-AI/minimax-code.git
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY upstream.lock.json ./

# Both official trees are pinned and built without source patches.
RUN set -eux; \
  plugin_commit="$(node -p "require('./upstream.lock.json').plugin.commit")"; \
  runtime_commit="$(node -p "require('./upstream.lock.json').runtime.commit")"; \
  git clone "$UPSTREAM_REPO" /opt/upstream; \
  git -C /opt/upstream checkout --detach "$plugin_commit"; \
  git clone "$RUNTIME_REPO" /opt/minimax-code-official; \
  git -C /opt/minimax-code-official checkout --detach "$runtime_commit"; \
  cd /opt/minimax-code-official; \
  corepack pnpm install --frozen-lockfile; \
  corepack pnpm build; \
  git diff --exit-code

COPY src ./src
COPY scripts ./scripts
ENV MINIMAX_RUNTIME_DIR=/opt/minimax-code-official
RUN npm run build:official \
  && ln -s /opt/minimax-code-official/dist/cli.js /usr/local/bin/mcode

ENV MINIMAX_BOT_HOST=0.0.0.0 \
    MINIMAX_BOT_PORT=8787 \
    MINIMAX_BOT_DATA=/data \
    MINIMAX_BOT_CWD=/data/workspace \
    MINIMAX_BOT_PLUGIN=/opt/upstream/plugins/minimax-ai/minimax-bot \
    MINIMAX_BOT_MCODE=/opt/minimax-code-official/dist/cli.js \
    NODE_ENV=production

RUN mkdir -p /data/workspace
VOLUME ["/data", "/root/.minimax"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=require('node:net').connect(8787,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"
CMD ["node", "src/host.mjs"]
