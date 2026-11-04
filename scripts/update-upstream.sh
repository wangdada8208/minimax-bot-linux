#!/usr/bin/env bash
# Inspect candidates without moving a running checkout or silently advancing pins.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHICH="${1:-both}"
case "$WHICH" in both|--plugin|--runtime) ;; *) echo 'Usage: update-upstream.sh [--plugin|--runtime]' >&2; exit 2 ;; esac
inspect() {
  local key="$1" directory="$2" repository="$3"
  local pinned latest
  pinned="$(node -p "require('$ROOT/upstream.lock.json').$key.commit")"
  if [ ! -d "$directory/.git" ]; then
    echo "$key checkout missing; run scripts/install.sh first: $directory" >&2
    exit 1
  fi
  git -C "$directory" fetch origin main
  latest="$(git -C "$directory" rev-parse FETCH_HEAD)"
  echo "$key: $pinned -> $latest"
  git -C "$directory" diff --stat "$pinned" "$latest"
  echo "Review: https://github.com/$repository/compare/$pinned...$latest"
}
if [ "$WHICH" = both ] || [ "$WHICH" = --plugin ]; then
  inspect plugin "${MINIMAX_PLUGIN_DIR:-$ROOT/../MiniMax-Code-MiniApps}" MiniMax-AI/MiniMax-Code-MiniApps
fi
if [ "$WHICH" = both ] || [ "$WHICH" = --runtime ]; then
  inspect runtime "${MINIMAX_RUNTIME_DIR:-$ROOT/../minimax-code-official}" MiniMax-AI/minimax-code
fi
cat <<'EOF'

Inspection complete. The running sources and pins are unchanged.
After reviewing a candidate, edit upstream.lock.json, run scripts/install.sh,
run the adapter tests and live team-tool checks, then commit the pin together
with the rebuilt official bundle and provenance. Do not patch upstream sources.
EOF
