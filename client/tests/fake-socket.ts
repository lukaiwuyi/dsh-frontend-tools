// Test double for the WHATWG `WebSocket` slice the connection layer relies
// on: the test drives open/message/error/close transitions by hand, and the
// double records every sent frame for assertion.
import type { WebSocketLike } from '../src/connection.ts'

/** Scriptable `WebSocket` stand-in; tests drive it through the `emit*` methods. */
export class FakeSocket implements WebSocketLike {
  /** Every instance ever created, in creation order (cleared between tests). */
  static readonly instances: FakeSocket[] = []

  /** The most recently created instance; every client owns exactly one socket. */
  static get latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1)
    if (socket === undefined) throw new Error('no FakeSocket was created')
    return socket
  }

  /** Drop every recorded instance (call from `afterEach`). */
  static reset(): void {
    FakeSocket.instances.length = 0
  }

  /** Frames sent through `send`, in order. */
  readonly sent: string[] = []
  /** Whether `close()` was called. */
  closed = false
  /** When set, `close()` throws (exercises the connection's close failure path). */
  closeThrows = false
  /** URL handed to the constructor. */
  readonly url: string
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closeThrows) throw new Error('close failed')
    this.closed = true
  }

  /** The transport established the connection. */
  driverOpen(): void {
    this.onopen?.()
  }

  /** One incoming frame; a non-string `data` exercises the coercion path. */
  driverMessage(data: string | Uint8Array): void {
    this.onmessage?.({ data })
  }

  /** One incoming frame, JSON-encoded from a plain object. */
  driverJson(message: unknown): void {
    this.driverMessage(JSON.stringify(message))
  }

  /** The transport reported an error. */
  driverError(): void {
    this.onerror?.()
  }

  /** The transport closed. */
  driverClose(): void {
    this.onclose?.()
  }

  /** Decode the `index`-th sent frame. */
  sentJson(index: number): Record<string, unknown> {
    return JSON.parse(this.sent[index]!) as Record<string, unknown>
  }
}
