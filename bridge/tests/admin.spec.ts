// Proves the model-facing admin tools end to end through `ctx.tools.execute`:
// registering an application-provided DSH KEY authenticates it (and
// re-registering invalidates the old credential) without ever echoing the
// key in tool output, listing reports namespaces with live session facts
// and never a key, revoking removes the credential and drops its live
// connection in one step, and the disposer removes every admin tool.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, generateClientKey } from 'dsh-frontend-tools-client'
import { BridgeServer, ClientRoster, registerAdminTools } from '../src/index.ts'

const STATIC_KEY = 'static-secret'
/** Deterministic application-style key for repeatable assertions. */
const KEY_A = 'aa'.repeat(32)
const KEY_B = 'bb'.repeat(32)

let ctx: Context | undefined
let server: BridgeServer | undefined
let disposeAdmin: (() => void) | undefined

afterEach(async () => {
  disposeAdmin?.()
  disposeAdmin = undefined
  server?.dispose()
  server = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Boot the tool runtime, a roster-backed server on an ephemeral port, and the admin tools. */
async function setup(options: { start?: boolean } = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const roster = ClientRoster.load(
    mkdtempSync(join(tmpdir(), 'ftb-admin-')),
    [{ namespace: 'eatc', key: STATIC_KEY }],
  )
  server = new BridgeServer(ctx, { port: 0, callTimeoutMs: 5_000, maxTools: 200 }, roster)
  disposeAdmin = registerAdminTools(ctx, {
    roster,
    port: () => server!.port,
    sessionInfo: namespace => server!.sessionInfo(namespace),
    dropSession: namespace => server!.dropSession(namespace),
  })
  if (options.start !== false) await server.start()
}

/** Execute one admin tool by its model-facing name. */
async function run(name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx!.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`admin-${name}-${Math.random()}`),
    name,
    arguments: args,
  })
}

/** One raw connected socket that has completed the hello handshake, or the error frame it got. */
async function authenticated(key: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const decide = (frame: { type: string; code?: string }, socket: WebSocket): { ok: true } | { ok: false; code: string } => {
    socket.close()
    return frame.type === 'welcome' ? { ok: true } : { ok: false, code: frame.code ?? 'unknown' }
  }
  const { closed, ...outcome } = await openSession(key, decide)
  void closed
  return outcome
}

/**
 * Open one session and hand the first server frame to `decide`, which may
 * close the socket or keep it open; the returned value is `decide`'s outcome
 * plus a `closed` promise for sockets the server terminates later.
 */
async function openSession<T>(
  key: string,
  decide: (frame: { type: string; code?: string }, socket: WebSocket) => T,
): Promise<T & { closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server!.port}`)
    let onClosed!: () => void
    const closed = new Promise<void>((resolveClose) => { onClosed = resolveClose })
    socket.once('error', (error) => { reject(error) })
    socket.on('close', () => { onClosed() })
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, key }))
    })
    socket.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data)) as { type: string; code?: string }
      socket.removeAllListeners('message')
      const outcome = decide(frame, socket)
      resolve({ ...outcome, closed })
    })
  })
}

const tick = (ms = 25): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('admin tools · register', () => {
  it('registers an SDK-generated key that authenticates, without echoing the key', async () => {
    await setup()
    const key = generateClientKey()
    const result = await run('frontend_tools_register_client', { namespace: 'demo', key })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected register success')
    const registered = result.value as { namespace: string; url: string; replaced: boolean }
    expect(registered.namespace).toBe('demo')
    expect(registered.url).toBe(`ws://127.0.0.1:${server!.port}`)
    expect(registered.replaced).toBe(false)
    // Tool output must not carry a second copy of the credential into session logs.
    expect(JSON.stringify(result.value)).not.toContain(key)
    // The rendered model-facing content carries the value, not the arguments
    // (the render contract is (args, value); echoing args would re-leak the key).
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('"namespace": "demo"')
    expect(text).not.toContain(key)
    await expect(authenticated(key)).resolves.toEqual({ ok: true })
  })

  it('re-registering replaces the credential: the old key stops authenticating', async () => {
    await setup()
    const first = await run('frontend_tools_register_client', { namespace: 'demo', key: KEY_A })
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error('expected first register to succeed')
    const second = await run('frontend_tools_register_client', { namespace: 'demo', key: KEY_B })
    expect(second.isError).toBe(false)
    if (second.isError) throw new Error('expected re-register to succeed')
    expect((second.value as { replaced: boolean }).replaced).toBe(true)
    await expect(authenticated(KEY_A)).resolves.toEqual({ ok: false, code: 'auth_failed' })
    await expect(authenticated(KEY_B)).resolves.toEqual({ ok: true })
  })

  it('reports a placeholder URL when the server has not bound its port yet', async () => {
    await setup({ start: false })
    const result = await run('frontend_tools_register_client', { namespace: 'demo', key: KEY_A })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected register success')
    expect((result.value as { url: string }).url).toBe('ws://127.0.0.1:<bridge-port>')
  })

  it('rejects invalid namespaces, statically configured ones, and weak keys', async () => {
    await setup()
    for (const namespace of ['has space', '', 'a'.repeat(33), 42]) {
      const result = await run('frontend_tools_register_client', { namespace, key: KEY_A })
      expect(result.isError).toBe(true)
    }
    // Static namespaces are owned by cordis.yml; registering must refuse them.
    const staticResult = await run('frontend_tools_register_client', { namespace: 'eatc', key: KEY_A })
    expect(staticResult.isError).toBe(true)
    // Low-entropy or malformed keys cannot be enrolled.
    for (const key of ['short', 'Z'.repeat(64), KEY_A.slice(0, 63), '', undefined]) {
      const result = await run('frontend_tools_register_client', { namespace: 'demo', key })
      expect(result.isError).toBe(true)
    }
  })
})

describe('admin tools · list', () => {
  it('lists namespaces with session facts and never a key', async () => {
    await setup()
    const registered = await run('frontend_tools_register_client', { namespace: 'demo', key: KEY_A })
    if (registered.isError) throw new Error('expected register to succeed')
    const result = await run('frontend_tools_list_clients', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected list success')
    const payload = JSON.stringify(result.value)
    expect(payload).not.toContain(KEY_A)
    expect(payload).not.toContain('key')
    expect(result.value).toEqual({
      clients: [
        { namespace: 'demo', connected: false, toolCount: 0 },
        { namespace: 'eatc', connected: false, toolCount: 0 },
      ],
    })
    // The rendered model-facing content carries the roster value, not the (empty)
    // arguments — a single-parameter render would print `{}` for every call.
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('"clients"')
    expect(text).toContain('"demo"')
  })
})

describe('admin tools · revoke', () => {
  it('revokes the credential and drops its live connection with the tools unregistered', async () => {
    await setup()
    const registered = await run('frontend_tools_register_client', { namespace: 'demo', key: KEY_A })
    if (registered.isError) throw new Error('expected register to succeed')
    // Keep the session open so revoke has a live connection to drop.
    const session = await openSession(KEY_A, (frame) => {
      if (frame.type !== 'welcome') throw new Error(`expected welcome, got ${frame.type}`)
      return { ok: true }
    })
    await tick()

    const result = await run('frontend_tools_revoke_client', { namespace: 'demo' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected revoke success')
    expect(result.value).toEqual({ namespace: 'demo', revoked: true, connectionDropped: true })

    await session.closed
    await expect(authenticated(KEY_A)).resolves.toEqual({ ok: false, code: 'auth_failed' })
  })

  it('reports revoked:false for a namespace without a credential', async () => {
    await setup()
    const result = await run('frontend_tools_revoke_client', { namespace: 'ghost' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected revoke success')
    expect(result.value).toEqual({ namespace: 'ghost', revoked: false, reason: expect.any(String) as string })
  })

  it('refuses revoking a statically configured namespace and rejects an invalid one', async () => {
    await setup()
    const result = await run('frontend_tools_revoke_client', { namespace: 'eatc' })
    expect(result.isError).toBe(true)
    const invalid = await run('frontend_tools_revoke_client', { namespace: 'has space' })
    expect(invalid.isError).toBe(true)
  })
})

describe('admin tools · disposal', () => {
  it('removes every admin tool from the registry', async () => {
    await setup()
    expect(ctx!.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'frontend_tools_register_client',
      'frontend_tools_list_clients',
      'frontend_tools_revoke_client',
    ]))
    disposeAdmin!()
    disposeAdmin = undefined
    const names = ctx!.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('frontend_tools_register_client')
    expect(names).not.toContain('frontend_tools_list_clients')
    expect(names).not.toContain('frontend_tools_revoke_client')
  })
})
