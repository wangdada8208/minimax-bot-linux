# Official source reuse and audit

The policy is to run official implementations unchanged whenever the required
capability exists. Local code is integration between published contracts, Linux
remote access, or the separately requested phone and update features.

## Pinned inputs

`upstream.lock.json` is authoritative for both repositories:

| Input | Official repository | Pinned version |
| --- | --- | --- |
| Bot | [MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps) | 0.7.18, `c4bfe68e12c42a3a8128081ed5238b0689bb03b5` |
| Runtime / CLI | [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | 0.7.2, `6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc` |

The installer checks out these revisions, installs the official workspace using
its package-manager pin, and builds its CLI with the official build script.
It also bundles the required TypeScript exports without modifying their sources.
The generated bundle is committed so ordinary host tests do not need a full
workspace checkout. `src/vendor/official-miniapp.provenance.json` records every
bundle input and SHA-256, the upstream revision, bundler version, and output hash.
The upstream license is retained; bundled dependency legal notices stay in the
bundle, and complete dependency license texts are copied into
`src/vendor/official-miniapp.NOTICES.md`. The official checkout retains its own
license inventory.

## Implementation inventory

Official paths below are relative to the pinned `minimax-code` checkout.

| Responsibility | Actual implementation |
| --- | --- |
| Bot UI, engine, groups, memory, schedules, tasks and team tools | The unchanged MiniApps plugin; no local copies of its business logic |
| Spawn, startup protocol, TCP readiness/deadlines, port retry, root termination and cleanup | Official `createMiniAppNodeRuntimeAdapter` from `packages/local-runtime-v2/src/service/miniapp/process/node-runtime/node-runtime.ts` |
| Frozen context, realpath containment, named start validation, abort/dispose, runner IPC | Official `startMiniAppModule` and `runMiniAppHostRunner` from the adjacent `host-runner.ts` |
| Port ownership | Official `HostMiniAppPortRegistry` from the adjacent `port-registry.ts` |
| Runtime payload materialization and candidate verification | Official `WorkspaceMiniAppStorage`, package readers/digests and MiniApp candidate helpers under `service/plugin-system/plugin/` |
| Agent execution, tools, storage, providers and model controls | The unmodified official `createTuiRuntime` and `TuiRuntimeAdapter`, bundled from the pinned checkout using the official CLI build profile and resources |
| Session transport | Direct official native APIs; no ACP form conversion in the default deployment |
| Team MCP connection | Official `configureSessionMcpServers`, followed by official MCP discovery and invocation; alias `minimax_bot` also works as a JavaScript identifier in `run_code` |
| Model discovery and persistence | Official `McodeProviderApplication.refreshModels` via `scripts/refresh-models.mjs`; this invokes its existing Runtime APIs |
| Model and reasoning selection | Official `listModels` and `selectSessionModel`; a Bot turn does not change the global default |
| Questionnaire execution | Official persisted native requests, `getPendingQuestionnaire`, `replyQuestionnaire` and `watchSessionTurn`; original identity, mode, payload and expiry preserved |
| Optional browser policy | Official Custom Agent canonical configuration denies `request_feature_enable`, preserving `ask_user`; builtin files remain unchanged |

`src/official-host.mjs` is now glue calling the official process adapter, not a
rewrite of its lifecycle. `src/official-runner.mjs` uses the official runner's
`start` and `loadModule` extension seams to add the Bot's Agent capability.
The official implementation selects ports in 49152–65535; this host follows that
policy instead of supplying an independently rewritten free-port algorithm.

## Necessary compatibility boundaries

1. **Agent context.** The audited public `MiniAppStartContext` has no `agent`
   member; the Bot consumes one. Its API declarations in MiniApps are types, not
   an implementation. A small adapter supplies `run`, `answer`, `reply` and
   `models` through the official native Runtime APIs. This finding is limited to the
   pinned source trees; it does not prove any desktop code is closed source.
2. **Manifest generations.** The pinned Runtime reader rejects the Bot's
   `agentAccess` and `surface.window` additions. The bridge validates the supported
   Agent declaration and projects those integration fields out of an in-memory
   view before invoking the original official validators. Both source trees and
   the materialized payload remain unchanged; original bytes are hashed.
3. **Remote HTTP.** The requested Linux domain needs a page credential, reverse
   proxy and compression. The official process runtime's startup token establishes
   runner readiness; it is not that remote browser credential.
4. **Phone protocol.** `src/mobile-bridge.mjs` implements the separately requested
   third-party `/api/mobile/v1` contract over the official Bot HTTP API. This
   protocol has no implementation in the audited official trees.
5. **Repository updater.** `src/host-update.js`, `src/self-update.mjs` and
   `scripts/self-update.sh` implement the requested in-page update of this Linux
   host repository. They do not replace the official plugin/CLI update services.

The multi-generation plugin publication supervisor remains available in the
upstream source. This deployment starts one pinned Bot process using the official
process adapter and attaches its MCP endpoint using the official native session
API. The embedded official Runtime owns its normal plugin manager.

## Corrections to earlier documentation

Earlier statements that the CLI ignores `session/new.mcpServers`, does not read
project `.mcp.json`, lacks questionnaire support, or has no model management APIs
were incorrect. The source and official tests demonstrate all four capabilities.

ACP HTTP `headers` are an array of `{name,value}` pairs. Configuration-file HTTP
headers are an object. Confusing these two boundaries caused a local adapter bug.
The old fallback that rewrote the user's global MCP configuration has been
removed; Bot sessions carry their own live endpoint. A stale test endpoint also
pointed at another application and was not evidence of missing MCP support.

The previous model registration code cloned an unrelated configuration and
restarted a shared Agent process. It has been removed. Selection now requires an
officially advertised value; refresh new provider models using the official
application before starting/restarting the service. Endpoint rows that are not
configured are explicitly labelled rather than silently given invented settings.

The former ACP bridge lost original questionnaire IDs, modes, payload and expiry,
and kept answer continuations only in memory. It is no longer the default.
`src/native-agent.mjs` consumes official persisted requests and observes official
continuation turn IDs, including after Runtime restart. The `acp` backend remains
an explicit diagnostic option with those limitations.

Builtin Agent sessions retain their original tool policy. When future work first
uses the managed Custom Agent, the adapter creates an official new session,
retains the original session unchanged and carries transcript text as historical
reference; prior tools are not replayed. The latest official standing-context block
is restored as current Bot identity, including `caller_bot_id`, so dispatched tasks
remain linked to the caller for automatic result delivery. Up to 1,000 messages are read; histories
over 200,000 characters use the first message and latest 40 messages. Existing
genuine questionnaires remain on their original session until answered. A legacy
pending Browser Use enable request is explicitly declined during migration;
Browser Use remains disabled. Real tool permissions and user questions remain.

The official dispatcher keeps `waiting_for_user` batches open until answered;
only then can it relay completion and wake the caller. Do not replace this with
an invented successful result. Phone notifications now consume structured
questionnaire metadata rather than treating `chat.pending` as a running turn.

The native build produces `dist/bot-native.mjs` beside the official CLI. It reuses
the official module-location profile, build flags, dependency externals and the
existing official Worker/WASM/resource closure. Source loading alone is insufficient:
`run_code` needs the built QuickJS Worker beside the stable CLI entry. Native
provenance records 5,842 input hashes and the official artifact closure in
`src/vendor/official-native.provenance.json`; no worker path is patched.

## Rebuild and updates

```sh
./scripts/install.sh
MINIMAX_RUNTIME_DIR="$PWD/../minimax-code-official" npm run build:official
npm test
npm run update-upstream                 # inspect both candidates; no checkout/pin changes
npm run update-upstream -- --runtime
npm run update-upstream -- --plugin
```

The weekly action compares complete upstream revisions, including changes that
keep the same version number, and opens an issue. It does not deploy candidates.
Review a candidate, edit the pin, build both the CLI and generated bundle, inspect
provenance, and validate before committing the pin and generated files together.
Do not hand-edit generated vendor output or patch the official source to make an
integration test pass.
