#!/usr/bin/env bash
# Record the upstream commits this host is built against.
#
# Two upstreams matter:
#   plugin  — MiniMax-AI/MiniMax-Code-MiniApps, the MiniMax Bot Mini App itself
#   runtime — MiniMax-AI/minimax-code, whose Mini App runner is ported into
#             src/official-host.mjs
#
# Usage: npm run update-upstream [-- --plugin|--runtime]
# Prints what changed; the caller reviews and commits upstream.lock.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/upstream.lock.json"
WHICH="${1:-both}"

PLUGIN_URL="${MINIMAX_PLUGIN_REPO:-https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git}"
PLUGIN_DIR="${MINIMAX_PLUGIN_DIR:-$ROOT/../MiniMax-Code-MiniApps}"
PLUGIN_PATH="plugins/minimax-ai/minimax-bot"

RUNTIME_URL="${MINIMAX_RUNTIME_REPO:-https://github.com/MiniMax-AI/minimax-code.git}"
RUNTIME_DIR="${MINIMAX_RUNTIME_DIR:-$ROOT/../minimax-code}"
RUNTIME_PATH="packages/local-runtime-v2/src/service/miniapp/process/node-runtime/host-runner.ts"

read_lock() {
  node -e '
    const lock = require(process.argv[1]);
    const key = process.argv[2];
    process.stdout.write(lock[key]?.commit ?? "");
  ' "$LOCK" "$1"
}

write_lock() {
  node - "$LOCK" "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const [file, key, commit, extra] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
lock[key] = { ...lock[key], commit, checkedAt: new Date().toISOString().slice(0, 10), ...(extra ? JSON.parse(extra) : {}) };
fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
NODE
}

if [ "$WHICH" = "both" ] || [ "$WHICH" = "--plugin" ]; then
  [ -d "$PLUGIN_DIR/.git" ] || git clone --depth 1 "$PLUGIN_URL" "$PLUGIN_DIR"
  git -C "$PLUGIN_DIR" fetch --depth 1 origin main
  commit="$(git -C "$PLUGIN_DIR" rev-parse origin/main)"
  version="$(git -C "$PLUGIN_DIR" show "origin/main:$PLUGIN_PATH/.minimax-plugin/plugin.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
  echo "plugin:  $(read_lock plugin) -> $commit ($version)"
  git -C "$PLUGIN_DIR" checkout --detach "$commit"
  write_lock plugin "$commit" "{\"version\":\"$version\",\"repository\":\"MiniMax-AI/MiniMax-Code-MiniApps\",\"path\":\"$PLUGIN_PATH\"}"
fi

if [ "$WHICH" = "both" ] || [ "$WHICH" = "--runtime" ]; then
  [ -d "$RUNTIME_DIR/.git" ] || git clone --depth 1 --filter=blob:none --sparse "$RUNTIME_URL" "$RUNTIME_DIR"
  git -C "$RUNTIME_DIR" fetch --depth 1 origin main
  commit="$(git -C "$RUNTIME_DIR" rev-parse origin/main)"
  echo "runtime: $(read_lock runtime) -> $commit"
  echo
  echo "--- did the upstream runner change since the port? ---"
  if git -C "$RUNTIME_DIR" cat-file -e "origin/main:$RUNTIME_PATH" 2>/dev/null; then
    git -C "$RUNTIME_DIR" show "origin/main:$RUNTIME_PATH" > /tmp/host-runner.latest.ts
    if diff -q "$ROOT/src/vendor/official-host-runner.ts" /tmp/host-runner.latest.ts >/dev/null 2>&1; then
      echo "unchanged since the vendored copy"
    else
      echo "CHANGED: review src/official-host.mjs against /tmp/host-runner.latest.ts"
      diff -u "$ROOT/src/vendor/official-host-runner.ts" /tmp/host-runner.latest.ts | head -60 || true
    fi
  else
    echo "path missing upstream; the port needs a re-check" >&2
  fi
  write_lock runtime "$commit" "{\"repository\":\"MiniMax-AI/minimax-code\",\"source\":\"$RUNTIME_PATH\",\"portedInto\":\"src/official-host.mjs\"}"
fi

echo
echo "Review the diff, then commit upstream.lock.json and restart the host."
