// Proves the public client handle: the connecting/connected/disconnected
// transitions with their listeners, registerTools settling through the
// server's confirmation (or rejecting when the connection dies first),
// that a forwarded call reaches the application's execute body, the
// unregisterTools surface, and automatic reconnection with re-registration.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFrontendToolsClient, FrontendToolsError, PROTOCOL_VERSION } from '../src/index.ts'
import type { FrontendTool, FrontendToolsClient } from '../src/index.ts'
import { FakeSocket } from './fake-socket.ts'

afterEach(() => {
  FakeSocket.reset()
  vi.useRealTimers()
})

const OPTIONS = { url: 'ws://127.0.0.1:31870', key: 'secret', socket: FakeSocket }

const ECHO: FrontendTool = {
  name: 'echo',
  description: 'echo it back',
  parametersSchema: { type: 'object' },
  async execute(args: unknown) {
    return { echoed: (args as { message?: unknown }).message }
  },
}

/** A client whose scripted socket completed the handshake. */
async function connectedClient(): Promise<{ client: FrontendToolsClient; socket: FakeSocket }> {
  const client = createFrontendToolsClient(OPTIONS)
  const pending = client.connect()
  const socket = FakeSocket.latest
  socket.driverOpen()
  socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'frontend-tools-bridge', namespace: 'eatc' })
  await pending
  return { client, socket }
}

describe('createFrontendToolsClient · lifecycle', () => {
  it('walks connecting → connected and notifies listeners', async () => {
    const client = createFrontendToolsClient(OPTIONS)
    const states: string[] = []
    client.onStateChange(state => states.push(state))
    const pending = client.connect()
    const socket = FakeSocket.latest
    socket.driverOpen()
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'x', namespace: 'eatc' })
    await pending
    expect(client.state).toBe('connected')
    expect(client.namespace).toBe('eatc')
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('returns to disconnected when the handshake fails', async () => {
    const client = createFrontendToolsClient(OPTIONS)
    const pending = client.connect()
    const socket = FakeSocket.latest
    socket.driverOpen()
    socket.driverJson({ type: 'error', code: 'auth_failed', message: 'key rejected' })
    await expect(pending).rejects.toThrow('key rejected')
    expect(client.state).toBe('disconnected')
  })

  it('refuses to reconnect after an explicit disconnect', async () => {
    const { client, socket } = await connectedClient()
    client.disconnect()
    expect(socket.closed).toBe(true)
    await expect(client.connect()).rejects.toThrow('client was disconnected')
  })

  it('stops notifying an unsubscribed listener', async () => {
    const client = createFrontendToolsClient(OPTIONS)
    const states: string[] = []
    const unsubscribe = client.onStateChange(state => states.push(state))
    unsubscribe()
    const pending = client.connect()
    const socket = FakeSocket.latest
    socket.driverOpen()
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'x', namespace: 'eatc' })
    await pending
    expect(states).toEqual([])
  })
})

describe('createFrontendToolsClient · registration', () => {
  it('resolves with the public names the server confirmed', async () => {
    const { client, socket } = await connectedClient()
    const pending = client.registerTools([ECHO])
    expect(socket.sentJson(1)).toEqual({
      type: 'register',
      tools: [{ name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } }],
    })
    socket.driverJson({ type: 'registered', names: ['eatc__echo'] })
    await expect(pending).resolves.toEqual(['eatc__echo'])
  })

  it('rejects the waiter when the connection drops before confirmation, then schedules a reconnect', async () => {
    const { client, socket } = await connectedClient()
    const pending = client.registerTools([ECHO])
    socket.driverClose()
    await expect(pending).rejects.toThrow('before registration was confirmed')
    expect(client.state).toBe('reconnecting')
    client.disconnect()
  })

  it('rejects immediately when the transport refuses the send', async () => {
    const client = createFrontendToolsClient(OPTIONS)
    await expect(client.registerTools([ECHO])).rejects.toThrow(FrontendToolsError)
  })

  it('drops an unsolicited confirmation without failing', async () => {
    const { socket } = await connectedClient()
    socket.driverJson({ type: 'registered', names: ['eatc__ghost'] })
    expect(socket.sent).toHaveLength(1)
  })
})

describe('createFrontendToolsClient · forwarded calls', () => {
  it('dispatches a call frame to the registered execute body and answers', async () => {
    const { client, socket } = await connectedClient()
    const pending = client.registerTools([ECHO])
    socket.driverJson({ type: 'registered', names: ['eatc__echo'] })
    await pending

    socket.driverJson({ type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' } })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(socket.sentJson(2)).toEqual({ type: 'callResult', callId: 'c1', ok: true, result: { echoed: 'hi' } })
  })
})

describe('createFrontendToolsClient · unregistration', () => {
  it('treats an empty unregister batch as a confirmed no-op', async () => {
    const { client, socket } = await connectedClient()
    await expect(client.unregisterTools([])).resolves.toEqual([])
    expect(socket.sent).toHaveLength(1)
  })

  it('removes tools on the confirmed raw names and keeps them callable-free', async () => {
    const { client, socket } = await connectedClient()
    const pending = client.registerTools([ECHO])
    socket.driverJson({ type: 'registered', names: ['eatc__echo'] })
    await pending

    const removing = client.unregisterTools(['echo'])
    expect(socket.sentJson(2)).toEqual({ type: 'unregister', names: ['echo'] })
    socket.driverJson({ type: 'unregistered', names: ['echo'] })
    await expect(removing).resolves.toEqual(['echo'])

    // The executor no longer dispatches the removed tool's calls.
    socket.driverJson({ type: 'call', callId: 'c9', name: 'echo', args: {} })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(socket.sentJson(3)).toEqual({ type: 'callResult', callId: 'c9', ok: false, error: { code: 'unknown_tool', message: expect.any(String) as string } })
  })

  it('rejects the waiter when the connection drops before removal was confirmed', async () => {
    const { client, socket } = await connectedClient()
    const pending = client.unregisterTools(['echo'])
    socket.driverClose()
    await expect(pending).rejects.toThrow('before removal was confirmed')
    client.disconnect()
  })

  it('rejects immediately when the transport refuses the send', async () => {
    const client = createFrontendToolsClient(OPTIONS)
    await expect(client.unregisterTools(['echo'])).rejects.toThrow(FrontendToolsError)
  })
})

describe('createFrontendToolsClient · automatic reconnection', () => {
  /** Complete the handshake on the given fresh socket instance index. */
  const welcome = (socket: FakeSocket): void => {
    socket.driverOpen()
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'x', namespace: 'eatc' })
  }

  it('reconnects after a drop and re-registers every tool still held', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    const pending = client.registerTools([ECHO])
    socket.driverJson({ type: 'registered', names: ['eatc__echo'] })
    await pending

    socket.driverClose()
    expect(client.state).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(1_000)
    const replacement = FakeSocket.instances[1]!
    welcome(replacement)
    expect(client.state).toBe('connected')
    // Let the connect() settlement run its re-registration microtask chain.
    await vi.advanceTimersByTimeAsync(0)
    // The recovered session re-sent the register batch before anything else.
    expect(replacement.sentJson(0)).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION, key: 'secret' })
    expect(replacement.sentJson(1)).toEqual({
      type: 'register',
      tools: [{ name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } }],
    })
    client.disconnect()
  })

  it('reconnects without re-registering when no tools remain', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    socket.driverClose()

    await vi.advanceTimersByTimeAsync(1_000)
    const replacement = FakeSocket.instances[1]!
    welcome(replacement)
    expect(client.state).toBe('connected')
    expect(replacement.sent).toHaveLength(1)
    client.disconnect()
  })

  it('doubles the backoff while the bridge stays unreachable', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    socket.driverClose()

    // First attempt (after 1s) fails before the handshake; the retry doubles.
    await vi.advanceTimersByTimeAsync(1_000)
    const first = FakeSocket.instances[1]!
    first.driverOpen()
    first.driverError()
    expect(client.state).toBe('reconnecting')

    // The second attempt only fires after 2s more, not after 1s.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeSocket.instances).toHaveLength(3)
    client.disconnect()
  })

  it('stops retrying once disconnect() cancels a pending reconnect', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    socket.driverClose()
    expect(client.state).toBe('reconnecting')

    client.disconnect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(client.state).toBe('disconnected')
  })

  it('stays down after a drop when reconnect is disabled', async () => {
    const { client, socket } = await connectedClient()
    void socket
    const lone = createFrontendToolsClient({ ...OPTIONS, reconnect: false })
    const pending = lone.connect()
    const loneSocket = FakeSocket.latest
    welcome(loneSocket)
    await pending

    loneSocket.driverClose()
    expect(lone.state).toBe('disconnected')
    lone.disconnect()
    client.disconnect()
  })
})
