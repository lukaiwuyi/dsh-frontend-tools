/**
 * Call forwarding: assigns each model invocation a `callId`, sends a `call`
 * frame to the owning connection, and settles the model-facing promise when
 * the matching `callResult` arrives (or fails fast when the connection drops
 * or the caller aborts).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { RemoteToolSpec } from 'dsh-frontend-tools-client'
import type { CallForwarder } from './registry.ts'

/** One in-flight forwarded call. */
interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** Removes the abort listener installed for this call. */
  detachAbort: () => void
  /** Cancels the timeout timer installed for this call. */
  clearTimeout: () => void
}

/** Frame sender installed by the connection layer; `undefined` while detached. */
export type FrameSender = (frame: string) => void

/**
 * Per-connection forwarder. The connection layer owns one instance per
 * authenticated socket and detaches it (rejecting everything in flight) on
 * close, so a forwarded call can never outlive its transport.
 *
 * Each forwarded call carries a timeout: an application that never answers
 * within `callTimeoutMs` rejects the model-facing promise (the model sees a
 * readable timeout error) and a late `callResult` is dropped, so one hung
 * application tool cannot pin a model loop forever.
 */
export class CallDispatcher {
  private readonly pending = new Map<string, PendingCall>()
  private sender: FrameSender | undefined

  /**
   * @param callTimeoutMs - per-call deadline in milliseconds; the promise
   *   rejects with a timeout error once it elapses without a `callResult`.
   */
  constructor(private readonly callTimeoutMs: number) {}

  /**
   * Install (or clear) the transport used to emit `call` frames.
   * @param sender - frame sender for the live session, or `undefined` once none remains.
   */
  attach(sender: FrameSender | undefined): void {
    this.sender = sender
  }

  /**
   * Forward one model invocation to the connection.
   *
   * The registry hands over the client's raw tool name; the public name never
   * travels back. Caller cancellation (`exec.signal`) rejects the promise
   * immediately; a late `callResult` for an abandoned call is dropped by
   * {@link settle}.
   * @param spec - the mirrored tool's client-side definition.
   * @param args - model-generated arguments, forwarded unchanged.
   * @param signal - caller cancellation; aborting rejects the call.
   * @returns the client's `callResult` value.
   */
  forward: CallForwarder = (spec: RemoteToolSpec, args: unknown, signal: AbortSignal): Promise<unknown> => {
    const sender = this.sender
    if (sender === undefined) {
      return Promise.reject(new Error(`frontend-tools call to "${spec.name}" failed: connection closed`))
    }
    const callId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const drop = (): void => { this.pending.delete(callId) }
      const onAbort = (): void => {
        // settle/rejectAll/timeout remove the listener with the pending entry,
        // so this handler only fires while the call is still pending.
        drop()
        reject(new Error(`frontend-tools call to "${spec.name}" was aborted by the caller`))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        drop()
        pending.detachAbort()
        reject(new Error(`frontend-tools call to "${spec.name}" timed out after ${this.callTimeoutMs}ms without a callResult`))
      }, this.callTimeoutMs)
      const pending: PendingCall = {
        resolve,
        reject,
        detachAbort: () => { signal.removeEventListener('abort', onAbort) },
        clearTimeout: () => { clearTimeout(timer) },
      }
      this.pending.set(callId, pending)
      sender(JSON.stringify({ type: 'call', callId, name: spec.name, args }))
    })
  }

  /**
   * Settle one promise with a received `callResult`.
   * @param callId - the call being settled.
   * @param ok - whether the client reported success.
   * @param value - the client's result value on success.
   * @param error - the client's structured failure on error.
   * @returns whether a pending call was settled (`false` = late or duplicate result, dropped).
   */
  settle(callId: string, ok: boolean, value: unknown, error: { code: string; message: string } | undefined): boolean {
    const pending = this.pending.get(callId)
    if (pending === undefined) return false
    this.pending.delete(callId)
    pending.detachAbort()
    pending.clearTimeout()
    if (ok) {
      pending.resolve(value)
    } else {
      pending.reject(new Error(error === undefined ? 'frontend-tools call failed without an error payload' : `frontend-tools call failed (${error.code}): ${error.message}`))
    }
    return true
  }

  /**
   * Reject every in-flight call (connection closed); no transport remains to settle them.
   * @param reason - failure text every pending caller promise rejects with.
   */
  rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.detachAbort()
      pending.clearTimeout()
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }
}
