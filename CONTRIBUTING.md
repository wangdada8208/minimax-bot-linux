# Contributing

Thanks for helping. This repository is the Linux **host** for the official
MiniMax Bot. Bug reports, deployment fixes, and documentation are welcome.

## Scope

- In scope: the host (`src/`), deployment files (`deploy/`, `Dockerfile`,
  `docker-compose.yml`), scripts, and docs.
- Out of scope: the Bot page, engine, group chat, memory, and MCP tools. Those
  live upstream; report their bugs at
  <https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/issues>.

## Before opening a pull request

```sh
npm install
npm test
node --check src/host.mjs && node --check src/agent.mjs
bash -n scripts/install.sh scripts/update-upstream.sh scripts/watchdog.sh
```

Keep a pull request to one concern. Do not commit real tokens, API keys, or a
`~/.minimax` login.

## Updating the pinned upstream version

```sh
npm run update-upstream
```

Commit `upstream.lock.json` together with a short note on what changed. CI also
runs a weekly upstream check that opens an issue when a newer Bot is released.
