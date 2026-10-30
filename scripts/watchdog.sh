#!/usr/bin/env bash
# Keep the host running without systemd. Restarts it a few seconds after it exits.
# Usage: scripts/watchdog.sh [--daemon]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${MINIMAX_BOT_LOG:-$HOME/.minimax-bot/host.log}"
mkdir -p "$(dirname "$LOG")"

if [ "${1:-}" = "--daemon" ]; then
  setsid nohup "$0" >>"$LOG" 2>&1 </dev/null &
  echo "watchdog started (pid $!)"
  exit 0
fi

while true; do
  node "$ROOT/src/host.mjs" >>"$LOG" 2>&1
  code=$?
  echo "$(date -Is) host exited (code $code); restarting in 3s" >>"$LOG"
  sleep 3
done
