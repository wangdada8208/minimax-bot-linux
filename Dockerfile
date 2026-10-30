# Build: node:22-bookworm (not slim) so the mcode native addons have a toolchain.
FROM node:22-bookworm

ARG UPSTREAM_REPO=https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The MiniMax Code CLI runs the Bots. Its login lives in /root/.minimax and is
# mounted, never baked into the image.
RUN npm install -g @minimax-ai/code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY src ./src
COPY upstream.lock.json ./

# Fetch the exact upstream plugin commit recorded in upstream.lock.json.
RUN set -eux; \
  commit="$(node -p "require('/app/upstream.lock.json').commit")"; \
  git clone "$UPSTREAM_REPO" /opt/upstream; \
  git -C /opt/upstream fetch origin "$commit" --depth 1 || git -C /opt/upstream fetch origin main --depth 1; \
  git -C /opt/upstream checkout --detach "$commit"

ENV MINIMAX_BOT_HOST=0.0.0.0 \
    MINIMAX_BOT_PORT=8787 \
    MINIMAX_BOT_DATA=/data \
    MINIMAX_BOT_CWD=/data/workspace \
    MINIMAX_BOT_PLUGIN=/opt/upstream/plugins/minimax-ai/minimax-bot \
    MINIMAX_BOT_MCODE=/usr/local/bin/mcode \
    NODE_ENV=production

RUN mkdir -p /data/workspace
VOLUME ["/data", "/root/.minimax"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=require('node:net').connect(8787,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"

CMD ["node", "src/host.mjs"]
