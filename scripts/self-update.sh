#!/usr/bin/env bash
# Update this host from its own GitHub repository, safely.
#
# Called by the web page's update button (through the host) and usable by hand.
# Two modes:
#   check   report whether a newer commit exists and whether updating is safe
#   apply   fast-forward to it, install deps, and leave a restart pending
#
# It never force-updates. Local edits, a dirty tree, a detached HEAD, or a
# branch that has diverged all make `apply` refuse with a reason the page shows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-check}"
BRANCH="${MINIMAX_BOT_BRANCH:-main}"
cd "$ROOT"

emit() {
  # One JSON object per run so the caller can parse it without a schema.
  node -e '
    const payload = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(payload) + "\n");
  ' "$1"
}

fail() {
  emit "$(node -e '
    process.stdout.write(JSON.stringify({ ok: false, reason: process.argv[1] }));
  ' "$2")"
  exit 1
}

git rev-parse --git-dir >/dev/null 2>&1 || fail no-git "This deployment is not a git checkout, so it cannot self-update."

current="$(git rev-parse HEAD)"
branch_now="$(git rev-parse --abbrev-ref HEAD)"

# Local changes would be clobbered by a fast-forward, so they block updating.
dirty="$(git status --porcelain --untracked-files=no | head -5)"

# Fetch quietly; a network failure must not look like "up to date".
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  fail no-network "Could not reach the git remote."
fi
remote="$(git rev-parse "origin/$BRANCH")"

ahead=0
behind=0
if git merge-base --is-ancestor "$current" "$remote" 2>/dev/null; then
  behind="$(git rev-list --count "$current..$remote")"
else
  if git merge-base --is-ancestor "$remote" "$current" 2>/dev/null; then
    ahead="$(git rev-list --count "$remote..$current")"
  else
    fail diverged "This checkout has diverged from origin/$BRANCH, so it will not be updated automatically."
  fi
fi

# What a human would read in the update notice.
if [ "$behind" != "0" ]; then
  subjects="$(git log --format='%h %s' "$current..$remote" | head -20)"
else
  subjects=""
fi

blocked=""
if [ "$branch_now" != "$BRANCH" ]; then
  blocked="Not on branch $BRANCH (currently on $branch_now)."
elif [ -n "$dirty" ]; then
  blocked="Local changes are present, so updating would conflict."
elif [ "$ahead" != "0" ]; then
  blocked="This checkout has $ahead local commit(s) that are not on origin/$BRANCH."
fi

if [ "$MODE" = "check" ]; then
  emit "$(node -e '
    const [current, remote, behind, ahead, subjects, blocked] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: "check",
      current,
      remote,
      behind: Number(behind),
      ahead: Number(ahead),
      updateAvailable: Number(behind) > 0,
      canUpdate: blocked === "",
      blockedReason: blocked || null,
      commits: subjects ? subjects.split("\n").filter(Boolean) : [],
    }));
  ' "$current" "$remote" "$behind" "$ahead" "$subjects" "$blocked")"
  exit 0
fi

if [ "$MODE" != "apply" ]; then
  fail bad-mode "Unknown mode: $MODE"
fi

if [ -n "$blocked" ]; then
  fail blocked "$blocked"
fi

if [ "$behind" = "0" ]; then
  emit "$(node -e '
    process.stdout.write(JSON.stringify({ ok: true, mode: "apply", changed: false, current: process.argv[1] }));
  ' "$current")"
  exit 0
fi

# Payload-free fast-forward: refuse anything that would need a merge.
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  fail ff-failed "Fast-forward failed; the checkout was left unchanged."
fi

updated="$(git rev-parse HEAD)"

# Dependencies changed? Install them before the restart so the new code can boot.
if git diff --name-only "$current" "$updated" | grep -qE '^(package\.json|package-lock\.json)$'; then
  if ! npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1; then
    git reset --hard --quiet "$current"
    fail deps-failed "Dependency install failed; the checkout was rolled back."
  fi
fi

# Rebuild native exports before restarting when their build contract changes.
# The official source revision must already match the lock; never silently patch
# or advance that checkout from the page updater.
if [ -f scripts/build-official.mjs ] && git diff --name-only "$current" "$updated" | grep -qE '^(upstream\.lock\.json|scripts/build-official\.mjs|src/native-agent\.mjs|src/runtime-compatibility\.mjs|src/official-runner\.mjs)$'; then
  if ! npm run build:official >/dev/null 2>&1; then
    git reset --hard --quiet "$current"
    fail runtime-build-failed "Official runtime build failed; the checkout was rolled back. Run scripts/install.sh to prepare the pinned official build."
  fi
fi

emit "$(node -e '
  const [before, after] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ ok: true, mode: "apply", changed: true, from: before, to: after, restartRequired: true }));
' "$current" "$updated")"
