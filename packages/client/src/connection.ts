/**
 * WebSocket client for the frontend-tools bridge. Owns one connection through
 * its handshake and then the `register` / `unregister` / `call` exchange. A
 * dropped connection surfaces as `disconnected`; the reconnecting wrapper in
 * `index.ts` owns retry and re-registration.
 *
 * Uses the WHATWG `WebSocket` global available in browsers and Node 22+; a
 * constructor can be injected for tests or alternative environments.
 *
 * @module
 */

import { encodeClientMessage, parseServerMessage, FrontendToolsError, PROTOCOL_VERSION } from './protocol'
import type { ClientMessage, ErrorMessage, RegisteredMessage, RemoteToolSpec, UnregisteredMessage } from './protocol'
import type { DispatchOutcome } from './executor.ts'

/** Structural slice of the WHATWG `WebSocket` this client relies on. */
export interface WebSocketLike {
  /** Queue one text frame. */
  send(data: string): void
  /** Begin a graceful close. */
  close(): void
  /** Register lifecycle callbacks; the runtime assigns these directly. */
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

/** Constructor shape accepted for `WebSocket` injection. */
export type WebSocketConstructor = new (url: string) => WebSocketLike

/**
 * Connectivity state reported through `state` events. `reconnecting` is only
 * produced by the reconnecting client wrapper, never by one {@link BridgeConnection}
 * (a bare connection that drops simply goes `disconnected`).
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** Options for {@link createConnection}. */
export interface ConnectionOptions {
  /** Bridge URL, for example `ws://127.0.0.1:31870`. */
  readonly url: string
  /** Handshake DSH KEY this application generated and had registered with the bridge. */
  readonly key: string
  /** `WebSocket` constructor; defaults to the global. */
  readonly socket?: WebSocketConstructor
}

/** Callback set driving the connection; all fields are optional. */
export interface ConnectionHandlers {
  /** The handshake completed and the server accepted the session; carries the namespace bound to the key. */
  onConnected?: (namespace: string) => void
  /** The socket dropped or never opened; no tools remain reachable. */
  onDisconnected?: (fatal: ErrorMessage | undefined) => void
  /** One `register` batch was accepted; carries the public names. */
  onRegistered?: (message: RegisteredMessage) => void
  /** One `unregister` batch settled; carries the raw names removed. */
  onUnregistered?: (message: UnregisteredMessage) => void
  /** One forwarded call arrived; resolve with the outcome to answer it. */
  onCall?: (name: string, args: unknown) => Promise<DispatchOutcome>
}

/**
 * One bridge connection. Created per {@link createFrontendToolsClient} call;
 * the connection itself is transport only — tool storage lives in
 * {@link ToolExecutor}, which feeds `register` batches through
 * {@link registerTools}.
 */
export class BridgeConnection {
  private socket: WebSocketLike | undefined
  private state: ConnectionState = 'disconnected'
  /** Error frame received from the server before the socket closed. */
  private fatal: ErrorMessage | undefined
  /** Namespace echoed by the server's `welcome`; set once the handshake completes. */
  private welcomedNamespace: string | undefined

  constructor(
    private readonly options: ConnectionOptions,
    private readonly handlers: ConnectionHandlers,
  ) {}

  /** Current connectivity state. */
  get currentState(): ConnectionState {
    return this.state
  }

  /** Namespace the server bound to this connection's key; `undefined` before the handshake completes. */
  get namespace(): string | undefined {
    return this.welcomedNamespace
  }

  /**
   * Open the connection and complete the handshake.
   * @returns the welcome completion.
   * @throws FrontendToolsError (`auth_failed`, `duplicate_connection`, or
   *   `invalid_message`) when the server rejects the session, or the socket
   *   closes before `welcome`.
   */
  connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      return Promise.reject(new FrontendToolsError('invalid_message', `connect() requires a disconnected client (state: ${this.state})`))
    }
    this.state = 'connecting'
    const Socket = this.options.socket ?? globalThis.WebSocket as unknown as WebSocketConstructor
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const socket = new Socket(this.options.url)
      this.socket = socket
      const fail = (error: FrontendToolsError): void => {
        if (settled) return
        settled = true
        this.state = 'disconnected'
        try { socket.close() } catch { /* already closing; the rejection below carries the cause */ }
        reject(error)
      }
      socket.onopen = (): void => {
        socket.send(encodeClientMessage({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          key: this.options.key,
        }))
      }
      socket.onmessage = (event: { data: unknown }): void => {
        // The bridge sends text frames only, and every WHATWG transport
        // delivers text frames as strings.
        const raw = event.data as string
        let message
        try {
          message = parseServerMessage(raw)
        } catch (error) {
          /* v8 ignore next -- parseServerMessage only throws FrontendToolsError (declared contract);
           * the wrapping arm is a defensive backstop. */
          fail(error instanceof FrontendToolsError ? error : new FrontendToolsError('invalid_message', String(error)))
          return
        }
        switch (message.type) {
          case 'welcome':
            if (settled) return
            settled = true
            this.state = 'connected'
            this.welcomedNamespace = message.namespace
            this.fatal = undefined
            this.handlers.onConnected?.(message.namespace)
            resolve()
            break
          case 'error':
            this.fatal = message
            fail(new FrontendToolsError(message.code, message.message))
            break
          case 'registered':
            this.handlers.onRegistered?.(message)
            break
          case 'ping':
            // Liveness probe: answer immediately; the bridge kills the session
            // if a probe is still unanswered when the next one is due.
            this.send({ type: 'pong' })
            break
          case 'unregistered':
            this.handlers.onUnregistered?.(message)
            break
          case 'call': {
            void this.handlers.onCall?.(message.name, message.args)
              .then((outcome) => { this.answerCall(message.callId, outcome) })
            break
          }
        }
      }
      socket.onerror = (): void => {
        fail(new FrontendToolsError('invalid_message', `connection to ${this.options.url} failed before the handshake completed`))
      }
      socket.onclose = (): void => {
        const wasConnected = this.state === 'connected'
        this.state = 'disconnected'
        this.socket = undefined
        if (!settled) {
          settled = true
          reject(new FrontendToolsError('invalid_message', 'connection closed before the handshake completed'))
        }
        if (wasConnected) this.handlers.onDisconnected?.(this.fatal)
      }
    })
  }

  /**
   * Send one `register` batch for the given tools.
   * @param specs - tool specs to mirror; a raw `name` must be unique within the batch.
   */
  registerTools(specs: readonly RemoteToolSpec[]): void {
    this.send({
      type: 'register',
      tools: specs,
    })
  }

  /**
   * Send one `unregister` batch of raw tool names.
   * @param names - raw names previously registered on this connection.
   */
  unregisterTools(names: readonly string[]): void {
    this.send({ type: 'unregister', names })
  }

  /** Answer one forwarded call. */
  private answerCall(callId: string, outcome: DispatchOutcome): void {
    const message: ClientMessage = outcome.ok
      ? { type: 'callResult', callId, ok: true, result: outcome.result }
      : { type: 'callResult', callId, ok: false, error: outcome.error }
    this.send(message)
  }

  /** Send one frame on the live socket. */
  private send(message: ClientMessage): void {
    const socket = this.socket
    if (socket === undefined || this.state !== 'connected') {
      throw new FrontendToolsError('disconnected', 'client is not connected')
    }
    socket.send(encodeClientMessage(message))
  }

  /** Close the connection; safe to call in any state. */
  disconnect(): void {
    this.socket?.close()
  }
}
