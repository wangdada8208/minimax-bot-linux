# Changelog

## Unreleased

- Replace the default ACP Agent bridge with unmodified official native Runtime
  exports, using the official CLI build profile and Worker/WASM/resource closure.
- Preserve native questionnaire identity, mode, payload and expiry; recover answers
  after a full host restart and observe the exact official continuation turn.
- Use the official Custom Agent denylist for optional feature enablement while
  preserving normal user questions. Migrate legacy sessions without deleting
  history or replaying tools, and restore official standing Bot identity.
- Use a JavaScript-safe MCP alias and preserve caller identity so `run_code` can
  dispatch tasks that automatically relay results and wake the caller.
- Fix waiting-question notifications, cancelled-form filtering, and runtime-build
  preparation before an in-page host update.

- Replace the rewritten runner, readiness/retry and port registry with unmodified
  official source exports, including the real process adapter, IPC runner,
  payload materialization, digests and termination handling.
- Build the pinned official CLI from source in the installer and Docker path;
  bundle provenance and dependency licenses accompany generated runtime code.
- Fix ACP MCP header arrays and attach the live team endpoint to new and resumed
  sessions. Remove the global profile MCP rewrite.
- Select models and reasoning effort using the official session controls. Remove
  cloned YAML model templates and per-turn shared-process restarts. Refresh models
  through the official provider application.
- Map official ACP form elicitation into the Bot questionnaire/answer interface.
- Fix the mobile bridge upstream port and make a dead plugin terminate the guard
  so the watchdog can recover the deployment.
- Correct earlier unsupported claims about CLI MCP, project config, models,
  questionnaires and the source availability of desktop components.
- Preserve the requested in-page host updater and third-party phone protocol.
