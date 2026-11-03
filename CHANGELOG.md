# Changelog

## Unreleased

- The update control lives in the Bot page's side rail instead of a separate
  page: it shows the running commit, the one on disk and the remote, and only
  enables updating when `scripts/self-update.sh` says it is safe.
- Updating from the in-page control restarts the host automatically.
- The host ports the official Mini App runner (lifecycle, readiness, port
  authority) from `MiniMax-AI/minimax-code`; `context.agent` remains ours,
  because the open-source runtime does not define it.
