// Proves the connection layer against a scripted transport: the hello
// handshake and its failure modes (server error, transport error, close
// before welcome, malformed frames), register/call exchange after the
// welcome, and that no path sends on a dead or half-open socket.
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeConnection, FrontendToolsError, PROTOCOL_VERSION } from '../src/index.ts'
import type { ConnectionHandlers } from '../src/index.ts'
import { FakeSocket } from './fake-socket.ts'

afterEach(() => {
  FakeSocket.reset()
})

const OPTIONS = { url: 'ws://127.0.0.1:31870', key: 'secret', socket: FakeSocket }

/** Begin connecting; the scripted socket exists and `hello` is already sent. */
function began(handlers: ConnectionHandlers = {}): { connection: BridgeConnection; socket: FakeSocket; pending: Promise<void> } {
  const connection = new BridgeConnection(OPTIONS, handlers)
  const pending = connection.connect()
  const socket = FakeSocket.latest
  socket.driverOpen()
  return { connection, socket, pending }
}

/** Complete the handshake; resolves once `welcome` settled the connect(). */
async function connected(handlers: ConnectionHandlers = {}): Promise<{ connection: BridgeConnection; socket: FakeSocket }> {
  const { connection, socket, pending } = began(handlers)
  socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'frontend-tools-bridge', namespace: 'eatc' })
  await pending
  return { connection, socket }
}

describe('BridgeConnection · handshake', () => {
  it('sends hello on open and resolves on welcome', async () => {
    const { connection, socket } = await connected()
    expect(socket.sentJson(0)).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION, key: 'secret' })
    expect(connection.currentState).toBe('connected')
  })

  it('exposes the bound namespace only after the welcome', async () => {
    const { connection, pending } = began()
    expect(connection.namespace).toBeUndefined()
    FakeSocket.latest.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'frontend-tools-bridge', namespace: 'eatc' })
    await pending
    expect(connection.namespace).toBe('eatc')
  })

  it('rejects a connect while not disconnected', async () => {
    const { connection, socket, pending } = began()
    await expect(connection.connect()).rejects.toThrow('requires a disconnected client')
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'x', namespace: 'eatc' })
    await pending
  })

  it('rejects a welcome with an unsupported protocol and closes the socket', async () => {
    const { connection, socket, pending } = began()
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION + 1, server: 'x', namespace: 'eatc' })
    await expect(pending).rejects.toThrow('unsupported protocol')
    expect(socket.closed).toBe(true)
    expect(connection.currentState).toBe('disconnected')
  })

  it('rejects a malformed frame and closes the socket', async () => {
    const { socket, pending } = began()
    socket.driverMessage('{not json')
    await expect(pending).rejects.toThrow(FrontendToolsError)
    expect(socket.closed).toBe(true)
  })

  it('rejects on a transport error before the handshake', async () => {
    const { socket, pending } = began()
    socket.driverError()
    await expect(pending).rejects.toThrow('failed before the handshake completed')
  })

  it('rejects when the socket closes before welcome', async () => {
    const { socket, pending } = began()
    socket.driverClose()
    await expect(pending).rejects.toThrow('closed before the handshake completed')
  })

  it('rejects with the server error code and survives a throwing close', async () => {
    const { socket, pending } = began()
    socket.closeThrows = true
    socket.driverJson({ type: 'error', code: 'auth_failed', message: 'key rejected' })
    await expect(pending).rejects.toThrow('key rejected')
  })

  it('ignores a duplicate welcome after the handshake settled', async () => {
    const { connection, socket } = await connected()
    socket.driverJson({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'x', namespace: 'eatc' })
    expect(connection.currentState).toBe('connected')
  })

  it('reports the fatal error frame through onDisconnected when the server closes', async () => {
    const disconnected: unknown[] = []
    const { connection, socket } = await connected({ onDisconnected: fatal => disconnected.push(fatal) })
    socket.driverJson({ type: 'error', code: 'duplicate_connection', message: 'replaced' })
    socket.driverClose()
    expect(connection.currentState).toBe('disconnected')
    expect(disconnected).toEqual([{ type: 'error', code: 'duplicate_connection', message: 'replaced' }])
  })

  it('reports onDisconnected without a fatal frame on a bare close', async () => {
    const disconnected: unknown[] = []
    const { connection, socket } = await connected({ onDisconnected: fatal => disconnected.push(fatal) })
    socket.driverClose()
    expect(disconnected).toEqual([undefined])
    expect(connection.currentState).toBe('disconnected')
  })
})

describe('BridgeConnection · session traffic', () => {
  it('sends a register batch as given', async () => {
    const { connection, socket } = await connected()
    connection.registerTools([{
      name: 'echo',
      description: 'echo it back',
      parametersSchema: { type: 'object' },
    }])
    expect(socket.sentJson(1)).toEqual({
      type: 'register',
      tools: [{ name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } }],
    })
  })

  it('refuses to register while not connected', () => {
    const connection = new BridgeConnection(OPTIONS, {})
    expect(() => {
      connection.registerTools([{ name: 'echo', description: 'echo', parametersSchema: { type: 'object' } }])
    }).toThrow(FrontendToolsError)
  })

  it('sends an unregister batch as given', async () => {
    const { connection, socket } = await connected()
    connection.unregisterTools(['echo', 'probe'])
    expect(socket.sentJson(1)).toEqual({ type: 'unregister', names: ['echo', 'probe'] })
  })

  it('refuses to unregister while not connected', () => {
    const connection = new BridgeConnection(OPTIONS, {})
    expect(() => { connection.unregisterTools(['echo']) }).toThrow(FrontendToolsError)
  })

  it('answers a server ping with a pong immediately', async () => {
    const { socket } = await connected()
    socket.driverJson({ type: 'ping' })
    expect(socket.sentJson(1)).toEqual({ type: 'pong' })
  })

  it('reports an unregistered batch through onUnregistered', async () => {
    const batches: string[][] = []
    const { socket } = await connected({ onUnregistered: message => batches.push([...message.names]) })
    socket.driverJson({ type: 'unregistered', names: ['echo'] })
    expect(batches).toEqual([['echo']])
  })

  it('answers a call with the settled outcome', async () => {
    const { socket } = await connected({
      onCall: async () => ({ ok: true, result: { echoed: 'hi' } }),
    })
    socket.driverJson({ type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' } })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(socket.sentJson(1)).toEqual({ type: 'callResult', callId: 'c1', ok: true, result: { echoed: 'hi' } })
  })

  it('answers a failing call with its structured error', async () => {
    const { socket } = await connected({
      onCall: async () => ({ ok: false, error: { code: 'denied', message: 'not logged in' } }),
    })
    socket.driverJson({ type: 'call', callId: 'c2', name: 'echo', args: {} })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(socket.sentJson(1)).toEqual({ type: 'callResult', callId: 'c2', ok: false, error: { code: 'denied', message: 'not logged in' } })
  })

  it('ignores a call frame when no onCall handler is installed', async () => {
    const { socket } = await connected()
    socket.driverJson({ type: 'call', callId: 'c3', name: 'echo', args: {} })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(socket.sent).toHaveLength(1)
  })

  it('closes the transport on disconnect and tolerates a missing socket', async () => {
    const { connection, socket } = await connected()
    connection.disconnect()
    expect(socket.closed).toBe(true)
    const neverConnected = new BridgeConnection(OPTIONS, {})
    neverConnected.disconnect()
  })
})
