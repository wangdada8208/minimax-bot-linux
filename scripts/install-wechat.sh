#!/usr/bin/env bash
# Install the official Tencent transport and its real OpenClaw peer separately.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${MINIMAX_BOT_WECHAT_RUNTIME:-$ROOT/.wechat-runtime}"
mkdir -p "$TARGET"
TARGET="$(realpath "$TARGET")"
if [ -e "$TARGET/package.json" ] && ! cmp -s "$ROOT/integrations/wechat/package.json" "$TARGET/package.json"; then
  echo "Refusing to overwrite another runtime manifest: $TARGET/package.json" >&2
  exit 1
fi
cp "$ROOT/integrations/wechat/package.json" "$TARGET/package.json"
cp "$ROOT/integrations/wechat/package-lock.json" "$TARGET/package-lock.json"
npm ci --prefix "$TARGET" --ignore-scripts --no-audit --no-fund
printf 'Set MINIMAX_BOT_WECHAT_RUNTIME=%s in the host environment, then restart.\n' "$TARGET"
