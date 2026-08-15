// Proves the application-side registry: names outside the wire alphabet are
// refused up front, specs are advertised without their execute bodies, and a
// dispatched call settles with the tool's value, keeps a coded
// FrontendToolsError, or wraps an arbitrary throw as `internal`.
import { describe, expect, it } from 'vitest'
import { FrontendToolsError, ToolExecutor } from '../src/index.ts'
import type { FrontendTool } from '../src/index.ts'

const ECHO: FrontendTool = {
  name: 'echo',
  description: 'echo it back',
  parametersSchema: { type: 'object' },
  async execute(args: unknown) {
    return { echoed: (args as { message?: unknown }).message }
  },
}

describe('ToolExecutor', () => {
  it('registers a well-formed tool and replaces it under the same name', () => {
    const executor = new ToolExecutor()
    executor.register(ECHO)
    executor.register({ ...ECHO, description: 'updated' })
    expect(executor.specs()).toEqual([{ name: 'echo', description: 'updated', parametersSchema: { type: 'object' } }])
  })

  it('advertises a declared output schema and omits it when undeclared', () => {
    const executor = new ToolExecutor()
    const outputSchema = { type: 'object', properties: { echoed: { type: 'string' } } }
    executor.register({ ...ECHO, name: 'shaped', outputSchema })
    executor.register(ECHO)
    expect(executor.specs()).toEqual([
      { name: 'shaped', description: 'echo it back', parametersSchema: { type: 'object' }, outputSchema },
      { name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } },
    ])
  })

  it('refuses tools outside the wire contracts', () => {
    const executor = new ToolExecutor()
    expect(() => { executor.register({ ...ECHO, name: 'has space' }) }).toThrow(FrontendToolsError)
    expect(() => { executor.register({ ...ECHO, name: '' }) }).toThrow(FrontendToolsError)
    expect(() => { executor.register({ ...ECHO, name: 42 } as unknown as FrontendTool) }).toThrow(FrontendToolsError)
    expect(() => { executor.register({ ...ECHO, description: 42 } as unknown as FrontendTool) }).toThrow(FrontendToolsError)
    expect(executor.specs()).toHaveLength(0)
  })

  it('unregisters silently whether or not the name exists', () => {
    const executor = new ToolExecutor()
    executor.register(ECHO)
    executor.unregister('echo')
    executor.unregister('echo')
    expect(executor.specs()).toHaveLength(0)
  })

  it('dispatches a call to the registered execute body', async () => {
    const executor = new ToolExecutor()
    executor.register(ECHO)
    await expect(executor.dispatch('echo', { message: 'hi' })).resolves.toEqual({ ok: true, result: { echoed: 'hi' } })
  })

  it('fails with unknown_tool for an unregistered name', async () => {
    const executor = new ToolExecutor()
    const message: unknown = expect.stringContaining('nope')
    await expect(executor.dispatch('nope', {})).resolves.toEqual({
      ok: false,
      error: { code: 'unknown_tool', message },
    })
  })

  it('keeps the code of a thrown FrontendToolsError', async () => {
    const executor = new ToolExecutor()
    executor.register({
      ...ECHO,
      name: 'guarded',
      async execute() {
        throw new FrontendToolsError('denied', 'not logged in')
      },
    })
    await expect(executor.dispatch('guarded', {})).resolves.toEqual({
      ok: false,
      error: { code: 'denied', message: 'not logged in' },
    })
  })

  it('wraps an arbitrary throw as internal', async () => {
    const executor = new ToolExecutor()
    executor.register({
      ...ECHO,
      name: 'broken',
      async execute() {
        throw new Error('boom')
      },
    })
    await expect(executor.dispatch('broken', {})).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'boom' },
    })
  })

  it('stringifies a rejected non-Error value as internal', async () => {
    const executor = new ToolExecutor()
    executor.register({
      ...ECHO,
      name: 'rejects-literal',
      async execute() {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the String(error) arm needs a non-Error rejection.
        await Promise.reject('plain rejection')
      },
    })
    const outcome = await executor.dispatch('rejects-literal', {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failed dispatch')
    expect(outcome.error.code).toBe('internal')
    expect(outcome.error.message).toBe('plain rejection')
  })
})
