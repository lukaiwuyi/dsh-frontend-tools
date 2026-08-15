// Proves `port` and `staticClients` are real configurability and not
// constants: the bridge boots through the real Loader from a cordis.yml file,
// a duplicate static namespace fails the load (misconfiguration fails loud),
// and the configured port/key carry a genuine client SDK connection end to
// end — the client registers an `echo` tool, the model-facing registry sees
// it under the public name, and a forwarded call returns the application's
// result. The client here uses the platform `WebSocket` (no constructor
// injection), so the default-transport path of the SDK is exercised too.
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Bridge from '../src/index.ts'
import { createFrontendToolsClient, generateClientKey } from 'dsh-frontend-tools-client'
import type { FrontendTool } from 'dsh-frontend-tools-client'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Reserve one ephemeral loopback port and release it for the bridge to bind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('ephemeral port probe returned no port'))
        return
      }
      probe.close(() => { resolve(address.port) })
    })
  })
}

/**
 * Boot a cordis.yml carrying the given frontend-tools-bridge config block.
 * @param configLines - callback returning YAML lines nested under the plugin's
 *   `config:` key; receives the per-test state directory so roster persistence
 *   never touches the real `~/.dsh`.
 * @returns the booted context.
 */
async function boot(configLines: (stateDir: string) => readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-tools-loader-'))
  const stateDir = join(root, 'state')
  const lines = configLines(stateDir)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'dsh-frontend-tools-bridge'",
    ...lines.length > 0 ? ['  config:', ...lines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-frontend-tools-bridge', Bridge],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

const ECHO: FrontendTool = {
  name: 'echo',
  description: 'Echo the provided message back. Use it to verify the frontend-tools bridge end to end.',
  parametersSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'The text to echo back.' } },
    required: ['message'],
    additionalProperties: false,
  },
  async execute(args: unknown) {
    return { echoed: (args as { message?: unknown }).message }
  },
}

const tick = (ms = 50): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('frontend-tools-bridge · loader composition', () => {
  it('fails the load when two static clients share one namespace', async () => {
    const port = await freePort()
    await expect(boot(stateDir => [
      `    port: ${port}`,
      `    stateDir: '${stateDir}'`,
      '    staticClients:',
      '      - namespace: demo',
      "        key: 'composition-key'",
      '      - namespace: demo',
      "        key: 'other-key'",
    ])).rejects.toThrow(/collides/)
  })

  it('serves a real client SDK connection from the configured port and key', async () => {
    const port = await freePort()
    const ctx = await boot(stateDir => [
      `    port: ${port}`,
      `    stateDir: '${stateDir}'`,
      '    staticClients:',
      '      - namespace: demo',
      "        key: 'composition-key'",
    ])

    const client = createFrontendToolsClient({
      url: `ws://127.0.0.1:${port}`,
      key: 'composition-key',
    })
    const states: string[] = []
    client.onStateChange(state => states.push(state))

    await client.connect()
    expect(client.state).toBe('connected')
    expect(client.namespace).toBe('demo')
    await expect(client.registerTools([ECHO])).resolves.toEqual(['demo__echo'])
    expect(ctx.tools.schemas().map(s => s.name)).toContain('demo__echo')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-call-1'),
      name: 'demo__echo',
      arguments: { message: 'hi' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected composition success')
    expect(result.value).toEqual({ echoed: 'hi' })

    // The admin tools drive the real apply() closures: the bound port in
    // register output, live session facts from the server, and a revoke of
    // the just-registered credential (the static `demo` namespace refuses
    // revoke).
    const registered = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-register-1'),
      name: 'frontend_tools_register_client',
      arguments: { namespace: 'extra', key: generateClientKey() },
    })
    expect(registered.isError).toBe(false)
    if (registered.isError) throw new Error('expected register success')
    expect((registered.value as { url: string }).url).toBe(`ws://127.0.0.1:${port}`)

    const listed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-list-1'),
      name: 'frontend_tools_list_clients',
      arguments: {},
    })
    expect(listed.isError).toBe(false)
    if (listed.isError) throw new Error('expected list success')
    expect(listed.value).toEqual({ clients: [
      { namespace: 'demo', connected: true, toolCount: 1 },
      { namespace: 'extra', connected: false, toolCount: 0 },
    ] })

    const revoked = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-revoke-1'),
      name: 'frontend_tools_revoke_client',
      arguments: { namespace: 'extra' },
    })
    expect(revoked.isError).toBe(false)
    if (revoked.isError) throw new Error('expected revoke success')
    expect(revoked.value).toEqual({ namespace: 'extra', revoked: true, connectionDropped: false })

    client.disconnect()
    await tick()
    expect(client.state).toBe('disconnected')
    expect(states).toEqual(['connecting', 'connected', 'disconnected'])
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('demo__echo')
  })

  it('places the registered roster under $DSH_HOME when stateDir is omitted', async () => {
    const port = await freePort()
    const home = await mkdtemp(join(tmpdir(), 'dsh-frontend-tools-home-'))
    process.env.DSH_HOME = home
    try {
      const ctx = await boot(() => [
        `    port: ${port}`,
      ])
      const registered = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('composition-register-home-1'),
        name: 'frontend_tools_register_client',
        arguments: { namespace: 'extra', key: generateClientKey() },
      })
      expect(registered.isError).toBe(false)
      if (registered.isError) throw new Error('expected register success')
      // The credential landed under $DSH_HOME, never the real ~/.dsh.
      const persisted = JSON.parse(await readFile(join(home, 'frontend-tools-clients.json'), 'utf8')) as Array<{ namespace: string }>
      expect(persisted.map(entry => entry.namespace)).toEqual(['extra'])
    } finally {
      delete process.env.DSH_HOME
      await rm(home, { recursive: true, force: true })
    }
  })

  it('stops listening when the booted context is disposed', async () => {
    const port = await freePort()
    const ctx = await boot(stateDir => [
      `    port: ${port}`,
      `    stateDir: '${stateDir}'`,
      '    staticClients:',
      '      - namespace: demo',
      "        key: 'composition-key'",
    ])
    await ctx.fiber.dispose()
    context = undefined

    const client = createFrontendToolsClient({
      url: `ws://127.0.0.1:${port}`,
      key: 'composition-key',
    })
    await expect(client.connect()).rejects.toThrow()
  })
})
