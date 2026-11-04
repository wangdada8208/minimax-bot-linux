#!/usr/bin/env bash
# Build the pinned, unmodified official CLI and runtime, then install this adapter.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${MINIMAX_RUNTIME_DIR:-$ROOT/../minimax-code-official}"
PLUGIN_DIR="${MINIMAX_PLUGIN_DIR:-${MINIMAX_UPSTREAM_DIR:-$ROOT/../MiniMax-Code-MiniApps}}"

command -v node >/dev/null || { echo 'Install a supported Node.js runtime first.' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(!((a===22&&b>=19)||(a===24&&b>=2)||a===25||a===26)) { console.error("Official runtime requires Node 22.19+ (22.x), 24.2+ (24.x), 25 or 26."); process.exit(1); }'
command -v git >/dev/null

# Do not replace local source edits. Existing clean checkouts can move to the pin.
checkout_pin() {
  local target="$1" repository="$2" commit="$3"
  if [ ! -e "$target" ]; then git clone "$repository" "$target"; fi
  git -C "$target" rev-parse --git-dir >/dev/null
  if [ -n "$(git -C "$target" status --porcelain)" ]; then
    echo "Refusing to change a dirty upstream checkout: $target" >&2
    exit 1
  fi
  git -C "$target" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$target" fetch origin "$commit"
  git -C "$target" checkout --detach "$commit"
}
plugin_commit="$(node -p "require('$ROOT/upstream.lock.json').plugin.commit")"
runtime_commit="$(node -p "require('$ROOT/upstream.lock.json').runtime.commit")"
checkout_pin "$PLUGIN_DIR" "${MINIMAX_PLUGIN_REPO:-https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git}" "$plugin_commit"
checkout_pin "$RUNTIME_DIR" "${MINIMAX_RUNTIME_REPO:-https://github.com/MiniMax-AI/minimax-code.git}" "$runtime_commit"

manager="$(node -p "require('$RUNTIME_DIR/package.json').packageManager")"
if command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
else
  # Newer Node distributions may omit Corepack; still use the exact official pin.
  pnpm_command=(npm exec --yes --package "$manager" -- pnpm)
fi
echo '==> Installing and building the official runtime (native addons may require make, g++ and Python)'
(cd "$RUNTIME_DIR" && "${pnpm_command[@]}" install --frozen-lockfile && "${pnpm_command[@]}" build)
echo '==> Installing adapter dependencies and bundling unmodified official sources'
(cd "$ROOT" && npm ci && MINIMAX_RUNTIME_DIR="$RUNTIME_DIR" npm run build:official)

cat <<EOF

Official CLI: $RUNTIME_DIR/dist/cli.js
Official plugin: $PLUGIN_DIR/plugins/minimax-ai/minimax-bot

For a MiniMax account, sign in using this exact CLI build:
  node "$RUNTIME_DIR/dist/cli.js" login --region global --no-browser
For BYOK, configure a provider using the official CLI's provider command.

Start:
  MINIMAX_RUNTIME_DIR="$RUNTIME_DIR" \\
  MINIMAX_BOT_MCODE="$RUNTIME_DIR/dist/cli.js" \\
  MINIMAX_BOT_PLUGIN="$PLUGIN_DIR/plugins/minimax-ai/minimax-bot" npm start
EOF
