# Upstream tracking

This project is a **host** for the official MiniMax Bot Mini App. The Bot page,
engine, group chat, memory, schedules and MCP tools come from the MiniApps
repository. The Mini App runner this host uses comes from the runtime
repository. This repository contains neither.

Two upstreams matter:

| | Repository | What this host takes from it |
| --- | --- | --- |
| **plugin** | [MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps) | `plugins/minimax-ai/minimax-bot` — the whole Mini App, loaded unchanged |
| **runtime** | [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | `startMiniAppModule` from `packages/local-runtime-v2/.../node-runtime/host-runner.ts`, ported into `src/official-host.mjs` |

Both are MIT. The plugin and its protocol stay upstream's; the runtime port keeps
upstream's flow and is credited in the file header.

## Why the runtime is ported rather than imported

`minimax-code` is a TypeScript workspace. Its runner imports `@mavis/*` packages
and the Mini App contracts from the same workspace, so it cannot be imported
from a plain Node process the way this host runs.

The port keeps the parts that decide behaviour:

- resolve the package root and the entry, refuse an entry outside the package
  (`ENTRY_OUTSIDE_ARTIFACT`);
- refuse a module without a `start` export (`START_EXPORT_MISSING`);
- hand the plugin a frozen context;
- abort the signal, then await `dispose`, and refuse a `start` result without
  `dispose` (`RUNNER_LIFECYCLE_INVALID`).

**The one deliberate difference is the `agent` field.** Upstream's context has
`pluginId`, `pluginRoot`, `dataDir`, `generationId`, `listen`, `signal`,
`logger` and `hostConnector` — no `agent`. A Mini App that declares
`agentAccess` (MiniMax Bot does) cannot take a turn without one, and the
open-source runtime never defines it. This host supplies it from a `mcode acp`
process. Everything else in the file follows upstream.

`src/vendor/official-host-runner.ts` is a byte copy of the upstream source at the
pinned commit, kept only so the weekly check can tell when the port needs
revisiting.

## The pin

`upstream.lock.json` records both commits:

```json
{
  "plugin":  { "commit": "...", "version": "0.7.18", "checkedAt": "..." },
  "runtime": { "commit": "...", "source": "...host-runner.ts", "portedInto": "src/official-host.mjs" }
}
```

The Docker image and `scripts/install.sh` check out the pinned plugin commit, so
a deployment is reproducible.

## Updating

```sh
npm run update-upstream              # both
npm run update-upstream -- --plugin  # the MiniMax Bot plugin only
npm run update-upstream -- --runtime # the runtime port only
```

For the plugin it moves the sibling checkout to upstream `main` and rewrites the
pin. For the runtime it prints a diff between the vendored copy and upstream, so
you can see whether `src/official-host.mjs` needs work.

A weekly GitHub Action (`.github/workflows/upstream-check.yml`) watches both:
it opens an `upstream` issue when the plugin version moves, and a separate one
when `host-runner.ts` no longer matches the vendored copy. It never updates
anything by itself — a human reviews first.

## Why a host is needed at all

The official MiniMax Bot runs inside the MiniMax Code desktop app (macOS and
Windows). That app starts the plugin, injects `context.agent`, and shows the
page. There is no Linux desktop build. This host does those three jobs on Linux:

- starts `miniapp/node/server.mjs` with a data directory and a loopback port;
- supplies `context.agent` from a `mcode acp` process (MiniMax Code CLI);
- serves the page behind an access token.

## What is reused, and what cannot be

Checked against `minimax-code` at the pinned runtime commit:

| Part of this host | Official code exists? | What this host does |
| --- | --- | --- |
| Plugin lifecycle (`start`, frozen context, abort then `dispose`) | Yes — `startMiniAppModule` in `host-runner.ts` | Ported verbatim into `src/official-host.mjs` |
| Readiness (the port must accept a connection after `start`) | Yes — `connectMiniAppPort` in `node-runtime.ts` | Ported; a timeout disposes the plugin and reports `READINESS_TIMEOUT` |
| Port authority (reserve the loopback port before spawning, retry the next candidate on `EADDRINUSE`) | Yes — `HostMiniAppPortRegistry` in `port-registry.ts`, driven by `prepareRuntime` | Ported; a reservation is released on failure and on `stop` |
| Connector tools (`hostConnectorAccess`) | Yes, but **optional**: only used when a Mini App declares `hostConnectorAccess` in its manifest | Not ported — MiniMax Bot does not declare it and never calls `context.hostConnector` (verified by search over the whole plugin) |
| Multi-generation supervisor (lease, prepare/commit/rollback across runtime generations) | Yes — `supervisor/` | Not ported — this host runs one pinned plugin version and restarts to change it |
| ACP framing, request/response matching, notifications | Yes — `@agentclientprotocol/sdk`, as upstream uses it in `packages/tui/src/acp/stdio.ts` | `src/acp.mjs` is a thin wrapper over that SDK |
| `context.agent` (running a turn) | **No** — the open-source context has no `agent` field, and the desktop host that supplies it is not in this repository | Written here: `src/agent.mjs` drives `mcode acp` |
| Team tools (`list_team`, `message_bot`, `dispatch_tasks`…) | Yes, but the CLI only loads MCP servers from `<dataDir>/mcp.json` — not from the ACP session | `src/host.mjs` publishes the plugin's live `/mcp/minimax-bot` URL there on every boot |
| Model catalog for the Bot settings picker | **No** — `providers/list` is not implemented by the CLI at the pinned version | Written here: `src/models.mjs` reads an OpenAI-compatible `/models` endpoint |
| Phone bridge (`/api/mobile/v1`) | **No** — no `api/mobile` route exists upstream | Written here: `src/mobile-bridge.mjs`, a third-party app protocol |
| Page access token | **No** — upstream's token is the runner's own readiness token, not a page credential | Written here: `src/token.mjs` |

The four rows marked **No** are the honest scope of this host: they are host
duties the official open-source runtime does not perform, not re-implementations
of code that already exists.
