// Proves the mirror naming contract (namespace join, lossy normalization,
// identity hash on collision) and that MirrorRegistry registrations are
// all-or-nothing per batch: a conflict inside the batch, against the same
// connection, or against a foreign registration leaves ctx.tools untouched.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { buildMirroredTool, MirrorRegistry, publicToolName } from '../src/index.ts'
import type { CallForwarder } from '../src/index.ts'
import { FrontendToolsError } from 'dsh-frontend-tools-client'
import type { RemoteToolSpec } from 'dsh-frontend-tools-client'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function setup(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const ECHO: RemoteToolSpec = {
  name: 'echo',
  description: 'echo it back',
  parametersSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
}

/** A forwarder that records what the mirror handed it and returns a sentinel. */
function recordingForwarder(log: unknown[]): CallForwarder {
  return async (spec, args) => {
    log.push({ spec, args })
    return { forwarded: spec.name }
  }
}

describe('publicToolName', () => {
  it('joins namespace and raw name verbatim in the clean case', () => {
    expect(publicToolName('eatc', 'schedule_query_rows')).toBe('eatc__schedule_query_rows')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = publicToolName('eatc', 'has space')
    expect(name).toMatch(/^eatc__has_space_[0-9a-f]{12}$/)
    // Distinct raw names never collapse onto the same public name.
    expect(publicToolName('eatc', 'has!space')).not.toBe(name)
  })

  it('truncates overlong names to the 64-char model budget with an identity hash', () => {
    const name = publicToolName('eatc', 'x'.repeat(80))
    expect(name).toMatch(/^[A-Za-z0-9_-]{51}_[0-9a-f]{12}$/)
    expect(name).toHaveLength(64)
  })
})

describe('buildMirroredTool', () => {
  it('rejects schemas the tool registry does not support', () => {
    const unsupported = { type: 'object', patternProperties: { '^x': { type: 'string' } } }
    expect(() => buildMirroredTool({ ...ECHO, parametersSchema: unsupported }, 'eatc', recordingForwarder([])))
      .toThrow(FrontendToolsError)
    expect(() => buildMirroredTool({ ...ECHO, outputSchema: unsupported }, 'eatc', recordingForwarder([])))
      .toThrow(FrontendToolsError)
  })

  it('defaults the output schema to any JSON and forwards execute unchanged', async () => {
    const log: unknown[] = []
    const definition = buildMirroredTool(ECHO, 'eatc', recordingForwarder(log))
    expect(definition.name).toBe('eatc__echo')
    expect(definition.description).toBe(ECHO.description)
    expect(definition.parameters).toEqual(ECHO.parametersSchema)
    expect(definition.output.schema).toEqual({})
    const ctx = await setup()
    ctx.tools.register(definition)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('mirror-call-1'),
      name: 'eatc__echo',
      arguments: { message: 'hi' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mirror success')
    expect(result.value).toEqual({ forwarded: 'echo' })
    expect(log).toEqual([{ spec: ECHO, args: { message: 'hi' } }])
  })

  it('keeps an explicit output schema and renders results as text content', async () => {
    const outputSchema = { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false }
    const definition = buildMirroredTool({ ...ECHO, outputSchema }, 'eatc', recordingForwarder([]))
    expect(definition.output.schema).toEqual(outputSchema)
    expect(definition.output.render({ message: 'hi' }, { echoed: 'hi' })).toEqual([
      { type: 'text', text: JSON.stringify({ echoed: 'hi' }, null, 2) },
    ])
  })
})

describe('MirrorRegistry', () => {
  it('mirrors a batch onto ctx.tools under public names and disposes them all', async () => {
    const ctx = await setup()
    const registry = new MirrorRegistry(ctx)
    const names = registry.register([ECHO], 'eatc', recordingForwarder([]))
    expect(names).toEqual(['eatc__echo'])
    expect(registry.size).toBe(1)
    expect(ctx.tools.schemas().map(s => s.name)).toContain('eatc__echo')

    registry.disposeAll()
    expect(registry.size).toBe(0)
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')
  })

  it('rejects a name repeated within one batch without registering anything', async () => {
    const ctx = await setup()
    const registry = new MirrorRegistry(ctx)
    expect(() => registry.register([ECHO, { ...ECHO }], 'eatc', recordingForwarder([]))).toThrow(FrontendToolsError)
    expect(registry.size).toBe(0)
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('rejects a re-registration of a name this connection already owns', async () => {
    const ctx = await setup()
    const registry = new MirrorRegistry(ctx)
    registry.register([ECHO], 'eatc', recordingForwarder([]))
    expect(() => registry.register([ECHO], 'eatc', recordingForwarder([]))).toThrow(FrontendToolsError)
    expect(registry.size).toBe(1)
  })

  it('rolls the whole batch back when a foreign registration squats on a public name', async () => {
    const ctx = await setup()
    ctx.tools.register({
      name: 'eatc__foreign',
      description: 'already here',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      async execute() { return {} },
    })
    const registry = new MirrorRegistry(ctx)
    expect(() => registry.register([ECHO, { ...ECHO, name: 'foreign' }], 'eatc', recordingForwarder([]))).toThrow(FrontendToolsError)
    expect(registry.size).toBe(0)
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')
    // The rolled-back name stays registrable by the same connection afterwards.
    expect(registry.register([ECHO], 'eatc', recordingForwarder([]))).toEqual(['eatc__echo'])
  })

  it('unregisters owned public names and ignores names it does not own', async () => {
    const ctx = await setup()
    const registry = new MirrorRegistry(ctx)
    registry.register([ECHO], 'eatc', recordingForwarder([]))

    const removed = registry.unregister(['eatc__echo', 'eatc__never-registered'])
    expect(removed).toEqual(['eatc__echo'])
    expect(registry.size).toBe(0)
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('eatc__echo')

    // A replayed unregister stays harmless (idempotent contract).
    expect(registry.unregister(['eatc__echo'])).toEqual([])
  })

  it('frees an unregistered public name for a later registration', async () => {
    const ctx = await setup()
    const registry = new MirrorRegistry(ctx)
    registry.register([ECHO], 'eatc', recordingForwarder([]))
    registry.unregister(['eatc__echo'])

    expect(registry.register([ECHO], 'eatc', recordingForwarder([]))).toEqual(['eatc__echo'])
  })
})
