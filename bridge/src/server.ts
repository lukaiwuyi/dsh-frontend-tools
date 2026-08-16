/**
 * Loopback WebSocket server authenticating any number of roster clients, one
 * live connection per namespace. Connection lifecycle: each socket must send
 * `hello` first; the roster resolves its key to a namespace, and the socket
 * then owns every tool it registers under that namespace until it closes.
 * Closing (or dying) unregisters those tools and rejects its in-flight calls,
 * and the server immediately accepts a replacement connection for that
 * namespace while every other client stays connected.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { encodeServerMessage, parseClientMessage, FrontendToolsError, PROTOCOL_VERSION, SERVER_ID } from 'dsh-frontend-tools-client'
import type { ErrorMessage } from 'dsh-frontend-tools-client'
import { MirrorRegistry, publicToolName } from './registry.ts'
import type { ToolCategory } from './registry.ts'
import { CallDispatcher } from './dispatch.ts'
import type { ClientRoster } from './key-store.ts'

/**
 * Liveness probe period (wire constant, not configuration): every interval the
 * server sends `ping`; a probe still unanswered when the next one is due kills
 * the session. Loopback RTT is microseconds, so one full interval is an ample
 * answer window and the kill lands within `[interval, 2·interval)`.
 */
const HEARTBEAT_INTERVAL_MS = 15_000

/** Live state of one authenticated client connection. */
interface ClientSession {
  socket: WebSocket
  registry: MirrorRegistry
  dispatcher: CallDispatcher
  namespace: string
  /** Heartbeat driver; cleared when the session drops. */
  heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** Whether the last `ping` is still waiting for its `pong`. */
  pongPending: boolean
}

/** Resolved server options (protocol constants aside, deployment choices live in Config). */
export interface ServerOptions {
  /** Loopback port to listen on. */
  readonly port: number
  /** Deadline for one forwarded call. */
  readonly callTimeoutMs: number
  /** Total tool budget shared by every connected client. */
  readonly maxTools: number
}

/**
 * The bridge server. Binds 127.0.0.1 only — a non-loopback bind would expose
 * the model's tool access to the local network, which the security model
 * forbids (the key is a handshake guard, not a network boundary).
 */
export class BridgeServer {
  private wss: WebSocketServer | undefined
  /** Live sessions by namespace (one connection per namespace at a time). */
  private readonly sessions = new Map<string, ClientSession>()
  /** Reverse index for routing frames from a socket to its session. */
  private readonly sessionBySocket = new Map<WebSocket, ClientSession>()
  /** Sockets that connected but have not completed the handshake. */
  private readonly pendingSockets = new Set<WebSocket>()

  constructor(
    private readonly ctx: Context,
    private readonly options: ServerOptions,
    private readonly roster: ClientRoster,
  ) {}

  /**
   * Start listening; resolves once the port is bound.
   * @returns bind completion.
   * @throws the OS listen error (for example `EADDRINUSE`) so plugin load fails loud.
   */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.options.port }, () => { resolve() })
      this.wss = wss
      wss.once('error', reject)
      wss.on('connection', (socket) => { this.accept(socket) })
    })
  }

  /** The bound port. */
  get port(): number | undefined {
    const address = this.wss?.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }

  /** Whether any client currently holds a session. */
  get hasSession(): boolean {
    return this.sessions.size > 0
  }

  /**
   * Connection state of one namespace for the admin tools.
   * @param namespace - roster namespace to report on.
   * @returns whether a session holds the namespace and how many tools it mirrors.
   */
  sessionInfo(namespace: string): { connected: boolean; toolCount: number } {
    const session = this.sessions.get(namespace)
    return session === undefined ? { connected: false, toolCount: 0 } : { connected: true, toolCount: session.registry.size }
  }

  /** Accept one socket: it must authenticate before any session vocabulary is honored. */
  private accept(socket: WebSocket): void {
    this.pendingSockets.add(socket)
    socket.on('message', (data: RawData) => {
      // The bridge protocol is text frames only; ws delivers those as a single Buffer.
      /* v8 ignore next 3 -- ws's default binaryType delivers every frame (text and binary) as a Buffer;
       * non-Buffer data requires a binaryType this server never configures. */
      if (!Buffer.isBuffer(data)) {
        this.fail(socket, 'invalid_message', 'bridge frames must be text frames')
        return
      }
      this.onFrame(socket, data.toString())
    })
    socket.on('close', () => { this.onClose(socket) })
    /* v8 ignore next -- ws emits `close` after every `error`; cleanup lives there,
     * so this no-op handler has no observable path of its own. */
    socket.on('error', () => {})
  }

  /** Route one decoded frame through the handshake/session state machine. */
  private onFrame(socket: WebSocket, raw: string): void {
    const session = this.sessionBySocket.get(socket)
    let message
    try {
      message = parseClientMessage(raw, session !== undefined ? 'session' : 'hello')
    } catch (error) {
      // parseClientMessage only throws FrontendToolsError (declared contract).
      const protocol = error as FrontendToolsError
      this.fail(socket, protocol.code, protocol.message)
      return
    }
    switch (message.type) {
      case 'hello':
        this.onHello(socket, message.key)
        break
      case 'register': {
        // parseClientMessage(phase='session') already proved this socket holds a session.
        const owner = session as ClientSession
        // The budget counts every tool mirrored across the whole bridge plus
        // the incoming batch, so concurrent clients share one global ceiling.
        if (this.mirroredToolCount() + message.tools.length > this.options.maxTools) {
          this.send(socket, { type: 'error', code: 'too_many_tools', message: `registering ${message.tools.length} more tools would exceed the bridge-wide limit of ${this.options.maxTools} (currently ${this.mirroredToolCount()})` })
          break
        }
        try {
          const names = owner.registry.register(message.tools, owner.namespace, owner.dispatcher.forward)
          this.send(socket, { type: 'registered', names })
        } catch (error) {
          // Registration failures are per-batch and non-fatal: the client may
          // fix its tool definitions and send another `register`.
          // MirrorRegistry.register only throws FrontendToolsError (declared contract).
          const protocol = error as FrontendToolsError
          this.send(socket, { type: 'error', code: protocol.code, message: protocol.message })
        }
        break
      }
      case 'unregister': {
        // parseClientMessage(phase='session') already proved this socket holds a session.
        const owner = session as ClientSession
        // The wire carries raw client names; translate to public names, remove,
        // and report back in raw names so the client never sees its own renames.
        const wanted = message.names.map(raw => ({ raw, publicName: publicToolName(owner.namespace, raw) }))
        const removed = new Set(owner.registry.unregister(wanted.map(entry => entry.publicName)))
        const removedRaw = wanted.filter(entry => removed.has(entry.publicName)).map(entry => entry.raw)
        this.send(socket, { type: 'unregistered', names: removedRaw })
        break
      }
      case 'pong': {
        // parseClientMessage(phase='session') already proved this socket holds a session.
        ;(session as ClientSession).pongPending = false
        break
      }
      case 'callResult': {
        // parseClientMessage(phase='session') already proved this socket holds a session.
        ;(session as ClientSession).dispatcher.settle(message.callId, message.ok, message.result, message.error)
        break
      }
    }
  }

  /** Total tools currently mirrored across every live session. */
  private mirroredToolCount(): number {
    let total = 0
    for (const session of this.sessions.values()) total += session.registry.size
    return total
  }

  /**
   * Read/write category of one mirrored tool across every live session
   * (the write-approval gate's dynamic lookup source). Namespaces are
   * disjoint, so at most one session can own a public name.
   * @param publicName - the model-facing `ctx.tools` name.
   * @returns the owning session's category, or `undefined` when no live session mirrors the name.
   */
  categoryOf(publicName: string): ToolCategory | undefined {
    for (const session of this.sessions.values()) {
      const category = session.registry.categoryOf(publicName)
      if (category !== undefined) return category
    }
    return undefined
  }

  /** Complete the handshake or fail the socket. */
  private onHello(socket: WebSocket, key: string): void {
    const namespace = this.roster.lookup(key)
    if (namespace === undefined) {
      this.fail(socket, 'auth_failed', 'key rejected')
      return
    }
    const existing = this.sessions.get(namespace)
    if (existing !== undefined) {
      this.fail(socket, 'duplicate_connection', `another connection already holds the "${namespace}" frontend-tools session; close it first`)
      return
    }
    this.pendingSockets.delete(socket)
    const dispatcher = new CallDispatcher(this.options.callTimeoutMs)
    dispatcher.attach((frame) => { socket.send(frame) })
    const session: ClientSession = {
      socket,
      registry: new MirrorRegistry(this.ctx),
      dispatcher,
      namespace,
      heartbeatTimer: undefined,
      pongPending: false,
    }
    this.sessions.set(namespace, session)
    this.sessionBySocket.set(socket, session)
    this.send(socket, { type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID, namespace })
    this.startHeartbeat(session)
  }

  /**
   * Drive the liveness probe for one live session: send `ping` every interval;
   * a probe still unanswered when the next one is due terminates the socket (the
   * `close` handler owns the cleanup chain: tools unregistered, in-flight
   * calls rejected, replacement connections accepted).
   */
  private startHeartbeat(session: ClientSession): void {
    session.heartbeatTimer = setInterval(() => {
      if (session.pongPending) {
        this.ctx.logger.warn(`frontend-tools-bridge: heartbeat timed out; dropping the "${session.namespace}" session`)
        session.socket.terminate()
        return
      }
      session.pongPending = true
      this.send(session.socket, { type: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * Drop the live session of one namespace, if any; used by the revoke admin
   * tool so a revoked credential cannot keep serving tools.
   * @param namespace - namespace whose connection is dropped.
   * @returns whether a live session was dropped.
   */
  dropSession(namespace: string): boolean {
    const session = this.sessions.get(namespace)
    if (session === undefined) return false
    this.detach(session)
    session.socket.close()
    return true
  }

  /** Send an `error` frame and close the socket. */
  private fail(socket: WebSocket, code: ErrorMessage['code'], message: string): void {
    this.send(socket, { type: 'error', code, message })
    socket.close()
  }

  /** Send one frame, tolerating a socket that died mid-send. */
  private send(socket: WebSocket, message: Parameters<typeof encodeServerMessage>[0]): void {
    socket.send(encodeServerMessage(message), (error: Error | undefined) => {
      /* v8 ignore next -- frames are only sent to sockets the server still
         believes open; a peer vanishing between that check and the kernel
         write surfaces through `close`, which owns cleanup. */
      if (error !== undefined) this.ctx.logger.warn(`frontend-tools-bridge: send failed: ${String(error)}`)
    })
  }

  /** Socket closed: release the session it owned (if any) and its mirrored tools. */
  private onClose(socket: WebSocket): void {
    this.pendingSockets.delete(socket)
    const session = this.sessionBySocket.get(socket)
    if (session === undefined) return
    this.detach(session)
  }

  /** Detach one session's registrations and in-flight calls from the transport. */
  private detach(session: ClientSession): void {
    this.sessions.delete(session.namespace)
    this.sessionBySocket.delete(session.socket)
    /* v8 ignore next -- a session is only droppable after onHello, which starts
       the heartbeat synchronously, so the timer is always present here; the
       guard only satisfies the field's `| undefined` type. */
    if (session.heartbeatTimer !== undefined) clearInterval(session.heartbeatTimer)
    session.heartbeatTimer = undefined
    session.dispatcher.attach(undefined)
    session.dispatcher.rejectAll('frontend-tools connection closed before the call settled')
    session.registry.disposeAll()
  }

  /** Stop the server and drop every session; used by the plugin's effect disposal. */
  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.detach(session)
      session.socket.terminate()
    }
    for (const socket of this.pendingSockets) socket.terminate()
    this.pendingSockets.clear()
    void new Promise<void>((resolve) => {
      this.wss?.close(() => { resolve() })
    })
  }
}
