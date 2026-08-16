# dsh-frontend-tools-bridge

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-frontend-tools-bridge)](https://www.npmjs.com/package/dsh-frontend-tools-bridge)

前端工具桥的 dsh 侧：一个仅监听回环地址的 WebSocket 服务，让任意数量的已连接应用把自己私有的工具镜像注册到 `ctx.tools` 上，每个应用占据独立的命名空间。工具的真实实现只存在于应用（浏览器渲染进程、Web 应用、Node 进程）——本桥接插件不含任何业务知识；它把模型调用转发给持有的应用并返回其结果。应用侧的对应件是 [`dsh-frontend-tools-client`](../client/README.md)。

## 功能

插件启动一个绑定 `127.0.0.1` 的 `WebSocketServer`（绑定非回环地址会把模型的工具访问暴露给本地网络；握手 KEY 是客户端身份，不是网络边界）。认证依托客户端名单：应用自行生成 DSH KEY（客户端 SDK 产出 64 位十六进制），用户在对话中把它登记到某个命名空间——KEY 因此兼任客户端身份，凭证的生命周期归应用自己掌管。连接先完成 `hello` 握手（协议版本、key）；服务端以 `welcome` 应答并回显绑定的命名空间。每个命名空间同一时刻只允许一个会话——第二个连接呈交已被占据的命名空间时收到 `duplicate_connection` 拒绝；持有者断开后，其镜像工具被注销、在途调用被拒绝，该命名空间立即接受替代连接。不同命名空间的客户端并发连接，互相看不见对方的工具。

注册以 `register` 批次为单位、整批生效或整批拒绝：批次内任一工具校验失败或名称冲突，整批以非致命的 `invalid_tool` 错误拒绝，客户端可修正定义后再次发送 `register`。每个被接受的工具以公开名 `<namespace>__<rawName>`（沿用 `mcp-client` 契约）出现在 `ctx.tools` 上：名称被规范化到模型函数名字母表 `[A-Za-z0-9_-]` 与 64 字符预算内；凡规范化造成损失的名称都会追加 12 个十六进制字符的 SHA-256 身份哈希，确保不同的客户端名称永不合并。会使整桥超过 `maxTools` 上限的批次以非致命的 `too_many_tools` 错误拒绝。`unregister` 批次按原始名移除工具，并以实际移除的原始名应答（未知名被忽略），释放的公开名可在同一连接上再次注册。

模型调用以 `call` 帧转发给持有会话的连接，帧携带客户端的原始工具名（公开名绝不回传）；promise 在收到匹配的 `callResult` 时落定，在调用方通过 `exec.signal` 中止时拒绝，连接断开或 `callTimeoutMs` 期限内无应答时同样拒绝。被放弃或已超时调用的迟到 `callResult` 会被丢弃，不影响会话。结果渲染为格式化 JSON 文本；客户端未声明输出 schema 时默认为任意 JSON。

## 写操作人工审核

工具的读写分类来自应用自己的声明：以 `readOnly: true` 注册的工具只读；其余工具（安全默认）一律是写操作。桥安装一个覆盖镜像工具与自身管理工具的 `tools/pre-execute` 监听器：只读工具与其他插件拥有的工具原样放行，而每次写调用返回 `{ kind: 'ask' }`——DSH 官方的人工审核渠道。只有 `allowed-once` 的批准才把调用转发给应用；用户拒绝、取消、或部署环境未挂载审核通道（例如无头运行）都会自动拒绝——这是管线的 fail-closed 契约，同时在会话日志上产生成对的 `approval/asked` / `approval/decided` 审计事件。用户看到的审批卡片携带理由 `前端工具写操作 "<namespace>.<rawName>"` 与已流式呈现的调用参数；批准是一次性的，每次写调用都会再次询问。

管理工具按同样规则分类：`frontend_tools_list_clients` 只读；`frontend_tools_register_client` 与 `frontend_tools_revoke_client` 为写——`register` 有意如此，否则模型可能把用户粘贴的 KEY 换成另一把，悄悄把命名空间交给另一个应用。

存活探测每 15 秒发送一个 `ping` 帧；下一个探测到期时仍未应答的探测会终止会话（`close` 路径负责完整的清理链：注销工具、拒绝在途调用、接受替代连接）。

## 管理工具

接入一个应用的日常方式是对话，而不是改配置。凭证归应用所有：应用生成 DSH KEY（客户端 SDK 的 `generateClientKey`）并展示给用户，用户把它交给模型，模型通过 `ctx.tools` 上的管理工具完成登记。

- `frontend_tools_register_client(namespace, key)` — 把应用提供的 DSH KEY 登记到该命名空间并持久化，返回 `{ namespace, url, replaced }`；输出绝不回显 KEY（用户消息里已有，多一份副本只会扩大会话日志的暴露面）。对同一命名空间重复登记会立即替换旧凭证（旧 KEY 随即失效）；已绑定其他命名空间的 KEY 会被视为身份冲突而拒绝，不符合 64 位十六进制格式的 KEY 同样被拒绝。
- `frontend_tools_list_clients()` — 列出全部名单条目（静态与登记）为 `{ namespace, connected, toolCount }`；输出中绝不出现 KEY。
- `frontend_tools_revoke_client(namespace)` — 一步移除登记的凭证并断开其活跃连接，被吊销的客户端无法继续供给工具。

登记的凭证持久化在状态目录下的 `frontend-tools-clients.json`（POSIX 权限 600），桥重启后依然有效。静态配置的客户端（见下文 `staticClients`）归 `cordis.yml` 所有：它们与登记条目一样认证（其 KEY 为自由格式字符串，由配置掌管），但拒绝 `register` 与 `revoke`——这两个工具会把配置指为应修改之处。

## 配置

五个 `Config` 字段，加载时校验：

- `port` — 监听的回环端口（默认 `31870`）。
- `callTimeoutMs` — 单次转发调用的期限（默认 `30000`）；迟到的 `callResult` 以超时错误拒绝模型侧 promise 并被丢弃。
- `maxTools` — 全部已连接客户端合计可镜像的工具数上限（默认 `200`，是防滥用护栏而非语义限制）。单一全局上限防止并发的应用挤爆模型的工具清单。
- `staticClients` — 可选的静态 `{ namespace, key }` 条目，加载时与持久化名单合并；面向测试与声明式部署。命名空间或 KEY 与持久化名单冲突会在加载时大声失败。
- `stateDir` — 存放已登记客户端名单文件的目录；默认为 harness 状态主目录（`~/.dsh`，可经 `DSH_HOME` 覆盖）。

加载时名单为空是合法状态：登记一次应用生成的 DSH KEY（`frontend_tools_register_client`）即可接入第一个应用。绑定失败（例如端口被占用）与名单文件损坏都会让插件加载失败，而不是留下一个死掉的服务。销毁时关闭监听、终止全部会话、注销全部镜像工具（含管理工具）并拒绝在途调用。

## 协议

版本 5，仅文本帧，JSON 编码。客户端 → 服务端：`hello`、`register`、`unregister`、`callResult`、`pong`。服务端 → 客户端：`welcome`、`registered`、`unregistered`、`call`、`ping`、`error`。`hello` 帧只携带 KEY——命名空间来自名单绑定，并在 `welcome` 中回显。v5 为每个注册工具规格新增可选的 `readOnly` 标志（即上文写操作审核的分类依据）；v4 及更旧的对端在握手时被拒绝。畸形帧与阶段违规（例如握手前发送 `register`）以 `invalid_message` 应答并关闭连接。权威的消息与错误码定义位于 [`dsh-frontend-tools-client`](../client/README.md)（其 `src/protocol.ts`）；本包作为依赖消费它们，两侧不可能漂移。

## 导出形状

命名空间插件：导出 `name` / `inject` / `Config` / `apply`，无默认导出。`BridgeServer`、`MirrorRegistry`、`CallDispatcher`、`ClientRoster`、`registerAdminTools` 同样导出，供复用与测试；线上协议本身由 client 包导出。

## Model Experience

间接产生——经由本包镜像到 `ctx.tools` 的、由应用声明的工具 schema；已连接的应用拥有它注册的每一个 schema、描述与结果。

#### KV Cache effect

两次注册事件之间，镜像 schema 集合保持稳定，与任何 `ctx.tools` 注册一样跟随可复用的请求前缀。客户端注册、追加 `register` 或 `unregister` 批次、以及注销工具的断开都会改变可见工具集，从而从该点起替换请求前缀；单个转发结果作为普通工具调用结果追加，不会使更早的条目失效。

## Known Limitations and Deferred Work

- **每命名空间单一会话** — 第二个呈交绑定到被占命名空间 KEY 的连接以 `duplicate_connection` 拒绝；不支持把多个连接多路复用到一个命名空间。
- **没有重连租约** — 服务端不为重连客户端缓冲或重放注册；由客户端 SDK 的自动重连负责重发工具清单。
- **结果仅渲染为 JSON 文本** — 转发值一律渲染为格式化 JSON；展示意图（`terminal`、`diff`、`locations`）推迟。
