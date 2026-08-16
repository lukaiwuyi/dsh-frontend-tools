/**
 * Frontend tools bridge: a loopback-only WebSocket server that lets any number
 * of roster clients mirror their own tools onto `ctx.tools`. The real tool
 * implementations live in the applications (browser or Node) — this plugin
 * carries no business knowledge; it forwards model calls to the owning
 * application and returns its results. The application-side counterpart and
 * protocol owner is `dsh-frontend-tools-client`.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal closes the server, unregisters every mirrored tool,
 * and rejects in-flight forwarded calls.
 *
 * @module dsh-frontend-tools-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import { BridgeServer } from './server.ts'
import { ClientRoster } from './key-store.ts'
import type { StaticClient } from './key-store.ts'
import { registerAdminTools, adminToolCategory } from './admin.ts'
import { registerWriteApprovalGate } from './approval.ts'

export { publicToolName, buildMirroredTool, MirrorRegistry } from './registry.ts'
export type { CallForwarder, ToolCategory } from './registry.ts'
export { CallDispatcher } from './dispatch.ts'
export type { FrameSender } from './dispatch.ts'
export { BridgeServer } from './server.ts'
export type { ServerOptions } from './server.ts'
export { ClientRoster } from './key-store.ts'
export type { StaticClient } from './key-store.ts'
export { registerAdminTools, adminToolCategory } from './admin.ts'
export type { AdminDeps } from './admin.ts'
export { registerWriteApprovalGate } from './approval.ts'
export type { ToolCategoryLookup } from './approval.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'frontend-tools-bridge'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default WebSocket port on 127.0.0.1 (protocol constant; deployment-varying choice lives in Config). */
const DEFAULT_PORT = 31870

/** Default per-call timeout in milliseconds (application tool runtimes vary widely, so this is configurable). */
const DEFAULT_CALL_TIMEOUT_MS = 30_000

/** Default bridge-wide tool budget (abuse guard, not a semantic limit). */
const DEFAULT_MAX_TOOLS = 200

/** Plugin configuration: where to listen, how calls are bounded, and how clients authenticate. */
export interface Config {
  /** Loopback port to listen on. */
  port: number
  /**
   * Deadline for one forwarded call: a `callResult` arriving later rejects
   * the model-facing promise with a timeout error and is dropped.
   */
  callTimeoutMs: number
  /**
   * Maximum number of tools mirrored across every connected client. One
   * global ceiling keeps concurrent applications from crowding the model's
   * tool list.
   */
  maxTools: number
  /**
   * Statically configured clients, validated and merged with the persisted
   * roster at load. Omitting the key resolves to an empty array (Schemastery
   * guarantees the parsed value is never nullish). The everyday path is the
   * `frontend_tools_register_client` admin tool (application-generated DSH
   * KEYs); static entries — free-form keys owned by the configuration —
   * serve tests and declarative setups.
   */
  staticClients: StaticClient[]
  /**
   * Directory holding the registered-client roster file (mode 600). Defaults
   * to the harness state home (`~/.dsh`, overridable through `DSH_HOME`).
   */
  stateDir?: string
}

/** Schemastery configuration for the frontend-tools bridge. */
export const Config: z<Config> = z.object({
  port: z.natural().max(65535).default(DEFAULT_PORT),
  callTimeoutMs: z.natural().default(DEFAULT_CALL_TIMEOUT_MS),
  maxTools: z.natural().default(DEFAULT_MAX_TOOLS),
  // Schemastery object fields are optional unless marked required; these two
  // stay optional so an empty config section is valid.
  staticClients: z.array(z.object({
    namespace: z.string(),
    key: z.string(),
  })),
  stateDir: z.string(),
})

/**
 * Start the bridge server, load the client roster, and register the admin tools.
 *
 * Explicitly `async`: binding failures (for example a taken port) reject this
 * promise, so plugin load fails loud instead of leaving a dead server behind.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved listen and budget options plus roster overrides.
 * @returns bind completion.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Roster load is synchronous and throws on a malformed file or a duplicate
  // identity, so a broken credential state fails plugin load loud.
  const roster = ClientRoster.load(config.stateDir ?? dshHomePath(), config.staticClients)
  const server = new BridgeServer(ctx, { port: config.port, callTimeoutMs: config.callTimeoutMs, maxTools: config.maxTools }, roster)
  const disposeAdmin = registerAdminTools(ctx, {
    roster,
    port: () => server.port,
    sessionInfo: namespace => server.sessionInfo(namespace),
    dropSession: namespace => server.dropSession(namespace),
  })
  // 写操作审核门：动态查活跃会话的镜像工具，静态查本插件 admin 工具；
  // 只读与非本插件工具放行，写工具交由 DSH 人工审核（allowed-once 才转发）。
  const disposeGate = registerWriteApprovalGate(ctx, publicName => server.categoryOf(publicName) ?? adminToolCategory(publicName))
  ctx.effect(() => () => {
    disposeGate()
    disposeAdmin()
    server.dispose()
  }, 'frontend-tools-bridge.server')
  await server.start()
}
