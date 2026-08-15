# dsh-frontend-tools

English | [中文](#中文)

> Bridge web/Electron/Tauri/Node applications to [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) agents in real time — expose your app's frontend tools to AI agents over a loopback WebSocket.

## What is this?

dsh-frontend-tools is a two-package project that lets any JavaScript application (browser page, Electron renderer, Tauri app, Node process) register its own functions as tools available to a DSH agent, and receive real-time tool calls from the agent back to the application.

- **[dsh-frontend-tools-bridge](packages/bridge/README.md)** — DSH plugin: runs a loopback WebSocket server inside DSH. Mirrors registered application tools onto `ctx.tools` and forwards model calls back. Supports multiple applications simultaneously via KEY-based namespace isolation.
- **[dsh-frontend-tools-client](packages/client/README.md)** — Application SDK: connects to the bridge, registers tools, handles incoming calls. Zero runtime dependencies beyond platform `WebSocket`.

```
┌─────────────────────┐    WebSocket (127.0.0.1)    ┌──────────────────────┐
│   Your Application  │  ─────────────────────────▶  │   DSH + Bridge       │
│                     │  ◀─────────────────────────  │   (dsh-frontend-     │
│  - generate KEY     │   register tools / calls    │    tools-bridge)     │
│  - register tools   │                              │   - multi-app by KEY │
│  - execute calls    │                              │   - admin tools      │
└─────────────────────┘                              └──────────────────────┘
```

## Quick start

### 1. Install the bridge plugin in DSH

In your DSH `cordis.yml`, add:

```yaml
plugins:
  - import: dsh-frontend-tools-bridge
    config:
      port: 31870          # optional, default 31870
      maxTools: 200        # optional, total tool budget across all apps
```

Then install the package:

```bash
pnpm add dsh-frontend-tools-bridge
```

### 2. Install the client SDK in your application

```bash
npm install dsh-frontend-tools-client
# or pnpm / yarn
```

### 3. Connect your app

```ts
import { createFrontendToolsClient, generateClientKey } from 'dsh-frontend-tools-client'

// Generate a KEY once, persist it (localStorage or similar)
const key = localStorage.getItem('dsh-key') ?? generateClientKey()
localStorage.setItem('dsh-key', key)

const client = createFrontendToolsClient({ url: 'ws://127.0.0.1:31870', key })
await client.connect()

// Register a tool
await client.registerTools([{
  name: 'get_current_page',
  description: 'Get information about the current page the user is viewing.',
  parametersSchema: { type: 'object', properties: {} },
  async execute() {
    return { url: location.href, title: document.title }
  },
}])
```

### 4. Register the KEY with DSH

1. In your app, display the DSH KEY to the user (use `buildClientKeyClipboardText()` for a ready-to-paste format).
2. The user pastes it into a DSH conversation.
3. The model calls `frontend_tools_register_client` to register the KEY against a namespace.
4. Done — your app's tools are now live in the agent's tool list.

See [dsh-frontend-tools-client](packages/client/README.md) for full SDK documentation and [dsh-frontend-tools-bridge](packages/bridge/README.md) for bridge configuration, admin tools, and protocol details.

## Development

```bash
pnpm install
pnpm run build       # build both packages
pnpm run typecheck   # type-check all sources
pnpm run test        # run 166 unit tests
```

## License

MIT

---

<a id="中文"></a>
# 中文

> 通过回环 WebSocket 将 Web/Electron/Tauri/Node 应用实时桥接到 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Agent —— 将你的前端工具暴露给 AI Agent。

## 这是什么？

dsh-frontend-tools 是一个双包项目，让任意 JavaScript 应用（浏览器页面、Electron 渲染进程、Tauri 应用、Node 进程）将自己的函数注册为 DSH Agent 可用的工具，并实时接收来自 Agent 的工具调用。

- **[dsh-frontend-tools-bridge](packages/bridge/README.md)** — DSH 插件：在 DSH 内启动回环 WebSocket 服务。将应用注册的工具镜像到 `ctx.tools`，并将模型调用转发回去。通过 KEY 命名空间隔离支持多应用同时连接。
- **[dsh-frontend-tools-client](packages/client/README.md)** — 应用端 SDK：连接桥接、注册工具、处理入站调用。除平台 `WebSocket` 外零运行时依赖。

## 快速开始

### 1. 在 DSH 中安装桥接插件

在 DSH 的 `cordis.yml` 中添加：

```yaml
plugins:
  - import: dsh-frontend-tools-bridge
    config:
      port: 31870
      maxTools: 200
```

然后安装：

```bash
pnpm add dsh-frontend-tools-bridge
```

### 2. 在应用中安装客户端 SDK

```bash
npm install dsh-frontend-tools-client
```

### 3. 连接应用

```ts
import { createFrontendToolsClient, generateClientKey } from 'dsh-frontend-tools-client'

const key = localStorage.getItem('dsh-key') ?? generateClientKey()
localStorage.setItem('dsh-key', key)

const client = createFrontendToolsClient({ url: 'ws://127.0.0.1:31870', key })
await client.connect()

await client.registerTools([{
  name: 'get_current_page',
  description: '获取用户当前正在浏览的页面信息',
  parametersSchema: { type: 'object', properties: {} },
  async execute() {
    return { url: location.href, title: document.title }
  },
}])
```

### 4. 在 DSH 中登记 KEY

1. 应用展示 DSH KEY 给用户（使用 `buildClientKeyClipboardText()` 生成可直接粘贴的文本）
2. 用户粘贴到 DSH 对话中
3. 模型调用 `frontend_tools_register_client` 将 KEY 登记到命名空间
4. 完成 — 应用的工具已出现在 Agent 工具列表中

## License

MIT
