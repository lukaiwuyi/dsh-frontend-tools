// Proves the connection state machine against a real loopback socket: the
// roster key handshake, one-session-per-namespace ownership, mirrored
// registration on ctx.tools, call forwarding with raw names, and the cleanup
// obligations — a dropped or terminated client unregisters its tools and
// rejects in-flight calls, and disposal closes the listener without leaving
// state behind. Production hardening paths: the bridge-wide tool budget, the
// unregister round trip, per-call timeouts, the liveness heartbeat, and
// concurrent clients under distinct namespaces.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from 'dsh-frontend-tools-client'
import { BridgeServer, ClientRoster } from '../src/index.ts'

const KEY = 'eatc-secret'
const OTHER_KEY = 'demo-secret'
const ECHO_SPEC = { name: 'echo', description: 'echo it back', parametersSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }

let ctx: Context | undefined
let server: BridgeServer | undefined

afterEach(async () => {
  vi.useRealTimers()
  server?.dispose()
  server = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Build an in-memory roster over a fresh temp directory (static entries never touch disk). */
function makeRoster(
  clients: ReadonlyArray<{ namespace: string; key: string }> = [{ namespace: 'eatc', key: KEY }],
): ClientRoster {
  return ClientRoster.load(mkdtempSync(join(tmpdir(), 'ftb-')), clients)
}

async function setup(
  overrides: Partial<{ callTimeoutMs: number; maxTools: number; roster: ClientRoster }> = {},
): Promise<BridgeServer> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  server = new BridgeServer(ctx, { port: 0, callTimeoutMs: 30_000, maxTools: 200, ...overrides }, overrides.roster ?? makeRoster())
  await server.start()
  return server
}

/** One decoded server frame as received on the wire. */
type Frame = { type: string } & Record<string, unknown>

/** One connected test client with a per-frame receive queue. */
interface TestClient {
  next(): Promise<Frame>
  send(frame: unknown): void
  sendRaw(data: Buffer): void
  close(): Promise<void>
  /** Resolves once the socket closed, including a server-side termination. */
  waitClosed(): Promise<void>
}

function connect(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const frames: string[] = []
    const waiters: Array<(frame: string) => void> = []
    let onClosed!: () => void
    const closed = new Promise<void>((resolveClose) => { onClosed = resolveClose })
    socket.on('message', (data: unknown) => {
      const raw = String(data)
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(raw)
      else frames.push(raw)
    })
    socket.on('close', () => { onClosed() })
    socket.once('error', (error) => { reject(error) })
    socket.on('open', () => {
      resolve({
        next: () => new Promise((resolveNext) => {
          const buffered = frames.shift()
          if (buffered !== undefined) resolveNext(JSON.parse(buffered) as Frame)
          else waiters.push((raw) => { resolveNext(JSON.parse(raw) as Frame) })
        }),
        send: (frame) => { socket.send(JSON.stringify(frame)) },
        sendRaw: (data) => { socket.send(data) },
        close: () => {
          socket.close()
          return closed
        },
        waitClosed: () => closed,
      })
    })
  })
}

/** Complete the handshake for the default `eatc` namespace and return the session-holding client. */
async function handshake(port: number, key: string = KEY): Promise<TestClient> {
  const client = await connect(port)
  client.send({ type: 'hello', protocol: PROTOCOL_VERSION, key })
  await expect(client.next()).resolves.toMatchObject({ type: 'welcome', protocol: PROTOCOL_VERSION })
  return client
}

/** Register the echo tool; resolves once the server confirmed it under the `eatc` prefix. */
async function registerEcho(client: TestClient): Promise<void> {
  client.send({ type: 'register', tools: [ECHO_SPEC] })
  await expect(client.next()).resolves.toMatchObject({ type: 'registered', names: ['eatc__echo'] })
}

/** Liveness probe: register a fresh tool name (re-registering an owned name is an error by contract). */
async function registerProbe(client: TestClient, name: string): Promise<void> {
  client.send({ type: 'register', tools: [{ ...ECHO_SPEC, name }] })
  await expect(client.next()).resolves.toMatchObject({ type: 'registered' })
}

/** Drive one mirrored call through ctx.tools and answer the forwarded frame. */
async function callEcho(
  server: BridgeServer,
  client: TestClient,
  args: unknown,
  answer: (callId: string) => void,
): Promise<{ isError: boolean; value?: unknown }> {
  const pending = ctx!.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`server-call-${server.port}`),
    name: 'eatc__echo',
    arguments: args,
  })
  const call = await client.next()
  expect(call.type).toBe('call')
  answer(call.callId as string)
  return pending.then(result => result, () => ({ isError: true }))
}

const tick = (ms = 25): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('BridgeServer · handshake', () => {
  it('accepts a correct hello with a welcome echoing the key namespace', async () => {
    const server = await setup()
    expect(server.port).toBeTypeOf('number')
    const client = await connect(server.port!)
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: KEY })
    await expect(client.next()).resolves.toMatchObject({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'frontend-tools-bridge', namespace: 'eatc' })
    expect(server.hasSession).toBe(true)
    await client.close()
  })

  it('rejects an unknown key and closes the socket', async () => {
    const server = await setup()
    const client = await connect(server.port!)
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: 'wrong' })
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'auth_failed' })
    await client.close()
    expect(server.hasSession).toBe(false)
  })

  it('rejects an unsupported protocol version as invalid_message', async () => {
    const server = await setup()
    const client = await connect(server.port!)
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION + 1, key: KEY })
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_message' })
    await client.close()
  })

  it('rejects non-JSON frames and session vocabulary before the handshake', async () => {
    const server = await setup()
    const raw = await connect(server.port!)
    // A syntactically invalid JSON text frame exercises the malformed-frame path.
    raw.send('{not json')
    await expect(raw.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_message' })
    await raw.close()

    const eager = await connect(server.port!)
    eager.send({ type: 'register', tools: [ECHO_SPEC] })
    await expect(eager.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_message' })
    await eager.close()
  })

  it('rejects binary payloads as invalid_message without breaking the server', async () => {
    const server = await setup()
    const client = await connect(server.port!)
    // ws delivers binary frames as Buffers too; the bytes then fail JSON
    // decoding, which proves opaque binary input cannot crash the bridge.
    client.sendRaw(Buffer.from([0x00, 0x01, 0x02]))
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_message' })
    await client.close()
  })

  it('rejects a second hello after the handshake completed', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: KEY })
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_message' })
    await client.close()
  })
})

describe('BridgeServer · session ownership', () => {
  it('refuses a second connection for the same namespace while one holds it', async () => {
    const server = await setup()
    const owner = await handshake(server.port!)
    const second = await connect(server.port!)
    second.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: KEY })
    await expect(second.next()).resolves.toMatchObject({ type: 'error', code: 'duplicate_connection' })
    await second.close()
    // The owner keeps the session.
    expect(server.hasSession).toBe(true)
    await registerEcho(owner)
    await owner.close()
  })

  it('refuses a hello from a pending socket once another completed it', async () => {
    const server = await setup()
    const first = await connect(server.port!)
    const second = await connect(server.port!)
    first.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: KEY })
    second.send({ type: 'hello', protocol: PROTOCOL_VERSION, key: KEY })
    await expect(second.next()).resolves.toMatchObject({ type: 'error', code: 'duplicate_connection' })
    await second.close()
    await expect(first.next()).resolves.toMatchObject({ type: 'welcome' })
    await first.close()
  })

  it('serves two namespaces concurrently with isolated public-name prefixes', async () => {
    const server = await setup({ roster: makeRoster([{ namespace: 'eatc', key: KEY }, { namespace: 'demo', key: OTHER_KEY }]) })
    const eatc = await handshake(server.port!)
    const demo = await handshake(server.port!, OTHER_KEY)
    await registerEcho(eatc)
    demo.send({ type: 'register', tools: [ECHO_SPEC] })
    await expect(demo.next()).resolves.toMatchObject({ type: 'registered', names: ['demo__echo'] })
    expect(new Set(ctx!.tools.schemas().map(s => s.name))).toEqual(new Set(['eatc__echo', 'demo__echo']))

    // One namespace dropping leaves the other fully operational.
    await eatc.close()
    await tick()
    expect(server.hasSession).toBe(true)
    expect(server.sessionInfo('eatc')).toEqual({ connected: false, toolCount: 0 })
    expect(server.sessionInfo('demo')).toEqual({ connected: true, toolCount: 1 })
    expect(ctx!.tools.schemas().map(s => s.name)).toEqual(['demo__echo'])
    await demo.close()
  })

  it('releases the session when the owner closes and accepts a replacement', async () => {
    const server = await setup()
    const first = await handshake(server.port!)
    await registerEcho(first)
    await first.close()
    await tick()
    expect(server.hasSession).toBe(false)
    expect(ctx!.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')

    const replacement = await handshake(server.port!)
    expect(server.hasSession).toBe(true)
    await replacement.close()
  })

  it('keeps the session when a pending socket closes without handshaking', async () => {
    const server = await setup()
    const owner = await handshake(server.port!)
    const pending = await connect(server.port!)
    await pending.close()
    await tick()
    expect(server.hasSession).toBe(true)
    await registerEcho(owner)
    await owner.close()
  })

  it('drops a live session on demand so a revoked credential stops serving tools', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    expect(server.dropSession('eatc')).toBe(true)
    await client.waitClosed()
    await tick()
    expect(server.hasSession).toBe(false)
    expect(ctx!.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')
    expect(server.dropSession('eatc')).toBe(false)
  })
})

describe('BridgeServer · registration and forwarding', () => {
  it('answers a duplicate registration with a non-fatal error and stays usable', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    client.send({ type: 'register', tools: [ECHO_SPEC] })
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_tool' })
    // The connection survived: a different tool registers fine.
    client.send({ type: 'register', tools: [{ ...ECHO_SPEC, name: 'echo2' }] })
    await expect(client.next()).resolves.toMatchObject({ type: 'registered', names: ['eatc__echo2'] })
    await client.close()
  })

  it('forwards a model call with the raw name and returns the client result', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    const result = await callEcho(server, client, { message: 'hi' }, (callId) => {
      client.send({ type: 'callResult', callId, ok: true, result: { echoed: 'hi' } })
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ echoed: 'hi' })
    await client.close()
  })

  it('surfaces a failed callResult as an errored execution', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    const result = await callEcho(server, client, { message: 'hi' }, (callId) => {
      client.send({ type: 'callResult', callId, ok: false, error: { code: 'denied', message: 'not logged in' } })
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('drops a callResult for an unknown callId without breaking the session', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    client.send({ type: 'callResult', callId: 'never-issued', ok: true, result: {} })
    await tick()
    expect(server.hasSession).toBe(true)
    await registerProbe(client, 'still-alive')
    await client.close()
  })

  it('rejects the model call when the caller aborts and drops the late result', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    const controller = new AbortController()
    const pending = ctx!.tools.execute({
      signal: controller.signal,
      callId: CallId('server-call-abort'),
      name: 'eatc__echo',
      arguments: { message: 'hi' },
    })
    const call = await client.next()
    controller.abort()
    const result = await pending.then(r => r, () => ({ isError: true as const }))
    expect(result.isError).toBe(true)
    client.send({ type: 'callResult', callId: call.callId as string, ok: true, result: {} })
    await tick()
    // The dropped result did not fail the connection.
    await registerProbe(client, 'still-alive')
    await client.close()
  })

  it('rejects an in-flight call when the client disconnects', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    const pending = ctx!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('server-call-drop'),
      name: 'eatc__echo',
      arguments: { message: 'hi' },
    })
    await client.next()
    await client.close()
    const result = await pending.then(r => r, () => ({ isError: true as const }))
    expect(result.isError).toBe(true)
  })
})

describe('BridgeServer · disposal', () => {
  it('terminates every session, unregisters their tools, and stops listening', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)
    const closed = client.close()
    server.dispose()
    await closed
    await tick()
    expect(server.hasSession).toBe(false)
    expect(server.port).toBeUndefined()
    expect(ctx!.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')
  })

  it('disposes safely before start and with only pending sockets', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const unstarted = new BridgeServer(ctx, { port: 0, callTimeoutMs: 30_000, maxTools: 200 }, makeRoster())
    unstarted.dispose()
    expect(unstarted.port).toBeUndefined()
    expect(unstarted.hasSession).toBe(false)

    const started = new BridgeServer(ctx, { port: 0, callTimeoutMs: 30_000, maxTools: 200 }, makeRoster())
    await started.start()
    const pending = await connect(started.port!)
    started.dispose()
    await tick()
    expect(started.hasSession).toBe(false)
    void pending
  })

  it('fails loud when the configured port is already taken', async () => {
    const server = await setup()
    const second = new BridgeServer(ctx!, { port: server.port!, callTimeoutMs: 30_000, maxTools: 200 }, makeRoster())
    await expect(second.start()).rejects.toThrow()
    second.dispose()
  })
})

describe('BridgeServer · tool budget', () => {
  it('refuses a register batch that would exceed the limit, non-fatally', async () => {
    const server = await setup({ maxTools: 1 })
    const client = await handshake(server.port!)
    await registerEcho(client)
    client.send({ type: 'register', tools: [{ ...ECHO_SPEC, name: 'echo2' }] })
    await expect(client.next()).resolves.toMatchObject({ type: 'error', code: 'too_many_tools' })

    // The session survived: the owned tool still forwards calls.
    const result = await callEcho(server, client, { message: 'hi' }, (callId) => {
      client.send({ type: 'callResult', callId, ok: true, result: { echoed: 'hi' } })
    })
    expect(result.isError).toBe(false)
    await client.close()
  })

  it('shares one bridge-wide budget across concurrent clients', async () => {
    const server = await setup({ maxTools: 1, roster: makeRoster([{ namespace: 'eatc', key: KEY }, { namespace: 'demo', key: OTHER_KEY }]) })
    const eatc = await handshake(server.port!)
    await registerEcho(eatc)
    const demo = await handshake(server.port!, OTHER_KEY)
    demo.send({ type: 'register', tools: [ECHO_SPEC] })
    await expect(demo.next()).resolves.toMatchObject({ type: 'error', code: 'too_many_tools' })
    await eatc.close()
    await demo.close()
  })
})

describe('BridgeServer · unregistration', () => {
  it('removes owned tools and frees their public names for re-registration', async () => {
    const server = await setup()
    const client = await handshake(server.port!)
    await registerEcho(client)

    client.send({ type: 'unregister', names: ['echo', 'ghost'] })
    await expect(client.next()).resolves.toMatchObject({ type: 'unregistered', names: ['echo'] })
    expect(ctx!.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')

    // The freed public name is registrable again on the same connection.
    await registerEcho(client)
    await client.close()
  })
})

describe('BridgeServer · call timeout', () => {
  it('rejects a call whose client never answers and drops the late result', async () => {
    const server = await setup({ callTimeoutMs: 80 })
    const client = await handshake(server.port!)
    await registerEcho(client)
    const pending = ctx!.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('server-call-timeout'),
      name: 'eatc__echo',
      arguments: { message: 'hi' },
    })
    const call = await client.next()
    expect(call.type).toBe('call')

    const result = await pending.then(r => r, () => ({ isError: true as const }))
    expect(result.isError).toBe(true)

    // The late answer is dropped without breaking the session.
    client.send({ type: 'callResult', callId: call.callId as string, ok: true, result: {} })
    await tick()
    await registerProbe(client, 'still-alive')
    await client.close()
  })
})

describe('BridgeServer · heartbeat', () => {
  /** Liveness probe period, mirrored from the server's wire constant. */
  const INTERVAL = 15_000

  // Fake only the timer primitives the heartbeat uses: ws schedules its send
  // flush through setImmediate, which must stay real for frames to reach the
  // loopback peer while the test advances the clock. The clock must be fake
  // BEFORE the handshake: the heartbeat interval registers at `welcome` time
  // and already-captured real timers would never advance.
  const fakeHeartbeatClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
  }

  /** Flush one ws frame through the real setImmediate queue (never faked). */
  const flushLoopback = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  it('probes with ping and keeps the session while pongs answer', async () => {
    const server = await setup()
    fakeHeartbeatClock()
    const client = await handshake(server.port!)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await expect(client.next()).resolves.toMatchObject({ type: 'ping' })
    client.send({ type: 'pong' })
    // Let the pong reach the server before the next probe period judges it.
    await flushLoopback()

    // The answered probe did not flag the session dead: the next period
    // sends another ping instead of terminating.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await expect(client.next()).resolves.toMatchObject({ type: 'ping' })
    vi.useRealTimers()
    await client.close()
  })

  it('terminates the session when a ping stays unanswered', async () => {
    const server = await setup()
    fakeHeartbeatClock()
    const client = await handshake(server.port!)
    await registerEcho(client)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await expect(client.next()).resolves.toMatchObject({ type: 'ping' })
    // No pong: the next period kills the socket, which owns the cleanup chain.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await client.waitClosed()
    vi.useRealTimers()
    await tick()
    expect(server.hasSession).toBe(false)
    expect(ctx!.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')
  })

  it('drops only the dead namespace when one client stops answering probes', async () => {
    const server = await setup({ roster: makeRoster([{ namespace: 'eatc', key: KEY }, { namespace: 'demo', key: OTHER_KEY }]) })
    fakeHeartbeatClock()
    const eatc = await handshake(server.port!)
    const demo = await handshake(server.port!, OTHER_KEY)
    await registerEcho(eatc)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    // Answer only for eatc; demo's probe stays pending.
    await expect(eatc.next()).resolves.toMatchObject({ type: 'ping' })
    eatc.send({ type: 'pong' })
    // Let the pong reach the server before the next probe period judges it.
    await flushLoopback()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await demo.waitClosed()
    vi.useRealTimers()
    await tick()
    expect(server.hasSession).toBe(true)
    expect(server.sessionInfo('demo').connected).toBe(false)
    expect(ctx!.tools.schemas().map(s => s.name)).toContain('eatc__echo')
    await eatc.close()
  })
})
