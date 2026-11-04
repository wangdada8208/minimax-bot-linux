# Changelog

## Unreleased

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
