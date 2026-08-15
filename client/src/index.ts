/**
 * Frontend tools client SDK: connect an application (browser or Node) to the
 * DeepSeek Harness frontend-tools bridge and expose the application's own
 * tools to the model. The application keeps the real implementations — this
 * SDK only carries registrations one way and forwarded calls the other.
 *
 * Runtime dependencies: none beyond the platform `WebSocket` (browsers and
 * Node 22+ both provide it).
 *
 * @module dsh-frontend-tools-client
 */

import { BridgeConnection } from './connection.ts'
import type { ConnectionHandlers, ConnectionState, WebSocketConstructor } from './connection.ts'
import { ToolExecutor } from './executor.ts'
import type { FrontendTool } from './executor.ts'
import { FrontendToolsError } from './protocol.ts'

export { BridgeConnection } from './connection.ts'
export type { ConnectionOptions, ConnectionHandlers, ConnectionState, WebSocketLike, WebSocketConstructor } from './connection.ts'
export { ToolExecutor } from './executor.ts'
export type { FrontendTool, DispatchOutcome } from './executor.ts'
export {
  PROTOCOL_VERSION,
  SERVER_ID,
  NAMESPACE_PATTERN,
  CLIENT_KEY_PATTERN,
  TOOL_NAME_PATTERN,
  generateClientKey,
  buildClientKeyClipboardText,
  FrontendToolsError,
  parseServerMessage,
  parseClientMessage,
  encodeClientMessage,
  encodeServerMessage,
} from './protocol.ts'
export type { ClientKeyClipboardInput } from './protocol.ts'
export type {
  BridgeErrorCode,
  WireJsonSchema,
  RemoteToolSpec,
  HelloMessage,
  RegisterMessage,
  CallResultMessage,
  ClientMessage,
  WelcomeMessage,
  ErrorMessage,
  RegisteredMessage,
  CallMessage,
  ServerMessage,
} from './protocol.ts'

/** Options for {@link createFrontendToolsClient}. */
export interface FrontendToolsClientOptions {
  /** Bridge URL, for example `ws://127.0.0.1:31870`. */
  readonly url: string
  /**
   * Handshake DSH KEY this application generated (see `generateClientKey`)
   * and had registered against its namespace through the bridge's admin
   * tools. The bridge resolves the key to the namespace; the client learns
   * it from the server's `welcome`.
   */
  readonly key: string
  /**
   * Reconnect automatically after an established session drops, with
   * exponential backoff (1s doubling to 30s), and re-register every tool the
   * client still holds. Default `true` — long-lived UIs want recovery without
   * wiring; pass `false` for one-shot scripts that should fail fast.
   */
  readonly reconnect?: boolean
  /** `WebSocket` constructor override, for tests or alternative transports. */
  readonly socket?: WebSocketConstructor
}

/** Client state-change listener. */
export type StateListener = (state: ConnectionState) => void

/** The client handle returned by {@link createFrontendToolsClient}. */
export interface FrontendToolsClient {
  /** Complete the handshake; resolves after the server's `welcome`. */
  connect(): Promise<void>
  /** Close the connection (idempotent). Mirrored tools disappear from the model. */
  disconnect(): void
  /**
   * Register tools with the bridge and wait for the confirmation.
   * @param tools - application tool definitions with their `execute` bodies.
   * @returns the model-facing public names the bridge registered, in registration order.
   */
  registerTools(tools: readonly FrontendTool[]): Promise<string[]>
  /**
   * Remove tools from the bridge and wait for the confirmation.
   * @param names - raw tool names previously registered on this client.
   * @returns the raw names the bridge actually removed (unknown names are ignored).
   */
  unregisterTools(names: readonly string[]): Promise<string[]>
  /** Current connectivity state. */
  readonly state: ConnectionState
  /** Namespace the bridge bound to this client's key; `undefined` until the handshake completes. */
  readonly namespace: string | undefined
  /**
   * Subscribe to state changes.
   * @param listener - invoked on every `connecting` / `connected` / `disconnected` / `reconnecting` transition.
   * @returns the unsubscribe function.
   */
  onStateChange(listener: StateListener): () => void
}

/** Reconnect backoff bounds: 1s doubling up to 30s between attempts. */
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

/**
 * Create one bridge client.
 *
 * One client owns one connection and one tool registry; create separate
 * clients for separate bridges or keys. With `reconnect` (default) an
 * established session that drops is retried with exponential backoff and its
 * tools re-registered from the executor, so the model's view recovers without
 * application code.
 * @param options - URL, key, reconnect mode, and optional `WebSocket` constructor.
 * @returns the client handle.
 */
export function createFrontendToolsClient(options: FrontendToolsClientOptions): FrontendToolsClient {
  const executor = new ToolExecutor()
  /** Resolvers for `registerTools` calls, one per in-flight `register` frame. */
  const registerWaiters: Array<{
    resolve: (names: string[]) => void
    reject: (error: FrontendToolsError) => void
  }> = []
  /** Resolvers for `unregisterTools` calls, one per in-flight `unregister` frame. */
  const unregisterWaiters: Array<{
    resolve: (names: string[]) => void
    reject: (error: FrontendToolsError) => void
  }> = []
  const stateListeners = new Set<StateListener>()
  let state: ConnectionState = 'disconnected'
  let namespace: string | undefined
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_BASE_DELAY_MS

  const setState = (next: ConnectionState): void => {
    state = next
    for (const listener of stateListeners) listener(next)
  }

  /** Drop an established session's bookkeeping: reject in-flight confirmations. */
  const failWaiters = (): void => {
    const registers = registerWaiters.splice(0)
    for (const waiter of registers) {
      waiter.reject(new FrontendToolsError('disconnected', 'connection closed before registration was confirmed'))
    }
    const unregisters = unregisterWaiters.splice(0)
    for (const waiter of unregisters) {
      waiter.reject(new FrontendToolsError('disconnected', 'connection closed before removal was confirmed'))
    }
  }

  /** Retry the connection after `reconnectDelay`, doubling up to the cap. */
  const scheduleReconnect = (): void => {
    if (disposed || options.reconnect === false) return
    setState('reconnecting')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connection.connect()
        .then(() => {
          reconnectDelay = RECONNECT_BASE_DELAY_MS
          const specs = executor.specs()
          if (specs.length > 0) connection.registerTools(specs)
        })
        .catch(() => {
          // Still unreachable: keep backing off. A dropped bridge restart is
          // the normal recovery path, not an error to surface.
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS)
          scheduleReconnect()
        })
    }, reconnectDelay)
  }

  const handlers: ConnectionHandlers = {
    onConnected: (welcomed) => {
      namespace = welcomed
      setState('connected')
    },
    onDisconnected: () => {
      // An explicit disconnect() already reported `disconnected`; the close
      // event that follows only owes the in-flight waiter cleanup.
      if (!disposed) setState('disconnected')
      failWaiters()
      scheduleReconnect()
    },
    onRegistered: (message) => {
      const waiter = registerWaiters.shift()
      waiter?.resolve([...message.names])
    },
    onUnregistered: (message) => {
      for (const name of message.names) executor.unregister(name)
      unregisterWaiters.shift()?.resolve([...message.names])
    },
    onCall: (name, args) => executor.dispatch(name, args),
  }

  const connection = new BridgeConnection(options, handlers)

  return {
    get state(): ConnectionState {
      return state
    },
    get namespace(): string | undefined {
      return namespace
    },
    connect(): Promise<void> {
      if (disposed) return Promise.reject(new FrontendToolsError('disconnected', 'client was disconnected; create a new one to reconnect'))
      setState('connecting')
      return connection.connect().catch((error: unknown) => {
        setState('disconnected')
        throw error
      })
    },
    disconnect(): void {
      disposed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      // The state flips immediately on the explicit request rather than
      // waiting for the transport's close event; the later onDisconnected
      // re-settles the same value harmlessly.
      setState('disconnected')
      connection.disconnect()
    },
    registerTools(tools: readonly FrontendTool[]): Promise<string[]> {
      for (const tool of tools) executor.register(tool)
      return new Promise<string[]>((resolve, reject) => {
        registerWaiters.push({ resolve, reject })
        try {
          connection.registerTools(tools)
        } catch (error) {
          registerWaiters.pop()
          /* v8 ignore next -- BridgeConnection.send only throws FrontendToolsError (declared contract);
           * the wrapping arm is a defensive backstop. */
          reject(error instanceof FrontendToolsError ? error : new FrontendToolsError('disconnected', String(error)))
        }
      })
    },
    unregisterTools(names: readonly string[]): Promise<string[]> {
      // The wire format rejects an empty batch; an empty request is a no-op.
      if (names.length === 0) return Promise.resolve([])
      return new Promise<string[]>((resolve, reject) => {
        unregisterWaiters.push({ resolve, reject })
        try {
          connection.unregisterTools(names)
        } catch (error) {
          unregisterWaiters.pop()
          /* v8 ignore next -- same declared contract as the register path. */
          reject(error instanceof FrontendToolsError ? error : new FrontendToolsError('disconnected', String(error)))
        }
      })
    },
    onStateChange(listener: StateListener): () => void {
      stateListeners.add(listener)
      return () => { stateListeners.delete(listener) }
    },
  }
}
