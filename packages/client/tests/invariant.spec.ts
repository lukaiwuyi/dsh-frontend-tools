// Proves the package invariant companion mounts against the real invariant
// service and reserves its package name: the browser-facing SDK contributes
// no runtime checks (it runs outside the harness process and writes no
// session events), so the observable contract is the name reservation alone.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as clientInvariant from '../src/invariant.ts'

describe('frontend-tools-client package invariant', () => {
  it('mounts the no-op companion and reserves the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(clientInvariant)
    await expect(ctx.plugin(clientInvariant)).rejects.toThrow('already registered')
    await ctx.fiber.dispose()
  })
})
