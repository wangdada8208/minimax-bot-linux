# Linux 上的 MiniMax Bot

[英文](README.md) | 简体中文

这是官方 MiniMax Bot 的 Linux 宿主。本仓库只包含宿主。Bot 页面、引擎和插件都来自上游仓库，这里不修改、也不重新分发：

**上游仓库：** [MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps)

**上游插件：** [`plugins/minimax-ai/minimax-bot`](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/minimax-ai/minimax-bot)

上游仓库使用 MIT 许可证。插件和协议仍归上游所有。这个宿主只负责启动上游插件，并提供桌面端原本会注入的 Agent 接口。

桌面端通常做三件事，这个程序取代它们：

- 启动 `miniapp/node/server.mjs`，分配数据目录和端口；
- 注入 `context.agent`，Bot 只有拿到它才能进行一轮对话；
- 在自带浏览器窗口里打开 `/bot` 页面。

这里的 `context.agent` 是一个 `mcode acp` 进程。每个 Bot 对话是一个 ACP 会话。MiniMax Code 要求的工具批准会显示在 Bot 页面上，选择**允许一次**或**拒绝**就会回答该请求。页面、群聊、记忆、定时任务和 MCP 工具都是未修改的上游插件。

## 环境要求

- Linux（x86_64 或 arm64），VPS 或家里的服务器都可以
- Node.js 22.19 或更新版本
- 一个 MiniMax 账号。Bot 通过 MiniMax Code CLI 运行，用的是你自己的账号，需要执行一次 `mcode login`。

## 用 Docker 快速部署

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux

docker compose build
docker compose run --rm minimax-bot mcode login --no-browser   # 中国大陆账号加 --region cn
docker compose up -d
docker compose logs -f        # 打印带访问令牌的页面地址
```

数据在 `./data`，CLI 登录信息在 `./minimax-home`。compose 只绑定 `127.0.0.1:8787`，对外访问前请自己加一层带登录的 HTTPS 反向代理。

## 不用 Docker 快速部署

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux
./scripts/install.sh          # 安装依赖、mcode CLI 和锁定版本的上游插件
mcode login --region global --no-browser
MINIMAX_BOT_PLUGIN="$PWD/../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot" npm start
```

中国大陆账号把 `--region global` 换成 `--region cn`。如果要使用自己的 OpenAI 兼容模型目录，设置 `MINIMAX_BOT_MODELS_URL` 和 `MINIMAX_BOT_MODELS_API_KEY`。密钥只从环境变量读取，本仓库不会写入密钥。

进程会打印类似 `http://127.0.0.1:8787/bot?token=...` 的地址。打开后会写入 HttpOnly cookie 并跳转到 `/bot`。令牌保存在 `~/.minimax-bot/access-token`。没有令牌的请求返回 `401`。

第一条消息会启动 `mcode acp`。在完成 `mcode login` 之前，进程没有可用模型，回复会失败；页面仍然能打开，Bot、群聊和记忆也可以创建。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MINIMAX_BOT_HOST` | `127.0.0.1` | 受令牌保护的页面监听地址 |
| `MINIMAX_BOT_PORT` | `8787` | 页面监听端口 |
| `MINIMAX_BOT_DATA` | `~/.minimax-bot` | Bot 状态、消息、记忆、头像和附件 |
| `MINIMAX_BOT_CWD` | 当前目录 | 每个 Bot 会话可以读写的工作目录 |
| `MINIMAX_BOT_MCODE` | `mcode` | MiniMax Code CLI 可执行文件。以 `.js` 结尾的路径会用 `MINIMAX_BOT_NODE` 运行，默认是启动宿主的 Node，避免 `#!/usr/bin/env node` 去 PATH 里查找解释器。 |
| `MINIMAX_BOT_PLUGIN` | 旁边的 `MiniMax-Code-MiniApps` 仓库 | 上游官方插件目录 |
| `MINIMAX_BOT_TOKEN` | 从 `access-token` 读取 | 覆盖已保存的页面令牌 |

请把 `MINIMAX_BOT_HOST` 绑定到 `127.0.0.1`，再通过带登录的反向代理访问。每一轮都可以使用 `MINIMAX_BOT_CWD` 里的文件和 shell，所以不要把端口直接公开到网络。

## 让它常驻

宿主就是一个普通的长驻进程。放在服务器上时，建议注册成系统服务，崩溃或重启后会自动拉起：

```sh
sudo cp deploy/minimax-bot.service /etc/systemd/system/
sudo cp deploy/minimax-bot.env.example /etc/minimax-bot.env   # 然后改成你的路径
sudo systemctl daemon-reload
sudo systemctl enable --now minimax-bot
```

没有 systemd 时，运行 `scripts/watchdog.sh --daemon`，进程退出后会自动重启。

## 跟踪上游

本宿主锁定在一个上游提交上，记录在 [`upstream.lock.json`](upstream.lock.json)（目前是 MiniMax Bot **0.7.15**）。Docker 镜像和安装脚本都会检出这个确切的提交，所以部署结果可复现。

```sh
npm run update-upstream      # 把锁定版本推进到上游 main 最新
```

每周一次的 GitHub Action 会对比锁定版本和上游；上游出新版本时自动开一个带 `upstream` 标签的 issue。详见 [UPSTREAM.md](UPSTREAM.md)。

## 与桌面端的差别

- ACP 不返回桌面端的问卷对象。模型提出的问题会以文本回到对话，而不是页面内的表单。
- Bot 设置里的模型选择器使用 `MINIMAX_BOT_MODELS_URL` 提供的目录。选中的模型会在每一轮开始前应用到该 Bot 的 ACP 会话。如果模型服务不接这个模型，回合仍然会失败。思考档位会随选择保存；ACP 应用模型和变体，思考控制仍由它自己的会话保留。
- 桌面端创建的会话在 CLI 中不存在。拷贝过来的 Bot 数据保留历史和记忆，下一条消息会开启一个新的 CLI 会话。
- 插件自己的 MCP 服务还没有接回 `mcode`，所以 Bot 暂时不能通过 CLI 调用 `message_bot` 等工具。群聊回复仍然由页面自己的引擎驱动。

## 测试

```sh
npm test
```

测试使用假的 ACP 进程，不会调用 MiniMax。
