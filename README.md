# MiniMax Bot on Linux

English | [简体中文](README.zh-CN.md)

Linux host for the official MiniMax Bot. This repository contains only the host.
The Bot page, engine, and plugin come from the upstream repository and are not
modified or redistributed here:

**Upstream:** [MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps)

**Upstream plugin:** [`plugins/minimax-ai/minimax-bot`](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/minimax-ai/minimax-bot)

The upstream repository is licensed under MIT. Its plugin and protocol remain
upstream's. This host only starts that plugin and supplies the Agent interface
that the desktop app normally supplies.

The desktop app normally does three things this program replaces:

- it starts `miniapp/node/server.mjs` and gives it a data directory and a port;
- it injects `context.agent`, which is the only way a Bot can take a turn;
- it shows the page at `/bot` in its own browser window.

Here `context.agent` is one `mcode acp` process. Each Bot conversation is an ACP session. Tool approvals asked by MiniMax Code appear on the Bot page, and choosing **Allow once** or **Deny** answers that ACP permission request. The page, group chats, memory, schedules, and the MCP tools are the official plugin, unchanged.

## Requirements

- Linux (x86_64 or arm64), a VPS or home server is fine
- Node.js 22.19 or newer
- A MiniMax account. The Bots run through the MiniMax Code CLI, which signs in
  with your own account; you need to run `mcode login` once.

## Quick start with Docker

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux

docker compose build
docker compose run --rm minimax-bot mcode login --no-browser   # use --region cn for mainland China
docker compose up -d
docker compose logs -f        # prints the page URL with its access token
```

State is in `./data`, the CLI login is in `./minimax-home`. The compose file
binds `127.0.0.1:8787`, so put your own HTTPS reverse proxy with a login in
front before exposing it.

## Quick start without Docker

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux
./scripts/install.sh          # installs deps, the mcode CLI, and the pinned plugin
mcode login --region global --no-browser
MINIMAX_BOT_PLUGIN="$PWD/../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot" npm start
```

Use `--region cn` for a mainland China account. A custom OpenAI-compatible
model catalog can be supplied with `MINIMAX_BOT_MODELS_URL` and
`MINIMAX_BOT_MODELS_API_KEY`; the key is read from the environment and is never
written by this repository.

The process prints a URL such as `http://127.0.0.1:8787/bot?token=...`. Opening
it sets an HttpOnly cookie and redirects to `/bot`. The token is remembered in
`~/.minimax-bot/access-token`. Requests without it get `401`.

The first message starts `mcode acp`. Until `mcode login` has been completed,
that process has no model and the reply fails; the page itself still loads, and
Bots, groups, and memory can be created.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINIMAX_BOT_HOST` | `127.0.0.1` | Address the guarded page listens on |
| `MINIMAX_BOT_PORT` | `8787` | Port the guarded page listens on |
| `MINIMAX_BOT_DATA` | `~/.minimax-bot` | Bot state, messages, memory, avatars, uploads |
| `MINIMAX_BOT_CWD` | current directory | Workspace every Bot session can read and modify |
| `MINIMAX_BOT_MCODE` | `mcode` | MiniMax Code CLI executable. A path ending in `.js` is run with `MINIMAX_BOT_NODE` (defaults to the Node running the host), which avoids a `PATH` lookup inside the `#!/usr/bin/env node` shim. |
| `MINIMAX_BOT_PLUGIN` | sibling `MiniMax-Code-MiniApps` checkout | Official plugin directory |
| `MINIMAX_BOT_TOKEN` | read from `access-token` | Overrides the saved page token |

Bind `MINIMAX_BOT_HOST` to `127.0.0.1` and reach it through an authenticated reverse proxy. Each turn can use files and a shell inside `MINIMAX_BOT_CWD`, so do not publish the port directly.

## Keep it running

The host is a normal long-running process. On a server, run it as a service so it restarts after a crash or reboot:

```sh
sudo cp deploy/minimax-bot.service /etc/systemd/system/
sudo cp deploy/minimax-bot.env.example /etc/minimax-bot.env   # then edit the paths
sudo systemctl daemon-reload
sudo systemctl enable --now minimax-bot
```

Without systemd, `scripts/watchdog.sh --daemon` restarts the host whenever it exits.

## Upstream tracking

This host is pinned to one upstream commit, recorded in
[`upstream.lock.json`](upstream.lock.json) (currently MiniMax Bot **0.7.15**).
The Docker image and the installer both check out that exact commit, so a
deployment is reproducible.

```sh
npm run update-upstream      # move the pin to the latest upstream main
```

A weekly GitHub Action compares the pin with upstream and opens an `upstream`
issue when a newer Bot version is released. See [UPSTREAM.md](UPSTREAM.md).

## What is different from the desktop app

- ACP does not return the desktop questionnaire object. A question from the model arrives as text instead of the in-page form.
- The Bot settings model picker lists the Magpie catalog from `MINIMAX_BOT_MODELS_URL`. The selected model is applied to that Bot's ACP session before each turn. A model Magpie does not route still fails when the turn starts. Reasoning level is stored with the choice; ACP applies the model and variant, while its own session keeps the reasoning control.
- Sessions created by the desktop app do not exist in the CLI. Copied Bot data keeps its history and memory, and the next message starts a new CLI session.
- The plugin's own MCP server is not yet connected back to `mcode`, so a Bot cannot call tools such as `message_bot` through the CLI. Group replies are still driven by the page's own engine.

## Tests

```sh
npm test
```

The tests use a fake ACP process. They do not call MiniMax.
