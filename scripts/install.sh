#!/usr/bin/env bash
# Install on a bare Linux server. Installs Node deps, the MiniMax Code CLI,
# and the pinned upstream plugin, then prints the next step (sign in).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="${MINIMAX_UPSTREAM_REPO:-https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git}"
UPSTREAM_DIR="${MINIMAX_UPSTREAM_DIR:-$ROOT/../MiniMax-Code-MiniApps}"
PLUGIN_REL="plugins/minimax-ai/minimax-bot"
COMMIT="$(node -p "require('$ROOT/upstream.lock.json').commit")"

command -v node >/dev/null || { echo "Install Node.js 22.19+ first: https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19)) { console.error("Node 22.19+ required, found "+process.versions.node); process.exit(1); }'

echo "==> Installing host dependencies"
(cd "$ROOT" && npm install --omit=dev)

echo "==> Installing MiniMax Code CLI"
npm install -g @minimax-ai/code

echo "==> Fetching upstream plugin at $COMMIT"
if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  git clone "$UPSTREAM_URL" "$UPSTREAM_DIR"
fi
git -C "$UPSTREAM_DIR" fetch origin "$COMMIT" --depth 1 || git -C "$UPSTREAM_DIR" fetch origin main --depth 1
git -C "$UPSTREAM_DIR" checkout --detach "$COMMIT"

cat <<EOF

Installed.

Next:
  1. Sign in to MiniMax Code (opens a browser; use --no-browser on a headless server):
       mcode login --region global --no-browser
     Use --region cn for a mainland China account.
  2. Start the host:
       MINIMAX_BOT_PLUGIN="$UPSTREAM_DIR/$PLUGIN_REL" npm start
     It prints a URL with an access token. Open it from another computer.

For an always-on service, see deploy/minimax-bot.service or scripts/watchdog.sh.
EOF
