# Linux 上的 MiniMax Bot

[English](README.md) | 简体中文

在 Linux 服务器运行官方 MiniMax Bot，并从另一台电脑打开页面。页面、引擎、团队工具、群聊、记忆和定时任务直接使用未修改的 [MiniMax-Code-MiniApps 官方插件](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/minimax-ai/minimax-bot)；CLI 和插件进程生命周期直接使用 [minimax-code 官方源码](https://github.com/MiniMax-AI/minimax-code)。两个官方仓库的源文件都不修改。

本仓库只保留 Bot 与 ACP 之间必要的接口适配、远程 HTTP 访问，以及另行要求的手机协议和页面内宿主更新功能。官方 Runtime 直接构建、打包和调用，不再重写其实现。完整复用清单、锁定版本、源码哈希和兼容边界见 [UPSTREAM.md](UPSTREAM.md)。

## 环境要求

- Linux；Node.js 22.19+（22.x）、24.2+（24.x）、25 或 26。
- Git、npm；有 Corepack 时优先使用，没有时通过 npm 运行官方锁定的 pnpm 版本。
- 原生扩展没有预编译文件时需要 Python、make、C++ 编译器。Debian/Ubuntu 可执行 `apt-get install python3 make g++`。
- MiniMax 账号或已配置的兼容 BYOK 提供商。BYOK 不要求登录 MiniMax 账号。

## 从官方源码安装

```sh
git clone https://github.com/wangdada8208/minimax-bot-linux.git
cd minimax-bot-linux
./scripts/install.sh

# MiniMax 账号登录；大陆账号改用 --region cn。
node ../minimax-code-official/dist/cli.js login --region global --no-browser
npm start
```

安装器检出 [upstream.lock.json](upstream.lock.json) 锁定的两个提交，运行官方 CLI 构建脚本，再打包未修改的官方 Runtime 导出。上游工作区有本地修改时拒绝覆盖。默认运行旁边官方源码构建出来的 CLI，不再使用另一份独立安装的 npm 版本。

BYOK 使用官方 CLI 的 `provider` 命令配置。先配置、发现模型，再启动服务。需要刷新已保存提供商的完整目录时，可以直接调用官方提供商应用（示例提供商 ID）：

```sh
cd ../minimax-code-official
TSX_TSCONFIG_PATH="$PWD/tsconfig.standalone.json" node \
  --import ./node_modules/tsx/dist/loader.mjs \
  ../minimax-bot-linux/scripts/refresh-models.mjs custom_provider:magpie --apply
```

这里调用官方发现、合并、版本检查和保存逻辑，保留已有模型，不切换默认模型。刷新后重启宿主。每轮对话不会再复制其他模型配置或重启共享 Agent 进程。Magpie 兼容目录明确公布思考档位时，可加 `--sync-reasoning`，把服务端声明的档位通过官方保存 API 写入；不按模型名称猜测能力。

## Docker

```sh
docker compose build
docker compose run --rm minimax-bot mcode login --region global --no-browser
docker compose up -d
docker compose logs -f
```

镜像也从锁定源码构建官方 CLI，打包同一批官方 Runtime 导出。Bot 数据在 `./data`，账号和提供商数据在 `./minimax-home`。Compose 绑定 `127.0.0.1:8787`，远程访问通过自己的 HTTPS 反向代理。

仓库提供 Docker 构建路径；Linux 本机源码运行通过，不等于 Docker 和所有 CPU 架构都已完成验证。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MINIMAX_BOT_HOST` | `127.0.0.1` | 远程页面监听地址 |
| `MINIMAX_BOT_PORT` | `8787` | 远程页面端口 |
| `MINIMAX_BOT_DATA` | `~/.minimax-bot` | 官方 Bot 状态和历史 |
| `MINIMAX_BOT_CWD` | 当前目录 | Agent 工作目录 |
| `MINIMAX_RUNTIME_DIR` | 旁边的 `minimax-code-official` | 官方源码和构建目录 |
| `MINIMAX_BOT_MCODE` | 上述目录的 `dist/cli.js` | 指定官方 CLI 入口或可执行文件 |
| `MINIMAX_BOT_NODE` | 宿主使用的 Node | 官方子进程和 `.js` CLI 使用的 Node |
| `MINIMAX_BOT_PLUGIN` | 旁边 MiniApps 的 Bot 目录 | 未修改的官方插件 |
| `MINIMAX_BOT_TOKEN` | 已保存的 `access-token` | 远程浏览器凭证 |
| `MINIMAX_BOT_MODELS_URL` | 不设置 | 可选的模型目录元数据 |
| `MINIMAX_BOT_MODELS_API_KEY` | 不设置 | 目录凭证，仅留在服务器环境里 |

打开启动时打印的 `/bot?token=...` 地址，会写入 HttpOnly cookie 并跳转到 `/bot`；未认证的私有请求返回 401。CLI 的数据目录遵循官方配置，包括 `MINIMAX_DATA_DIR`、`MAVIS_DATA_DIR` 和 profile；宿主不再重写其全局 MCP 文件。

## 哪些由官方负责

官方进程适配器负责物化运行载荷、预留端口、启动 IPC runner、就绪检测、端口冲突重试，以及关闭时确认进程退出。小型引导模块通过官方 `loadModule` 扩展点提供 `context.agent`：本次审计的公开 runner context 没有该成员，而 Bot 需要它。

子进程中的官方 ACP 进程处理 Bot 会话。新建和恢复会话都按官方 ACP 契约携带团队 MCP 端点；模型和思考档位使用官方会话实际公布的选项；官方 ACP 表单问答映射到 Bot 页面。ACP 没传输的部分 Bot 问卷元数据不会凭空补造，具体限制见 [UPSTREAM.md](UPSTREAM.md)。

锁定 Runtime 的清单校验器早于 Bot 的 `agentAccess` 和 `surface.window` 字段。适配层只在内存校验视图里处理这两个字段，并提供声明的 Agent 能力；原清单和运行载荷字节不变。它不等于完整桌面宿主。

## 常驻与更新

可使用 [systemd 服务](deploy/minimax-bot.service)、[环境变量示例](deploy/minimax-bot.env.example)，或 `scripts/watchdog.sh --daemon`。

页面注入的更新按钮对本宿主仓库执行快进更新，发现本地修改冲突时明确拒绝，然后交给 watchdog 重启。它和接受新的官方源码锁定版本是两件事。检查上游候选变化：

```sh
npm run update-upstream
```

每周工作流监测两个官方仓库的完整提交，包括版本号没变的源码更新，并创建 issue。接受候选前审阅变化、构建官方产物并验证。

## 验证

```sh
npm test
MINIMAX_BOT_PLUGIN="$PWD/../MiniMax-Code-MiniApps/plugins/minimax-ai/minimax-bot" npm test
```

测试覆盖 ACP 契约、问卷继续执行、模型选择、并发会话互不打断、真实官方子进程的生命周期和失败清理、端口重试、手机协议以及更新拒绝。设置插件变量后还会启动真实 Bot，并通过手机桥接读取其数据。模型服务和跨 Bot 派单需要另外进行在线验收。
