/**
 * Tool executor: the application-side registry that owns tool definitions and
 * answers forwarded `call` frames. Applications register tools here through
 * the client; each incoming call is dispatched by raw name, and a throwing
 * `execute` (or a thrown {@link FrontendToolsError}) becomes a structured
 * `callResult` failure the model can read.
 *
 * @module
 */

import type { BridgeErrorCode, RemoteToolSpec } from './protocol.ts'
import { FrontendToolsError, TOOL_NAME_PATTERN } from './protocol.ts'

/** One application tool. The `execute` body runs in the application with its full permissions. */
export interface FrontendTool extends RemoteToolSpec {
  /**
   * Run one forwarded call. Throw {@link FrontendToolsError} with
   * `code: 'denied'` for permission refusals the model should read (for
   * example: not logged in); other thrown errors surface as `internal`.
   * @param args - model-generated arguments.
   * @returns the tool's JSON value.
   */
  execute(args: unknown): Promise<unknown>
}

/** One settled dispatch, ready to serialize as a `callResult` payload. */
export type DispatchOutcome =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: { readonly code: BridgeErrorCode; readonly message: string } }

/**
 * Project one application tool onto its wire spec for a `register` batch,
 * dropping the `execute` body.
 * @param tool - the application tool with its implementation.
 * @returns the wire spec the bridge mirrors.
 */
export function toRemoteSpec(tool: FrontendTool): RemoteToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    // readOnly 只在显式声明时携带：未声明的工具在桥接侧按写操作处理（安全默认）。
    ...(tool.readOnly !== undefined ? { readOnly: tool.readOnly } : {}),
  }
}

/**
 * The application's tool registry and call dispatcher.
 */
export class ToolExecutor {
  private readonly tools = new Map<string, FrontendTool>()

  /**
   * Register or replace one tool.
   * @param tool - the tool definition and implementation.
   * @throws FrontendToolsError (`invalid_tool`) when the name does not match the wire alphabet.
   */
  register(tool: FrontendTool): void {
    if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw new FrontendToolsError('invalid_tool', `tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME_PATTERN.source}`)
    }
    if (typeof tool.description !== 'string') {
      throw new FrontendToolsError('invalid_tool', `tool "${tool.name}" description must be a string`)
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * Remove one tool; silent when absent (the bridge-side mirror follows the next `register`).
   * @param name - raw tool name previously passed to {@link register}.
   */
  unregister(name: string): void {
    this.tools.delete(name)
  }

  /**
   * The wire specs of every registered tool, in insertion order.
   * @returns specs ready to send as one `register` batch.
   */
  specs(): RemoteToolSpec[] {
    return [...this.tools.values()].map(toRemoteSpec)
  }

  /**
   * Dispatch one forwarded call.
   * @param name - the raw tool name from the `call` frame.
   * @param args - model-generated arguments.
   * @returns the settled outcome; unknown tools fail with `unknown_tool`, a
   * thrown {@link FrontendToolsError} keeps its code and message, and any
   * other thrown error becomes `internal` with the error text.
   */
  async dispatch(name: string, args: unknown): Promise<DispatchOutcome> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      return { ok: false, error: { code: 'unknown_tool', message: `no frontend tool named "${name}" is registered` } }
    }
    try {
      const result = await tool.execute(args)
      return { ok: true, result }
    } catch (error) {
      if (error instanceof FrontendToolsError) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}
