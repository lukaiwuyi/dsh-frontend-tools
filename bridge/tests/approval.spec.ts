// Proves the write-approval gate end to end on the real tool pipeline: a
// WRITE-classified mirrored tool returns `ask` at `tools/pre-execute` and only
// forwards after DSH's approval seam grants `allowed-once`; a rejection denies
// with the user-facing reason; read-only tools and foreign tools never trigger
// approval; and without an approval service (or an agent to route through)
// the ask degrades to a denial — DSH's fail-closed contract, not ours.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges the `approval/*` event
// signatures onto the Cordis Context so `ctx.on('approval/request', …)` types.
import type {} from '@deepseek-ai/dsh-user-approval'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { MirrorRegistry, registerWriteApprovalGate, adminToolCategory } from '../src/index.ts'
import type { RemoteToolSpec } from 'dsh-frontend-tools-client'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/**
 * Compose the minimal real pipeline: system prompt, session store, tool
 * runtime, and the approval seam. `withApproval: false` composes the
 * headless/no-channel deployment instead (the ask must degrade to deny).
 */
async function setup(withApproval = true): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime)
  if (withApproval) await ctx.plugin(UserApproval)
  return ctx
}

/**
 * Create one agent-shaped object whose session sits inside an open turn —
 * everything `ctx.approval.request` needs (audit target plus the turn
 * enclosure precondition).
 */
function openTurnAgent(context: Context): Agent {
  const session = context.sessions.create()
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

/** Run one tool call through the real registry pipeline. */
function run(context: Context, callId: string, name: string, agent?: Agent) {
  return context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name,
    arguments: { message: 'hi' },
    ...(agent !== undefined ? { agent } : {}),
  })
}

const WRITE: RemoteToolSpec = {
  name: 'submit_order',
  description: 'place an order',
  parametersSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
}

const READ: RemoteToolSpec = {
  ...WRITE,
  name: 'peek_state',
  readOnly: true,
}

/** A forwarder recording every call it receives (the "application"). */
function recordingForwarder(log: unknown[]) {
  return async (spec: RemoteToolSpec, args: unknown) => {
    log.push({ name: spec.name, args })
    return { forwarded: spec.name }
  }
}

/** Compose the gate over one registry plus the static admin categories. */
function gate(context: Context, registry: MirrorRegistry): void {
  registerWriteApprovalGate(context, publicName => registry.categoryOf(publicName) ?? adminToolCategory(publicName))
}

/** One answerer recording every request and returning a fixed outcome. */
function answerer(context: Context, log: ApprovalRequest[], outcome: 'allowed-once' | 'rejected'): void {
  context.on('approval/request', (req) => {
    log.push(req)
    return Promise.resolve(outcome)
  })
}

describe('write-approval gate', () => {
  it('forwards a write tool only after allowed-once and audits the pair', async () => {
    const ctx = await setup()
    const agent = openTurnAgent(ctx)
    const forwarded: unknown[] = []
    const registry = new MirrorRegistry(ctx)
    registry.register([WRITE], 'eatc', recordingForwarder(forwarded))
    gate(ctx, registry)
    const asked: ApprovalRequest[] = []
    answerer(ctx, asked, 'allowed-once')

    const result = await run(ctx, 'approval-1', 'eatc__submit_order', agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected approval-gated success')
    expect(result.value).toEqual({ forwarded: 'submit_order' })
    expect(forwarded).toEqual([{ name: 'submit_order', args: { message: 'hi' } }])
    // The approval request reached the answerer with the public tool name and
    // the gate's human-facing reason quoting the application identity.
    expect(asked).toHaveLength(1)
    expect(asked[0].toolName).toBe('eatc__submit_order')
    expect(asked[0].reason).toContain('eatc.submit_order')
    // The audit pair landed on the session log (turn-enclosed).
    const types = agent.session.events.map(event => event.type)
    expect(types).toContain('approval/asked')
    expect(types).toContain('approval/decided')
  })

  it('denies a write tool when the user rejects it', async () => {
    const ctx = await setup()
    const agent = openTurnAgent(ctx)
    const forwarded: unknown[] = []
    const registry = new MirrorRegistry(ctx)
    registry.register([WRITE], 'eatc', recordingForwarder(forwarded))
    gate(ctx, registry)
    answerer(ctx, [], 'rejected')

    const result = await run(ctx, 'approval-2', 'eatc__submit_order', agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected rejection denial')
    expect(result.error.message).toContain('the user rejected tool "eatc__submit_order"')
    expect(forwarded).toEqual([])
  })

  it('runs a readOnly tool without asking any answerer', async () => {
    const ctx = await setup()
    const agent = openTurnAgent(ctx)
    const forwarded: unknown[] = []
    const registry = new MirrorRegistry(ctx)
    registry.register([READ], 'eatc', recordingForwarder(forwarded))
    gate(ctx, registry)
    const asked: ApprovalRequest[] = []
    answerer(ctx, asked, 'allowed-once')

    const result = await run(ctx, 'approval-3', 'eatc__peek_state', agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected read-only success')
    expect(result.value).toEqual({ forwarded: 'peek_state' })
    expect(asked).toEqual([])
    expect(agent.session.events.map(event => event.type)).not.toContain('approval/asked')
  })

  it('leaves tools owned by other plugins untouched', async () => {
    const ctx = await setup()
    const agent = openTurnAgent(ctx)
    ctx.tools.register({
      name: 'someone_elses_tool',
      description: 'not ours',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [] },
      async execute() { return { ok: true } },
    })
    const registry = new MirrorRegistry(ctx)
    gate(ctx, registry)
    const asked: ApprovalRequest[] = []
    answerer(ctx, asked, 'allowed-once')

    const result = await run(ctx, 'approval-4', 'someone_elses_tool', agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected foreign-tool success')
    expect(result.value).toEqual({ ok: true })
    expect(asked).toEqual([])
  })

  it('degrades to denial without a mounted approval service (fail closed)', async () => {
    const ctx = await setup(false)
    const forwarded: unknown[] = []
    const registry = new MirrorRegistry(ctx)
    registry.register([WRITE], 'eatc', recordingForwarder(forwarded))
    gate(ctx, registry)

    const result = await run(ctx, 'approval-5', 'eatc__submit_order')
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected headless denial')
    expect(result.error.message).toContain('eatc.submit_order')
    expect(forwarded).toEqual([])
  })

  it('degrades to denial without an agent to route the approval through', async () => {
    const ctx = await setup()
    const forwarded: unknown[] = []
    const registry = new MirrorRegistry(ctx)
    registry.register([WRITE], 'eatc', recordingForwarder(forwarded))
    gate(ctx, registry)

    const result = await run(ctx, 'approval-6', 'eatc__submit_order')
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected agent-less denial')
    expect(result.error.message).toContain('no agent to route it through')
    expect(forwarded).toEqual([])
  })
})

describe('adminToolCategory', () => {
  it('classifies list as read and register/revoke as write', () => {
    expect(adminToolCategory('frontend_tools_list_clients')).toMatchObject({ readOnly: true })
    expect(adminToolCategory('frontend_tools_register_client')).toMatchObject({ readOnly: false })
    expect(adminToolCategory('frontend_tools_revoke_client')).toMatchObject({ readOnly: false })
    expect(adminToolCategory('eatc__echo')).toBeUndefined()
  })
})
