# Native Runtime validation

Validated on the deployed Linux host on 2026-11-05 (Asia/Taipei). Official MiniApps
and Runtime pins remain unchanged; neither official source tree was edited.

## Original failure

The reported Chief delegation reached its recipient. The recipient requested
optional Browser Use enablement and entered `waiting_for_user`; the official
queue correctly kept that batch open. The old ACP adapter hid the original
questionnaire mode/identity and kept continuation callbacks only in memory.
Declining the optional enable request did not perform the original business task.
A finished state with an empty body was not accepted as successful execution.

## Automatic task execution and result return

The real Chief called the official batch dispatch tool with its caller identity,
then ended its turn. It did not poll `get_tasks` to obtain the result.

| Official task | Recipient | Evidence |
| --- | --- | --- |
| `task_c38f6ac564b7` | Subscription manager | Actual Bash execution located Browser Harness and ran its doctor; returned a live local connection diagnosis and a nonempty result |
| `task_32feccd9f98c` | Server manager | Actual Bash execution returned Node `v24.22.0` and OS `Linux` |

Both tasks became `done`. Official batch `batch_0cd8308aa644` appended its result
relay to Chief's chat, then automatically started Chief's summary turn. That turn
contained `NATIVE-CHIEF-RESULT`. Recipient tool events, result bodies, relay and
caller summary were checked, rather than relying on task receipt or status alone.
No web navigation, credential lookup, configuration changes or optional feature
enablement were requested by this test.

A further test used an ordinary request to Chief, without spelling out tool aliases
or caller IDs: ask the model-proxy Bot to execute `uname -s` and report back. Task
`task_3360ad547c94` completed, official relay `msg_result_batch_4a06faa0dac2`
reached Chief, and Chief reported the actual `Linux` output with exit status 0.

## Full host restart while a delegated task waits

Official task `task_30f9c6b24188` asked a genuine `ask_user` question and entered
`waiting_for_user`. Its original request was
`ask_945a67dfa0b64f19b3aaf7c6`, attached to assistant message
`msg_ef344a492e7c`.

After the host became idle, the listener-owning process was verified and stopped,
and the entire host/plugin/Runtime restarted. The original task and question
survived. Submitting the synthetic Continue choice continued the same task,
executed `node --version`, and returned `NATIVE-QUESTION-WORKER-DONE` with
`v24.22.0`. Official batch `batch_1b4c257b942f` relayed that result and automatically
woke Chief, which returned `NATIVE-QUESTION-CHIEF-DONE` without polling.

An additional direct Runtime restart test also preserved a real questionnaire's
original ID and resumed the model response after an answer.

## Build and regression evidence

- The native bundle uses the official CLI module-location profile, externals and
  build flags. The official QuickJS Worker loaded its WASM and evaluated a smoke
  program returning `42`.
- Source/artifact provenance covers the native entry, workers and resource closure.
- Final regression run: **83 tests passed, 0 failed, 0 skipped**, including a real
  plugin/host startup with its own isolated Runtime profile.
- Regression tests cover native streaming, per-session models, raw questionnaires,
  restart recovery, exact continuation IDs, concurrent Bot sessions, cancellation,
  permissions, legacy migration/identity, phone notifications and official process
  lifecycle/readiness/port retry.
- The source checkouts retain their pinned commits and clean tracked files.

## Boundaries

The official dispatcher intentionally waits for genuine user answers. This host
does not fabricate completed results, auto-enable optional features, or replay
historical tasks with unknown outcomes. Old failed, cancelled or empty-result tasks
remain historical records; the original proxy business task is not claimed as
completed by these transport tests. Docker was not tested on this host.
