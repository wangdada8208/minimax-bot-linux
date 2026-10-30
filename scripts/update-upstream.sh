#!/usr/bin/env bash
# Move the pinned upstream plugin to the latest commit on upstream main,
# then record the new commit and plugin version in upstream.lock.json.
# Run from anywhere; it works on a sibling checkout of the upstream repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="${MINIMAX_UPSTREAM_REPO:-https://github.com/MiniMax-AI/MiniMax-Code-MiniApps.git}"
UPSTREAM_DIR="${MINIMAX_UPSTREAM_DIR:-$ROOT/../MiniMax-Code-MiniApps}"
PLUGIN_REL="plugins/minimax-ai/minimax-bot"

if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  echo "Cloning $UPSTREAM_URL into $UPSTREAM_DIR"
  git clone "$UPSTREAM_URL" "$UPSTREAM_DIR"
fi

git -C "$UPSTREAM_DIR" fetch --depth 1 origin main
commit="$(git -C "$UPSTREAM_DIR" rev-parse origin/main)"
version="$(git -C "$UPSTREAM_DIR" show "origin/main:$PLUGIN_REL/.minimax-plugin/plugin.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"

git -C "$UPSTREAM_DIR" checkout --detach "$commit"

node - "$ROOT/upstream.lock.json" "$commit" "$version" <<'NODE'
const fs = require('node:fs');
const [file, commit, version] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
lock.commit = commit;
lock.pluginVersion = version;
lock.checkedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`pinned ${lock.repository}@${commit.slice(0, 7)} (plugin ${version})`);
NODE

echo "Restart the host to load the new plugin."
