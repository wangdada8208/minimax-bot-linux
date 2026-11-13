# Connect Chief to WeChat

Install the pinned Tencent transport and its OpenClaw peer in a separate directory:

```bash
MINIMAX_BOT_WECHAT_RUNTIME=/var/lib/minimax-bot/wechat-runtime bash scripts/install-wechat.sh
```

Set `MINIMAX_BOT_WECHAT_RUNTIME` to that directory in the host environment. Restart the host, open `/wechat/` on your Bot domain, and sign in with the existing Bot access token. Select the connection button and scan the QR code with WeChat. If WeChat shows a pairing number, enter that number on the connection page.

After confirmation, send a text message to the bound ClawBot in WeChat. The message appears in the existing Chief chat. Chief replies and later team summaries also go to the bound WeChat owner. The connection mirrors new Chief replies from the web chat as well. Existing completed history is excluded when the account is first bound.

The bridge supports text. Use the Bot web page for pictures, voice, files, permission decisions, and questionnaires. A questionnaire notice does not answer or approve anything.

If a send may have reached WeChat but its acknowledgement is lost, the bridge reports an unknown delivery and does not resend it automatically. Check the Bot chat before repeating a request. Reconnect when the connection page reports expired credentials.

## Official components

The bridge imports the unchanged `@tencent-weixin/openclaw-weixin` 2.4.10 QR and message API implementations. OpenClaw 2026.11.3 supplies the SDK imports required by that package. The dependency lock records both packages. The host does not start an OpenClaw Gateway or another model-backed Agent.

MiniMax Code documents WeChat support in its [messaging integration guide](https://code.minimax.io/docs/code/automation/im). The current public Runtime defaults to a stub WeChat SDK and disables channels in the CLI owner. Enabling that channel alone also sends messages to Runtime conversation ingress, which bypasses the Mini App Bot engine.

The added host adapter therefore sends authenticated local HTTP requests to the existing official Bot engine. Chief keeps the same Bot identity, team tools, task dispatch, and stored chat. The adapter watches completed Chief messages independently of the incoming WeChat poll, so delayed team reports can return without another WeChat message. Delivery still depends on WeChat accepting the current context token.

Two designs were checked against official reuse, Chief behavior, restart handling, and implementation scope. Full MiniMax channel reuse requires new Runtime capability and Bot execution interfaces. Direct Tencent transport requires only the host adapter and preserves the existing Bot engine. The second design was selected. Both design reviews used the available model because this environment exposes no other model family. An independent cross-family judge was unavailable.

## Data and access

The connection page requires the existing host access token. The bridge listens on loopback behind the host guard. The scanner's confirmed WeChat user ID is the sole permitted sender. Group messages and other senders are ignored before their context tokens can alter the connection.

The bridge stores account credentials, an incoming-message journal, the receive cursor, and delivery records under the host's private data directory. Its private directory uses mode `0700`, and the state file uses mode `0600`. The login subprocess owns its stdin for WeChat pairing numbers. Shutdown closes that subprocess, the HTTP listener, and the message loops.

Run the bridge checks with `node --test test/wechat-bridge.test.mjs`. Set `MINIMAX_BOT_PLUGIN` and `MINIMAX_BOT_WECHAT_RUNTIME` before running `node --test test/host-wechat.test.mjs` to exercise the actual host and official SDK imports. These tests do not scan an account or send real WeChat messages. Live verification requires the owner to scan and confirm, then exchange a message with Chief.
