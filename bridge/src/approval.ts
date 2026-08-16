/**
 * Write-approval gate: the bridge's `tools/pre-execute` listener that routes
 * WRITE-classified tools into DSH's human-approval channel. Returning
 * `{ kind: 'ask' }` hands the decision to `ctx.approval` (mounted by DSH): the
 * call is forwarded to the application only after the user grants
 * `allowed-once`; a rejection, a cancellation, or a missing approval channel
 * (for example a headless run) denies the call — the fail-closed contract of
 * the DSH tool pipeline. Read-only tools and tools owned by other plugins
 * pass through untouched (`next()` keeps the default allow decision).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges the `tools/*` event signatures
// (including `tools/pre-execute`) onto the Cordis Context.
import type {} from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ToolCategory } from './registry.ts'

/**
 * Resolve the read/write category of one model-facing tool name. Returns
 * `undefined` for tools this bridge does not own (mirrored tools of live
 * sessions plus the admin tools).
 */
export type ToolCategoryLookup = (publicName: string) => ToolCategory | undefined

/**
 * Register the write-approval gate on the `tools/pre-execute` waterfall.
 *
 * The gate is synchronous (a Map lookup), so it never needs to observe
 * `exec.signal`; it also never rewrites arguments — the DSH pipeline forbids
 * input rewriting at pre-execute, and the approval card already shows the
 * streamed call through `callId`.
 * @param ctx - plugin context whose `tools/pre-execute` dispatch to join.
 * @param lookup - category lookup covering mirrored plus admin tools.
 * @returns the disposer removing this listener (plugin disposal unbinds it too).
 */
export function registerWriteApprovalGate(ctx: Context, lookup: ToolCategoryLookup): () => void {
  return ctx.on('tools/pre-execute', (exec, next) => {
    const category = lookup(exec.name)
    // 非本插件工具（undefined）或只读工具：交给管线默认决策，不干预其他插件的策略。
    if (category === undefined || category.readOnly) return next()
    // 写工具：转入 DSH 人工审核渠道。仅在审批结果为 allowed-once 时继续转发给应用，
    // 其余结果（拒绝/取消/无审批通道）由 DSH 管线自动拒绝（fail-closed）。
    const decision: PreToolDecision = {
      kind: 'ask',
      reason: `前端工具写操作 "${category.label}"：该工具被应用声明为写操作，需人工批准后才会转发给应用执行。`,
    }
    return Promise.resolve(decision)
  })
}
