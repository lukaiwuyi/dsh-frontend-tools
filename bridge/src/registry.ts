/**
 * Tool mirror: turns client-advertised {@link RemoteToolSpec}s into
 * `ctx.tools` registrations under deterministic public names and owns their
 * disposers. Naming follows the mcp-client contract: the public name is
 * `<namespace>__<rawName>`, normalized to the model function-name constraints
 * (`[A-Za-z0-9_-]`, ≤ 64 chars); lossy normalization appends a 12-hex-char
 * SHA-256 identity hash so distinct client names never collapse.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { RemoteToolSpec } from 'dsh-frontend-tools-client'
import { FrontendToolsError } from 'dsh-frontend-tools-client'

/** Model function-name contract: at most 64 characters (wire constant, not configuration). */
const MAX_PUBLIC_NAME_LENGTH = 64

/** Characters allowed in a model-facing function name. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Callback that forwards one execution to the owning connection. */
export type CallForwarder = (spec: RemoteToolSpec, args: unknown, signal: AbortSignal) => Promise<unknown>

/**
 * Derive the model-facing public name for one client tool.
 *
 * Deterministic pure function of `(namespace, rawName)`: the clean case is
 * `<namespace>__<rawName>` verbatim. When character replacement or truncation
 * to the model function-name contract changes the name, a SHA-256 identity
 * hash is appended so distinct client identities never collapse.
 * @param namespace - connection namespace from the `hello` frame.
 * @param rawName - the client's own tool name.
 * @returns the globally unique, model-facing `ctx.tools` name.
 */
export function publicToolName(namespace: string, rawName: string): string {
  const joined = `${namespace}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${namespace}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Render one forwarded value as model-facing text content. */
function renderValue(_args: unknown, value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the `ctx.tools` definition mirroring one client tool.
 *
 * Both schemas are validated against the supported JSON-Schema subset here —
 * the WebSocket boundary is untrusted, so an unsupported schema rejects the
 * whole registration batch (`invalid_tool`) instead of reaching the registry.
 * @param spec - the client-advertised tool.
 * @param namespace - connection namespace from the `hello` frame.
 * @param forward - executor that carries the call to the owning connection.
 * @returns the registry-ready definition under its public name.
 * @throws FrontendToolsError (`invalid_tool`) when either schema uses vocabulary the tool registry does not support.
 */
export function buildMirroredTool(spec: RemoteToolSpec, namespace: string, forward: CallForwarder): ToolDefinition {
  try {
    assertSupportedJsonSchema(spec.parametersSchema)
    if (spec.outputSchema !== undefined) assertSupportedJsonSchema(spec.outputSchema)
  } catch (error) {
    /* v8 ignore next -- assertSupportedJsonSchema only throws Error (declared contract); the String arm is a defensive backstop. */
    const reason = error instanceof Error ? error.message : String(error)
    throw new FrontendToolsError('invalid_tool', `tool "${spec.name}" declares a JSON Schema the tool registry does not support: ${reason}`)
  }
  const outputSchema = spec.outputSchema ?? {}
  return {
    name: publicToolName(namespace, spec.name),
    description: spec.description,
    parameters: spec.parametersSchema,
    output: { schema: outputSchema, render: renderValue },
    async execute(args: unknown, exec: ToolExecution): Promise<unknown> {
      return forward(spec, args, exec.signal)
    },
  }
}

/**
 * Per-connection set of mirrored registrations. Registering and disposing are
 * all-or-nothing per `register` batch: a conflict rolls the whole batch back,
 * so the model never sees a partial set from one message.
 */
export class MirrorRegistry {
  private readonly disposers = new Map<string, () => void>()

  constructor(private readonly ctx: Context) {}

  /**
   * Mirror one `register` batch onto `ctx.tools`.
   * @param specs - tools advertised by one `register` message.
   * @param namespace - connection namespace from the `hello` frame.
   * @param forward - executor that carries each call to the owning connection.
   * @returns the public names now owned by this connection.
   * @throws FrontendToolsError (`invalid_tool`) when a name repeats within
   *   the batch, collides with a tool this connection already registered, or
   *   a schema is unsupported; the batch then has no effect.
   */
  register(specs: readonly RemoteToolSpec[], namespace: string, forward: CallForwarder): string[] {
    const batch = new Map<string, ToolDefinition>()
    for (const spec of specs) {
      const publicName = publicToolName(namespace, spec.name)
      if (batch.has(publicName) || this.disposers.has(publicName)) {
        throw new FrontendToolsError('invalid_tool', `tool "${spec.name}" resolves to public name "${publicName}" that is already registered by this connection`)
      }
      batch.set(publicName, buildMirroredTool(spec, namespace, forward))
    }
    const added: Array<readonly [string, () => void]> = []
    try {
      for (const [publicName, definition] of batch) {
        added.push([publicName, this.ctx.tools.register(definition)])
      }
    } catch (error) {
      // A conflict here means a foreign registration squats on this
      // connection's `<namespace>__` prefix. Roll the batch back (without
      // adopting any disposer) so the model sees all of it or none of it.
      for (const [, dispose] of added) dispose()
      /* v8 ignore next -- ctx.tools.register only throws Error (declared contract); the String arm is a defensive backstop. */
      const reason = error instanceof Error ? error.message : String(error)
      throw new FrontendToolsError('invalid_tool', `registering mirrored tools failed: ${reason}`)
    }
    for (const [publicName, dispose] of added) this.disposers.set(publicName, dispose)
    return [...batch.keys()]
  }

  /**
   * Remove mirrored registrations by public name. Idempotent: names this
   * connection does not own are ignored, so a replayed `unregister` (or one
   * racing a dropped socket) stays harmless.
   * @param publicNames - public names previously returned by {@link register}.
   * @returns the public names actually removed, in request order.
   */
  unregister(publicNames: readonly string[]): string[] {
    const removed: string[] = []
    for (const publicName of publicNames) {
      const dispose = this.disposers.get(publicName)
      if (dispose === undefined) continue
      dispose()
      this.disposers.delete(publicName)
      removed.push(publicName)
    }
    return removed
  }

  /** Dispose every registration owned by this connection (call on socket close and plugin disposal). */
  disposeAll(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }

  /** Number of tools currently mirrored by this connection. */
  get size(): number {
    return this.disposers.size
  }
}
