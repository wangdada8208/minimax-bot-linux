# Upstream tracking

This project is a **host** for the official MiniMax Bot Mini App. The Bot page,
engine, group chat, memory, schedules and MCP tools come from the upstream
repository. This repository contains none of that code.

- Upstream: <https://github.com/MiniMax-AI/MiniMax-Code-MiniApps>
- Plugin: `plugins/minimax-ai/minimax-bot`
- License: MIT (see the upstream `LICENSE`; the plugin's own `LICENSE` is also MIT)

## The pin

`upstream.lock.json` records exactly which upstream commit this host was tested
with, and the plugin version at that commit:

```json
{ "commit": "...", "pluginVersion": "0.7.15", "checkedAt": "2026-10-29" }
```

The Docker image and `scripts/install.sh` both check out that commit, so a
deployment is reproducible.

## Updating

```sh
npm run update-upstream      # moves the sibling upstream checkout to latest main
```

That script fetches upstream `main`, checks it out detached, and rewrites
`upstream.lock.json` with the new commit and plugin version. Then restart the
host.

A weekly GitHub Action (`.github/workflows/upstream-check.yml`) compares the
pinned plugin version with upstream and opens an `upstream` issue when a newer
one is released — it does not update anything by itself, so a human reviews the
change first.

## Why a host is needed

The official MiniMax Bot runs inside the MiniMax Code **desktop** app for macOS
and Windows. That app starts the plugin, injects `context.agent`, and shows the
page. There is no Linux desktop build. This host does those three jobs on Linux:

- starts `miniapp/node/server.mjs` with a data directory and a loopback port;
- implements `context.agent` with a `mcode acp` process (MiniMax Code **CLI**);
- serves the page behind an access token.

Because it only implements the interfaces documented by the Mini App contract,
upstream plugin updates that do not change those interfaces load without changes
to this host.
