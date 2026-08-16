# dsh-frontend-tools-client

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-frontend-tools-client)](https://www.npmjs.com/package/dsh-frontend-tools-client)

前端工具桥的应用侧：把一个应用（浏览器渲染进程、Web 应用或 Node 进程）连接到 [`dsh-frontend-tools-bridge`](../bridge/README.md) 的 WebSocket 服务，并把应用私有的工具暴露给模型。应用保留带完整权限的真实实现——本 SDK 只单向携带注册、反向携带转发调用。

## 功能

`createFrontendToolsClient({ url, key })` 返回一个客户端，持有一条连接和一个工具注册表。凭证归应用自己掌管：用 `generateClientKey()` 生成一次 DSH KEY 并持久化（例如存入 `localStorage`），展示给用户——`buildClientKeyClipboardText({ namespace, key, appName })` 生成推荐的复制文本——由用户在对话中经 `frontend_tools_register_client` 管理工具把它登记到应用的命名空间。KEY 就是客户端的全部身份：握手只呈交 KEY，服务端在 `welcome` 中回显绑定的命名空间——`connect()` 落定后可从 `client.namespace` 读取。`registerTools(tools)` 发送一个 `register` 批次，并按注册顺序以桥注册出的模型侧公开名（`<namespace>__<name>`）落定；`unregisterTools(names)` 按原始名移除工具，并以桥实际移除的原始名落定（未知名被忽略）。传入的 `call` 帧按原始名称分发到对应工具的 `execute`；落定结果——值，或结构化的 `{ code, message }` 失败——作为一条 `callResult` 回传。服务端的 `ping` 存活探测由 SDK 自动以 `pong` 应答。

每个工具都带一个可选的 `readOnly` 标志。`readOnly: true` 声明该工具只读取状态、从不修改——调用不设限。省略该标志（或 `false`）即标记为写操作：桥在转发每次调用之前，会把决定权交给 DSH 的人工审核渠道（`tools/pre-execute` → `ask`）；只有 `allowed-once` 的批准才放行调用，拒绝、取消或缺少审核通道都会以拒绝收场。默认即为写（安全兜底）：未声明的工具按会修改状态对待。

抛出的 `FrontendToolsError` 保留其 code 与 message（模型应当读到的权限拒绝用 `code: 'denied'`，例如"未登录"）；其他抛出的错误以 `internal` 连同错误文本呈现。未知工具名应答 `unknown_tool`。

## 运行时要求

除平台 `WebSocket`（浏览器与 Node 22+ 都内置）外没有运行时依赖。可透过 `socket` 注入构造函数用于测试或替代传输。连接呈现四种状态——`connecting`、`connected`、`disconnected`、`reconnecting`——经 `onStateChange` 监听器广播。已建立的会话断开后按指数退避自动重试（1 秒起倍增至 30 秒），恢复后自动重注册客户端仍持有的全部工具，模型侧视图无需应用代码即自行恢复；一次性脚本可传 `reconnect: false` 快速失败。连接断开或超时会让待定的 `registerTools` / `unregisterTools` 调用以 `disconnected` 错误落定。显式 `disconnect()` 后客户端即终结——重连需新建客户端。

## 最小示例

```ts
import { createFrontendToolsClient, generateClientKey } from 'dsh-frontend-tools-client'

// Generate once, persist (localStorage or similar), and show the DSH KEY to
// the user — they register it with the dsh bridge through a conversation.
const key = localStorage.getItem('dsh-key') ?? generateClientKey()
localStorage.setItem('dsh-key', key)
const client = createFrontendToolsClient({ url: 'ws://127.0.0.1:31870', key })
await client.connect()
console.log(client.namespace) // the namespace the bridge bound to this key
const names = await client.registerTools([{
  name: 'echo',
  description: 'Echo the provided message back.',
  parametersSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  readOnly: true, // reads only — runs without approval; omit for WRITE tools
  async execute(args: unknown) { return { echoed: (args as { message?: unknown }).message } },
}])
```

可运行的 echo 演示见 [`demo/echo.ts`](demo/echo.ts)。工具名必须匹配 `^[a-z0-9_-]{1,40}$`；DSH KEY 必须匹配 `^[0-9a-f]{64}$`（用 `generateClientKey` 生成）；命名空间必须匹配 `^[A-Za-z0-9_-]{1,32}$`，在用户登记 KEY 时选定，不由客户端声明。

## 导出形状

纯模块（非 Cordis 插件）：`createFrontendToolsClient`、`generateClientKey`、`buildClientKeyClipboardText`、`BridgeConnection`、`ToolExecutor`、`FrontendToolsError`，以及两侧共享的权威线上协议（`parseServerMessage`、`parseClientMessage`、`encodeClientMessage`、`encodeServerMessage`、消息类型）——桥接插件作为依赖消费这些定义，两个包不可能漂移。应用可以直接内嵌或经打包器使用。

## Model Experience

无。本包完全运行在宿主应用进程内；一切模型可见的注册均由桥接插件持有。

#### KV Cache effect

本 SDK 不接触任何模型请求；其唯一流量是与桥之间的回环 WebSocket。本包中的任何改动都不会使任何模型请求前缀失效或延长。

## Known Limitations and Deferred Work

- **注册与注销确认按顺序耦合** — 并发的 `registerTools` / `unregisterTools` 调用按发送顺序落定（协议没有按批次关联的 id）；需要确定性批次的应用应逐个等待每次调用完成后再发送下一个。
- **恢复后的重注册名未确认** — 重连后的自动重注册不等待桥的 `registered` 确认，会话即恢复可用；若被拒绝（例如公开名被占用），问题在下一次交互时才会显现。
