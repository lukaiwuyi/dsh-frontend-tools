// Proves call-forwarding lifecycles in isolation: a forwarded call settles
// only through its matching callId, caller aborts reject immediately and drop
// late results, and detaching or draining the dispatcher rejects every
// in-flight call so none can outlive its transport.
import { describe, expect, it } from 'vitest'
import { CallDispatcher } from '../src/dispatch.ts'
import type { RemoteToolSpec } from 'dsh-frontend-tools-client'

const ECHO: RemoteToolSpec = { name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } }

/** One forwarded `call` frame as it appears on the wire. */
type Frame = { type: string; callId: string; name: string; args: unknown }

/** Start one forwarded call and capture the frame the transport received. */
function startCall(dispatcher: CallDispatcher): { promise: Promise<unknown>; frame: Frame } {
  const frames: Frame[] = []
  dispatcher.attach((frame) => { frames.push(JSON.parse(frame) as Frame) })
  const promise = dispatcher.forward(ECHO, { message: 'hi' }, new AbortController().signal)
  return { promise, frame: frames[0]! }
}

describe('CallDispatcher', () => {
  it('rejects a forward with no transport attached', async () => {
    const dispatcher = new CallDispatcher(30_000)
    dispatcher.attach(undefined)
    await expect(dispatcher.forward(ECHO, {}, new AbortController().signal)).rejects.toThrow('connection closed')
  })

  it('emits a call frame with the raw name and settles on the matching callResult', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const { promise, frame } = startCall(dispatcher)
    expect(frame.type).toBe('call')
    expect(frame.name).toBe('echo')
    expect(frame.args).toEqual({ message: 'hi' })
    expect(dispatcher.settle(frame.callId, true, { echoed: 'hi' }, undefined)).toBe(true)
    await expect(promise).resolves.toEqual({ echoed: 'hi' })
  })

  it('rejects on a failed callResult carrying the structured error', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const { promise, frame } = startCall(dispatcher)
    expect(dispatcher.settle(frame.callId, false, undefined, { code: 'denied', message: 'not logged in' })).toBe(true)
    await expect(promise).rejects.toThrow('(denied): not logged in')
  })

  it('rejects a failed callResult that arrived without an error payload', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const { promise, frame } = startCall(dispatcher)
    dispatcher.settle(frame.callId, false, undefined, undefined)
    await expect(promise).rejects.toThrow('without an error payload')
  })

  it('drops late or duplicate results for already-settled calls', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const { promise, frame } = startCall(dispatcher)
    expect(dispatcher.settle(frame.callId, true, { echoed: 'hi' }, undefined)).toBe(true)
    expect(dispatcher.settle(frame.callId, true, { echoed: 'again' }, undefined)).toBe(false)
    expect(dispatcher.settle('never-issued', true, {}, undefined)).toBe(false)
    await expect(promise).resolves.toEqual({ echoed: 'hi' })
  })

  it('rejects on caller abort and drops the late result', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const controller = new AbortController()
    const frames: string[] = []
    dispatcher.attach((frame) => { frames.push(frame) })
    const promise = dispatcher.forward(ECHO, {}, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('aborted by the caller')
    expect(dispatcher.settle((JSON.parse(frames[0]!) as Frame).callId, true, {}, undefined)).toBe(false)
  })

  it('keeps the settled value when the caller aborts after settlement', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const controller = new AbortController()
    const frames: Frame[] = []
    dispatcher.attach((frame) => { frames.push(JSON.parse(frame) as Frame) })
    const promise = dispatcher.forward(ECHO, {}, controller.signal)
    dispatcher.settle(frames[0]!.callId, true, { echoed: 'hi' }, undefined)
    controller.abort()
    await expect(promise).resolves.toEqual({ echoed: 'hi' })
  })

  it('rejects everything in flight when drained', async () => {
    const dispatcher = new CallDispatcher(30_000)
    const first = startCall(dispatcher)
    const second = startCall(dispatcher)
    dispatcher.rejectAll('frontend-tools connection closed before the call settled')
    await expect(first.promise).rejects.toThrow('connection closed before the call settled')
    await expect(second.promise).rejects.toThrow('connection closed before the call settled')
    // Drained calls can no longer settle.
    expect(dispatcher.settle(second.frame.callId, true, {}, undefined)).toBe(false)
  })

  it('rejects on timeout and drops the late result', async () => {
    const dispatcher = new CallDispatcher(20)
    const { promise, frame } = startCall(dispatcher)
    await expect(promise).rejects.toThrow('timed out after 20ms without a callResult')
    // The timed-out call can no longer settle.
    expect(dispatcher.settle(frame.callId, true, { late: true }, undefined)).toBe(false)
  })

  it('keeps a timeout-armed call alive until its callResult lands', async () => {
    const dispatcher = new CallDispatcher(60_000)
    const { promise, frame } = startCall(dispatcher)
    dispatcher.settle(frame.callId, true, { echoed: 'hi' }, undefined)
    await expect(promise).resolves.toEqual({ echoed: 'hi' })
  })
})
