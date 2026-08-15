# dsh-frontend-tools-bridge

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-frontend-tools-bridge)](https://www.npmjs.com/package/dsh-frontend-tools-bridge)

The dsh half of the frontend tools bridge: a loopback-only WebSocket server that lets any number of connected applications mirror their own tools onto `ctx.tools`, each under its own namespace. Real implementations stay in the applications (browser renderers, web apps, Node processes) — the bridge carries no business knowledge; it forwards model calls to the owning application and returns its results. The application-side counterpart is [`dsh-frontend-tools-client`](../client/README.md).

## What it does

The plugin starts one `WebSocketServer` bound to `127.0.0.1` (a non-loopback bind would expose the model's tool access to the local network; the handshake key is a client identity, not a network boundary). Authentication is a client roster: applications generate their own DSH KEYs (64 hex chars via the client SDK) and a user registers each key against a namespace through a conversation, so the key doubles as the client's identity and the application owns its credential lifecycle. A connection completes a `hello` handshake (protocol version, key); the server answers `welcome` echoing the bound namespace. One session may hold a namespace at a time — a second connection presenting the same namespace is rejected with `duplicate_connection`; once the owner disconnects, its mirrored tools are unregistered, in-flight calls are rejected, and a replacement connection for that namespace is accepted immediately. Clients under different namespaces connect concurrently and never see each other's tools.

Registration is per-`register`-batch and all-or-nothing: if any tool in a batch fails validation or name conflict, the whole batch is refused with a non-fatal `invalid_tool` error and the client may fix its definitions and send another `register`. Each accepted tool appears on `ctx.tools` under the public name `<namespace>__<rawName>` (the `mcp-client` contract): normalized to the model function-name alphabet `[A-Za-z0-9_-]` and 64-character budget, with a 12-hex-character SHA-256 identity hash appended whenever normalization is lossy so distinct client names never collapse. A batch that would push the whole bridge past `maxTools` is refused with a non-fatal `too_many_tools` error. An `unregister` batch removes tools by raw name and is answered with the raw names actually removed (unknown names are ignored), freeing those public names for later re-registration on the same connection.

A model invocation is forwarded to the owning connection as a `call` frame carrying the client's raw tool name (the public name never travels back); the promise settles when the matching `callResult` arrives, when the caller aborts through `exec.signal`, or — rejection — when the connection drops or `callTimeoutMs` elapses without an answer. A late `callResult` for an abandoned or timed-out call is dropped without failing the session. Results render as pretty-printed JSON text content; the output schema defaults to any JSON when the client does not declare one.

Liveness is probed every 15 seconds with a `ping` frame; a probe still unanswered when the next one is due terminates the session (the `close` path owns the cleanup chain: tools unregistered, in-flight calls rejected, replacement connections accepted).

## Admin tools

The everyday way to onboard an application is a conversation, not a config edit. Credentials are application-owned: the application generates a DSH KEY (client SDK `generateClientKey`), shows it to the user, and the user hands it to the model, which registers it through these model-facing tools on `ctx.tools`.

- `frontend_tools_register_client(namespace, key)` — registers the application-provided DSH KEY against the namespace and persists it, returning `{ namespace, url, replaced }`; the output never echoes the key (the user's message already carries it, and a second copy would only widen session-log exposure). Re-registering for the same namespace replaces the credential immediately (the old key stops authenticating); a key bound to another namespace is rejected as an identity conflict, as is anything that does not match the 64-hex DSH KEY pattern.
- `frontend_tools_list_clients()` — lists every roster entry (static and registered) as `{ namespace, connected, toolCount }`; keys never appear in the output.
- `frontend_tools_revoke_client(namespace)` — removes the registered credential and drops its live connection in one step, so a revoked client cannot keep serving tools.

Registered credentials persist in `frontend-tools-clients.json` (mode 600 on POSIX) under the state directory, surviving bridge restarts. Statically configured clients (see `staticClients` below) are owned by `cordis.yml`: they authenticate like registered ones (their keys are free-form strings owned by the configuration) but refuse `register` and `revoke`, which name the configuration as the place to edit.

## Configuration

Five `Config` fields, validated at load:

- `port` — loopback port to listen on (default `31870`).
- `callTimeoutMs` — deadline for one forwarded call (default `30000`); a `callResult` arriving later rejects the model-facing promise with a timeout error and is dropped.
- `maxTools` — maximum number of tools mirrored across every connected client (default `200`, an abuse guard rather than a semantic limit). One global ceiling keeps concurrent applications from crowding the model's tool list.
- `staticClients` — optional statically configured `{ namespace, key }` entries, merged with the persisted roster at load; intended for tests and declarative setups. A namespace or key colliding with the persisted roster fails load loud.
- `stateDir` — directory holding the registered-client roster file; defaults to the harness state home (`~/.dsh`, overridable through `DSH_HOME`).

An empty roster at load is valid: register the application-generated DSH KEY once (`frontend_tools_register_client`) to onboard the first application. Bind failures (for example a taken port) and a malformed roster file reject plugin load instead of leaving a dead server behind. Disposal closes the listener, terminates every session, unregisters every mirrored tool (admin tools included), and rejects in-flight calls.

## Protocol

Version 4, text frames only, JSON-encoded. Client → server: `hello`, `register`, `unregister`, `callResult`, `pong`. Server → client: `welcome`, `registered`, `unregistered`, `call`, `ping`, `error`. The `hello` frame carries the key only — the namespace comes from the roster binding and is echoed in `welcome`. Malformed frames and phase violations (for example `register` before the handshake) answer `invalid_message` and close the socket. The authoritative message and error-code definitions live in [`dsh-frontend-tools-client`](../client/README.md) (`src/protocol.ts` there); this package consumes them as a dependency, so the two sides cannot drift.

## Export shape

A namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default. `BridgeServer`, `MirrorRegistry`, `CallDispatcher`, `ClientRoster`, and `registerAdminTools` are also exported for reuse and testing; the wire protocol itself is exported by the client package.

## Model Experience

Indirectly, through the application-advertised tool schemas this package mirrors onto `ctx.tools`; the connected application owns every schema, description, and result it registers.

#### KV Cache effect

Between registration events the mirrored schema set is stable and follows the reusable request prefix like any `ctx.tools` registration. Client registration, additional `register` or `unregister` batches, and a disconnect that unregisters the tools change the visible tool set and therefore replace the request prefix from that point; individual forwarded results append as ordinary tool-call results and do not invalidate earlier entries.

## Known Limitations and Deferred Work

- **One session per namespace** — a second connection presenting a key bound to an occupied namespace is rejected with `duplicate_connection`; there is no multiplexing several connections onto one namespace.
- **No reconnection lease** — the server neither buffers nor replays registrations for a reconnecting client; the client SDK's automatic reconnection re-sends its tool list instead.
- **Results render as JSON text only** — forwarded values always render as pretty-printed JSON; presentation intents (`terminal`, `diff`, `locations`) are deferred.
