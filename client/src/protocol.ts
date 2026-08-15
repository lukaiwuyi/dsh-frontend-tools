/**
 * Authoritative wire protocol shared by the frontend-tools bridge
 * (`dsh-frontend-tools-bridge`) and every client of that bridge.
 * The bridge package imports these definitions; this file stays importable
 * from browsers (no Node dependencies).
 *
 * Transport: one WebSocket connection over 127.0.0.1, text frames only, one
 * JSON message per frame. Lifecycle: the client sends `hello`; the server
 * answers `welcome` (or `error` + close), echoing the namespace bound to the
 * presented key. After `welcome` the client may send
 * `register` any number of times; the server mirrors each advertised tool on
 * `ctx.tools` and answers `registered` with the model-facing public names.
 * Model calls travel as `call` (server → client, carrying the client's raw
 * tool name, never the public name) and `callResult`. Closing the socket
 * unregisters every tool that connection registered.
 *
 * @module
 */

/**
 * Wire protocol version; a `hello` carrying any other value is rejected.
 *
 * v2 added the session-phase vocabulary `ping`/`pong` (server-driven liveness
 * probe), `unregister`/`unregistered` (runtime tool removal), and the
 * registration failure code `too_many_tools`. v3 moves the namespace out of
 * `hello` into the credential's identity: the client sends only the key
 * (which the application generated itself and had registered with the bridge's
 * admin tools), and `welcome` echoes back the bound namespace. v4 renames the
 * `hello` credential field from `token` to `key`, aligning the wire with the
 * user-facing DSH KEY vocabulary everywhere else.
 */
export const PROTOCOL_VERSION = 4

/** Server identity advertised in the `welcome` message. */
export const SERVER_ID = 'frontend-tools-bridge'

/**
 * Namespace alphabet and length: `[A-Za-z0-9_-]`, 1–32 chars. The namespace
 * prefixes every model-facing public tool name (`<namespace>__<rawName>`), so
 * it must stay inside the model function-name budget (64 chars total).
 */
export const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * DSH KEY alphabet and length: 64 lowercase hex characters (32 bytes of
 * entropy). The application generates the key itself with
 * {@link generateClientKey} and has it registered against its namespace
 * through the bridge's admin tools; the bridge rejects registrations that do
 * not match this pattern, so guessable credentials cannot be enrolled.
 */
export const CLIENT_KEY_PATTERN = /^[0-9a-f]{64}$/

/**
 * Generate one DSH KEY matching {@link CLIENT_KEY_PATTERN}.
 *
 * The application owns its credential lifecycle: generate once, persist it
 * (for example in `localStorage`), and have the user register it with the
 * bridge exactly once. Regenerating and re-registering rotates the credential.
 *
 * Uses the platform Web Crypto API, available in every browser and in Node 22+
 * as `globalThis.crypto`.
 * @returns a fresh 64-hex-character key.
 */
export function generateClientKey(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Inputs of {@link buildClientKeyClipboardText}. */
export interface ClientKeyClipboardInput {
  /** Namespace the key is registered under; prefixes every public tool name. */
  readonly namespace: string
  /** The DSH KEY the application generated and persisted. */
  readonly key: string
  /** Optional application name so the model can tell clients apart when several are enrolled. */
  readonly appName?: string
}

/**
 * Build the ready-to-paste handoff text for one DSH KEY.
 *
 * The intended flow is conversational onboarding: the application shows this
 * text behind a copy button, the user pastes it into a dsh conversation, and
 * the model registers the key by calling `frontend_tools_register_client`
 * with the `namespace` and `key` lines — the three-line format matches that
 * tool's parameters exactly, so no follow-up questions are needed.
 * @param input - the key, its namespace, and an optional application name.
 * @returns three lines: a purpose header, `namespace: …`, and `key: …`.
 */
export function buildClientKeyClipboardText(input: ClientKeyClipboardInput): string {
  const header = input.appName === undefined
    ? 'DSH 前端工具桥接入'
    : `${input.appName} · DSH 前端工具桥接入`
  return `[${header}]\nnamespace: ${input.namespace}\nkey: ${input.key}`
}

/**
 * Raw tool name alphabet: `[A-Za-z0-9_-]`, 1–64 chars. Names that collide
 * after public-name normalization are still accepted — normalization appends
 * an identity hash — but the wire name itself must already be function-name
 * safe.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Structured failure codes. `auth_failed`, `duplicate_connection`,
 * `invalid_message`, `invalid_tool`, and `too_many_tools` are
 * connection/registration failures carried by `error`; `unknown_tool`,
 * `disconnected`, `denied`, `invalid_args`, and `internal` are per-call
 * failures carried by `callResult.error`. `denied` means the application
 * refused the call for a reason the model can read and react to (for example:
 * not logged in). `too_many_tools` means the register batch would exceed the
 * bridge's per-connection tool budget.
 */
export type BridgeErrorCode =
  | 'auth_failed'
  | 'duplicate_connection'
  | 'invalid_message'
  | 'invalid_tool'
  | 'too_many_tools'
  | 'unknown_tool'
  | 'disconnected'
  | 'denied'
  | 'invalid_args'
  | 'internal'

/**
 * Error carrying a protocol failure code. The client SDK also throws it for
 * application-side refusals (`code: 'denied'`); the bridge rethrows it
 * verbatim from its decoders.
 */
export class FrontendToolsError extends Error {
  /** Machine-readable failure code carried on the wire. */
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'FrontendToolsError'
    this.code = code
  }
}

/** One JSON schema node as carried on the wire. */
export type WireJsonSchema = Record<string, unknown>

/** One tool advertised by the client in a `register` message. */
export interface RemoteToolSpec {
  /** Client-side tool name; sent back verbatim in each `call`. */
  readonly name: string
  /** Model-facing description of when to use the tool. */
  readonly description: string
  /** Raw JSON Schema for the tool's parameters (object root). */
  readonly parametersSchema: WireJsonSchema
  /** Optional raw JSON Schema for the tool's successful output values; `{}` (any JSON) when omitted. */
  readonly outputSchema?: WireJsonSchema
}

/** First message on every connection; unknown key or wrong version closes it. */
export interface HelloMessage {
  readonly type: 'hello'
  readonly protocol: typeof PROTOCOL_VERSION
  readonly key: string
}

/** Client → server: mirror these tools on `ctx.tools`. */
export interface RegisterMessage {
  readonly type: 'register'
  readonly tools: readonly RemoteToolSpec[]
}

/** Client → server: settle one forwarded call. */
export interface CallResultMessage {
  readonly type: 'callResult'
  readonly callId: string
  readonly ok: boolean
  /** Successful value; present exactly when `ok` is true. */
  readonly result?: unknown
  /** Structured failure; present exactly when `ok` is false. */
  readonly error?: { readonly code: BridgeErrorCode; readonly message: string }
}

/** Client → server: answer a server `ping`; absence within the bridge's liveness window kills the session. */
export interface PongMessage {
  readonly type: 'pong'
}

/** Client → server: remove these tools from the model's view; names are client-side raw names. */
export interface UnregisterMessage {
  readonly type: 'unregister'
  readonly names: readonly string[]
}

/** Every message the server accepts from the client. */
export type ClientMessage = HelloMessage | RegisterMessage | CallResultMessage | PongMessage | UnregisterMessage

/** Server → client: handshake accepted; registration and calls may follow. */
export interface WelcomeMessage {
  readonly type: 'welcome'
  readonly protocol: typeof PROTOCOL_VERSION
  /** Sender identity; the bridge always sends {@link SERVER_ID}. */
  readonly server: string
  /** Namespace bound to the presented key at registration time; prefixes every public tool name. */
  readonly namespace: string
}

/** Server → client: connection- or registration-level failure. Fatal unless the code is `invalid_tool`. */
export interface ErrorMessage {
  readonly type: 'error'
  readonly code: BridgeErrorCode
  readonly message: string
}

/** Server → client: the model-facing public names this connection owns. */
export interface RegisteredMessage {
  readonly type: 'registered'
  readonly names: readonly string[]
}

/** Server → client: liveness probe; the client answers with `pong`. */
export interface PingMessage {
  readonly type: 'ping'
}

/** Server → client: the raw names actually removed (idempotent; unknown names are ignored). */
export interface UnregisteredMessage {
  readonly type: 'unregistered'
  readonly names: readonly string[]
}

/** Server → client: execute one tool; answer with `callResult` on the same `callId`. */
export interface CallMessage {
  readonly type: 'call'
  readonly callId: string
  /** The client's raw tool name, never the public name. */
  readonly name: string
  /** Model-generated arguments, forwarded unchanged. */
  readonly args: unknown
}

/** Every message the server may send to a connected client. */
export type ServerMessage = WelcomeMessage | ErrorMessage | RegisteredMessage | PingMessage | UnregisteredMessage | CallMessage

/** Runtime type guard for a plain JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Assert `value` is a JSON schema object usable as a tool schema root. */
function expectSchema(value: unknown, where: string): WireJsonSchema {
  if (!isRecord(value)) throw new FrontendToolsError('invalid_message', `${where} must be a JSON object`)
  return value
}

/** Validate one `RemoteToolSpec` field by field; throws `invalid_tool` on the first violation. */
function expectRemoteTool(value: unknown): RemoteToolSpec {
  if (!isRecord(value)) throw new FrontendToolsError('invalid_tool', 'each registered tool must be an object')
  const { name, description, parametersSchema, outputSchema } = value
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new FrontendToolsError('invalid_tool', `tool name ${JSON.stringify(name)} must match ${TOOL_NAME_PATTERN.source}`)
  }
  if (typeof description !== 'string') {
    throw new FrontendToolsError('invalid_tool', `tool "${name}" description must be a string`)
  }
  const parameters = expectSchema(parametersSchema, `tool "${name}" parametersSchema`)
  if (outputSchema !== undefined) {
    return { name, description, parametersSchema: parameters, outputSchema: expectSchema(outputSchema, `tool "${name}" outputSchema`) }
  }
  return { name, description, parametersSchema: parameters }
}

/**
 * Decode one client frame into a typed {@link ClientMessage} (used by the bridge).
 * @param raw - the received text frame.
 * @param phase - `'hello'` accepts only `hello`; `'session'` accepts the post-handshake vocabulary.
 * @returns the validated message.
 * @throws FrontendToolsError (`invalid_message` or `invalid_tool`) when the frame is not valid JSON
 * or not a well-formed message of the expected phase.
 */
export function parseClientMessage(raw: string, phase: 'hello' | 'session'): ClientMessage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new FrontendToolsError('invalid_message', `frame is not valid JSON: ${String(error)}`)
  }
  if (!isRecord(value)) throw new FrontendToolsError('invalid_message', 'frame must be a JSON object')
  switch (value.type) {
    case 'hello': {
      if (phase !== 'hello') throw new FrontendToolsError('invalid_message', 'hello is only valid as the first frame')
      const { protocol, key } = value
      if (protocol !== PROTOCOL_VERSION) {
        throw new FrontendToolsError('invalid_message', `protocol version ${JSON.stringify(protocol)} is not supported (expected ${PROTOCOL_VERSION})`)
      }
      if (typeof key !== 'string') throw new FrontendToolsError('invalid_message', 'hello.key must be a string')
      return { type: 'hello', protocol, key }
    }
    case 'register': {
      if (phase !== 'session') throw new FrontendToolsError('invalid_message', 'register requires a completed handshake')
      const { tools } = value
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new FrontendToolsError('invalid_message', 'register.tools must be a non-empty array')
      }
      return { type: 'register', tools: tools.map(expectRemoteTool) }
    }
    case 'callResult': {
      if (phase !== 'session') throw new FrontendToolsError('invalid_message', 'callResult requires a completed handshake')
      const { callId, ok, result, error } = value
      if (typeof callId !== 'string' || callId.length === 0) {
        throw new FrontendToolsError('invalid_message', 'callResult.callId must be a non-empty string')
      }
      if (typeof ok !== 'boolean') throw new FrontendToolsError('invalid_message', 'callResult.ok must be a boolean')
      if (ok) {
        if (error !== undefined) throw new FrontendToolsError('invalid_message', 'callResult.error must be absent when ok is true')
        return { type: 'callResult', callId, ok, result }
      }
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new FrontendToolsError('invalid_message', 'failed callResult must carry error { code, message }')
      }
      return { type: 'callResult', callId, ok, error: { code: error.code as BridgeErrorCode, message: error.message } }
    }
    case 'pong': {
      if (phase !== 'session') throw new FrontendToolsError('invalid_message', 'pong requires a completed handshake')
      return { type: 'pong' }
    }
    case 'unregister': {
      if (phase !== 'session') throw new FrontendToolsError('invalid_message', 'unregister requires a completed handshake')
      const { names } = value
      if (!Array.isArray(names) || names.length === 0 || !names.every(name => typeof name === 'string' && name.length > 0)) {
        throw new FrontendToolsError('invalid_message', 'unregister.names must be a non-empty array of non-empty strings')
      }
      return { type: 'unregister', names: names as string[] }
    }
    default:
      throw new FrontendToolsError('invalid_message', `unknown message type ${JSON.stringify(value.type)}`)
  }
}

/**
 * Decode one server frame into a typed {@link ServerMessage} (used by the client SDK).
 * @param raw - the received text frame.
 * @returns the validated message.
 * @throws FrontendToolsError (`invalid_message`) when the frame is not a well-formed server message.
 */
export function parseServerMessage(raw: string): ServerMessage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new FrontendToolsError('invalid_message', `frame is not valid JSON: ${String(error)}`)
  }
  if (!isRecord(value)) throw new FrontendToolsError('invalid_message', 'frame must be a JSON object')
  switch (value.type) {
    case 'welcome': {
      if (value.protocol !== PROTOCOL_VERSION) {
        throw new FrontendToolsError('invalid_message', `welcome carries unsupported protocol ${JSON.stringify(value.protocol)}`)
      }
      if (typeof value.server !== 'string') throw new FrontendToolsError('invalid_message', 'welcome.server must be a string')
      if (typeof value.namespace !== 'string' || !NAMESPACE_PATTERN.test(value.namespace)) {
        throw new FrontendToolsError('invalid_message', `welcome.namespace must match ${NAMESPACE_PATTERN.source}`)
      }
      return { type: 'welcome', protocol: value.protocol, server: value.server, namespace: value.namespace }
    }
    case 'error': {
      if (typeof value.code !== 'string' || typeof value.message !== 'string') {
        throw new FrontendToolsError('invalid_message', 'error must carry { code, message }')
      }
      return { type: 'error', code: value.code as BridgeErrorCode, message: value.message }
    }
    case 'registered': {
      if (!Array.isArray(value.names) || !value.names.every(name => typeof name === 'string')) {
        throw new FrontendToolsError('invalid_message', 'registered.names must be an array of strings')
      }
      return { type: 'registered', names: value.names }
    }
    case 'ping': {
      return { type: 'ping' }
    }
    case 'unregistered': {
      if (!Array.isArray(value.names) || !value.names.every(name => typeof name === 'string')) {
        throw new FrontendToolsError('invalid_message', 'unregistered.names must be an array of strings')
      }
      return { type: 'unregistered', names: value.names }
    }
    case 'call': {
      if (typeof value.callId !== 'string' || value.callId.length === 0 || typeof value.name !== 'string') {
        throw new FrontendToolsError('invalid_message', 'call must carry { callId, name }')
      }
      return { type: 'call', callId: value.callId, name: value.name, args: value.args }
    }
    default:
      throw new FrontendToolsError('invalid_message', `unknown message type ${JSON.stringify(value.type)}`)
  }
}

/**
 * Encode one client message into a text frame.
 * @param message - the message to serialize.
 * @returns the JSON text frame to send.
 */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message)
}

/**
 * Encode one server message into a text frame.
 * @param message - the message to serialize.
 * @returns the JSON text frame to send.
 */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message)
}
