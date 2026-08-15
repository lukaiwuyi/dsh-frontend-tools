# dsh-frontend-tools-client

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-frontend-tools-client)](https://www.npmjs.com/package/dsh-frontend-tools-client)

The application half of the frontend tools bridge: connect an application (browser renderer, web app, or Node process) to the [`dsh-frontend-tools-bridge`](../bridge/README.md) WebSocket server and expose the application's own tools to the model. The application keeps the real implementations with their full permissions — this SDK only carries registrations one way and forwarded calls the other.

## What it does

`createFrontendToolsClient({ url, key })` returns one client owning one connection and one tool registry. The application owns its credential: generate a DSH KEY once with `generateClientKey()`, persist it (for example in `localStorage`), show it to the user — `buildClientKeyClipboardText({ namespace, key, appName })` renders the recommended copy block — and have them register it against the application's namespace through the `frontend_tools_register_client` admin tool. The key is the client's whole identity: the handshake presents only the key and the server's `welcome` echoes the bound namespace back — read it from `client.namespace` after `connect()` resolves. `registerTools(tools)` sends one `register` batch and resolves with the model-facing public names (`<namespace>__<name>`) the bridge registered, in registration order; `unregisterTools(names)` removes tools by raw name and resolves with the raw names the bridge actually removed (unknown names are ignored). Incoming `call` frames dispatch by raw name to the matching tool's `execute`; the settled outcome — value, or a structured `{ code, message }` failure — travels back as one `callResult`. Server `ping` liveness probes are answered with `pong` automatically.

A thrown `FrontendToolsError` keeps its code and message (use `code: 'denied'` for permission refusals the model should read, for example "not logged in"); any other thrown error surfaces as `internal` with the error text. Unknown tool names answer `unknown_tool`.

## Runtime requirements

No runtime dependencies beyond the platform `WebSocket` (browsers and Node 22+ both provide it). A constructor can be injected through `socket` for tests or alternative transports. The connection reports four states — `connecting`, `connected`, `disconnected`, `reconnecting` — through `onStateChange` listeners. An established session that drops is retried automatically with exponential backoff (1s doubling to 30s) and every tool the client still holds is re-registered after recovery, so the model's view restores itself without application code; pass `reconnect: false` for one-shot scripts that should fail fast. A dropped or timed-out connection settles pending `registerTools` / `unregisterTools` calls with `disconnected` errors. After an explicit `disconnect()` the client is final — create a new one to reconnect.

## Minimal usage

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
  async execute(args: unknown) { return { echoed: (args as { message?: unknown }).message } },
}])
```

A runnable echo demo lives in [`demo/echo.ts`](demo/echo.ts). Tool names must match `^[a-z0-9_-]{1,40}$`; DSH KEYs `^[0-9a-f]{64}$` (generate with `generateClientKey`); namespaces `^[A-Za-z0-9_-]{1,32}$` and are chosen at registration time (by the user in the conversation), not by the client.

## Export shape

A plain module (no Cordis plugin): `createFrontendToolsClient`, `generateClientKey`, `buildClientKeyClipboardText`, `BridgeConnection`, `ToolExecutor`, `FrontendToolsError`, and the authoritative wire protocol both sides share (`parseServerMessage`, `parseClientMessage`, `encodeClientMessage`, `encodeServerMessage`, message types) — the bridge plugin consumes these definitions as a dependency, so the two packages cannot drift. Applications may embed it directly or through a bundler.

## Model Experience

None, as this package runs entirely inside the host application process; the bridge plugin owns every model-facing registration.

#### KV Cache effect

The SDK never touches a model request; its only traffic is the loopback WebSocket to the bridge. Nothing in this package can invalidate or extend any model request prefix.

## Known Limitations and Deferred Work

- **Register and unregister confirmations are order-coupled** — concurrent `registerTools` / `unregisterTools` calls settle in send order (the protocol carries no per-batch correlation id); applications that need deterministic batching await each call before sending the next.
- **Re-registered names after recovery are unconfirmed** — the automatic re-registration after a reconnect does not wait for the bridge's `registered` confirmation before the session is usable again; a refusal (for example a squatted public name) surfaces on the next interaction.
