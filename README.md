# MiniMax Bot on Linux

English | [简体中文](README.zh-CN.md)

Run the official MiniMax Bot on a Linux server and open its page from another
computer. The Bot UI, engine, team tools, groups, memory and schedules come from
[MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/minimax-ai/minimax-bot), unchanged.
The CLI and process lifecycle come directly from
[MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code).
Both upstream source trees remain unmodified on disk. The native bundle has one
explicit compatibility fix across three source modules: an Agent that denies
optional Browser Use enablement receives accurate disabled guidance instead of an
instruction to call the denied tool. This exception is hash-checked and recorded
in provenance; browser admission and authorization checks remain intact.

This repository supplies the necessary Bot-to-native-Runtime compatibility bridge, remote
HTTP access, and the separately requested phone protocol and in-page host updater.
The official runtime is built/bundled, not reimplemented. See
[UPSTREAM.md](UPSTREAM.md) for the complete implementation inventory, exact pins,
source provenance, and remaining compatibility limits.

## Requirements

- Linux and a supported Node.js: 22.19+ on 22.x, 24.2+ on 24.x, 25 or 26.
- Git and npm. The installer uses Corepack when available, otherwise npm runs
  the exact pnpm version declared by the official repository.
- Native addon prerequisites when prebuilt binaries are unavailable: Python,
  make and a C++ compiler. On Debian/Ubuntu: `apt-get install python3 make g++`.
- A MiniMax account, or a configured compatible BYOK provider. BYOK does not
  require MiniMax account sign-in.

## Install from official source

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux
./scripts/install.sh

# For a MiniMax account; use --region cn for a mainland China account.
node ../minimax-code-official/dist/cli.js login --region global --no-browser
npm start
```

The installer checks out both revisions in [upstream.lock.json](upstream.lock.json),
runs the official CLI build, and regenerates the official runtime bundle. It
refuses to overwrite edits in either upstream checkout. The default CLI is the
sibling source build, not an independently installed npm version.

For BYOK, use the official CLI's `provider` commands. Configure and discover models
before starting the service. To refresh a saved provider through the official
provider application (example provider ID):

```sh
cd ../minimax-code-official
TSX_TSCONFIG_PATH="$PWD/tsconfig.standalone.json" node \
  --import ./node_modules/tsx/dist/loader.mjs \
  ../minimax-bot-linux/scripts/refresh-models.mjs custom_provider:magpie --apply
```

This calls the official discovery/save implementation, preserves saved models,
and does not switch the default model. Restart the host after refreshing the
configured catalog. No per-turn configuration cloning or shared-process restart
is performed. For a Magpie-compatible catalog that explicitly publishes reasoning
levels, add `--sync-reasoning` to translate those declared levels through the
official candidate-save API; the adapter does not guess capabilities from names.

## Docker

```sh
docker compose build
docker compose run --rm minimax-bot mcode login --region global --no-browser
docker compose up -d
docker compose logs -f
```

The image builds the pinned official CLI from source and bundles the same official
runtime exports. State is in `./data`; account/provider data is in `./minimax-home`.
Compose binds `127.0.0.1:8787`; use your HTTPS reverse proxy for remote access.
Docker build support is provided, but a Linux source-build test is not evidence
that Docker or every CPU architecture has been validated.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINIMAX_BOT_HOST` | `127.0.0.1` | Remote access listener address |
| `MINIMAX_BOT_PORT` | `8787` | Remote access port |
| `MINIMAX_BOT_DATA` | `~/.minimax-bot` | Official Bot state and history |
| `MINIMAX_BOT_CWD` | current directory | Agent workspace |
| `MINIMAX_RUNTIME_DIR` | sibling `minimax-code-official` | Official source/build root |
| `MINIMAX_BOT_MCODE` | the source root's `dist/cli.js` | Override official CLI entry or executable |
| `MINIMAX_BOT_NODE` | the host's Node executable | Node used for the official process and `.js` CLI |
| `MINIMAX_BOT_PLUGIN` | sibling MiniApps Bot directory | Unchanged official plugin |
| `MINIMAX_BOT_TOKEN` | saved `access-token` | Remote browser credential |
| `MINIMAX_BOT_MODELS_URL` | unset | Optional provider metadata/discovery catalog |
| `MINIMAX_BOT_MODELS_API_KEY` | unset | Catalog credential, kept in the server environment |

Open the printed `/bot?token=...` URL. It sets an HttpOnly cookie and redirects to
`/bot`. Unauthenticated private requests return 401. The CLI's own data directory
follows official configuration (`MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR`, or profile
selection); the host does not rewrite its global MCP file.

## What runs where

The official process adapter materializes the runtime payload, reserves a port,
starts the official IPC runner, checks readiness, retries port conflicts, and
proves process termination on shutdown. A small bootstrap supplies `context.agent`
through the runner's supported `loadModule` seam; this Agent interface is absent
from the audited public runner context but required by the Bot.

The child directly loads official `createTuiRuntime` and native session APIs.
MCP configuration and per-session model selection use official controls without
changing the global model preference. Native questionnaires retain original IDs,
mode, payload and expiry; their persisted requests and official continuation turns
can be recovered after Runtime restart.

An official Custom Agent disables optional `request_feature_enable` while keeping
normal `ask_user` available. Future work in legacy builtin sessions migrates to
that Agent, preserving the original session and bringing transcript text as
historical reference, without replaying old actions. Genuine pending questions
remain on their original sessions; a legacy Browser Use enable request is declined.
History bounds are recorded in [UPSTREAM.md](UPSTREAM.md). Phone notifications now
recognize structured waiting questionnaires instead of suppressing them as busy.

The official dispatcher intentionally keeps a batch open while a child waits for
an answer. Open the child from Tasks → Waiting to answer; this host preserves that
completion policy.

The pinned Runtime manifest reader predates the Bot's `agentAccess` and
`surface.window` fields. The compatibility bridge projects those fields out of
an in-memory validation view and supplies the requested Agent capability; original
manifest and payload bytes stay unchanged. This is not a complete desktop host.

## Keep it running and update

Use [the systemd unit](deploy/minimax-bot.service),
[the environment example](deploy/minimax-bot.env.example), or
`scripts/watchdog.sh --daemon`.

The injected update control updates this host repository with a fast-forward,
refuses conflicting local changes, and requests a watchdog restart. It is separate
from accepting a new upstream source pin. Inspect upstream changes with:

```sh
npm run update-upstream
```

The weekly action watches both complete upstream revisions and opens an issue.
Review changed pins, rebuild official artifacts and validate them before deploy.

## Validation

```sh
npm test
MINIMAX_BOT_PLUGIN="$PWD/../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot" npm test
```

Tests exercise ACP contracts, questionnaire continuation, model selection,
concurrent-session safety, the actual official child lifecycle/failures/port
retry, mobile translation and update refusal. Setting the plugin variable also
boots the real Bot package and reads its data through the phone bridge. Model
service calls and live cross-Bot dispatch require separate acceptance checks.
