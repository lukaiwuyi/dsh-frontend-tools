/**
 * Admin tools: the model-facing surface for managing bridge clients. The
 * application generates its own DSH KEY (client SDK `generateClientKey`) and
 * the user hands it to the model, which registers it here — credentials are
 * application-owned, the bridge only keeps the registry. Registration output
 * never echoes the key (the user's message already carries it; a second
 * copy would only widen session-log exposure); listing never returns keys
 * either; revoking removes the credential and drops its live connection in
 * one step. These registrations go through the ordinary `ctx.tools`
 * permission stack like any other tool.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CLIENT_KEY_PATTERN, NAMESPACE_PATTERN } from 'dsh-frontend-tools-client'
import type { ClientRoster } from './key-store.ts'

/** Collaborators the admin tools drive. */
export interface AdminDeps {
  /** Client roster owning register/revoke/list state. */
  readonly roster: ClientRoster
  /** Bound loopback port advertised in register output; `undefined` before bind completion. */
  readonly port: () => number | undefined
  /** Live-session facts for one namespace. */
  readonly sessionInfo: (namespace: string) => { connected: boolean; toolCount: number }
  /** Drop the namespace's live connection, if any. */
  readonly dropSession: (namespace: string) => boolean
}

/** Render one admin result as formatted JSON text (`generic` presentation). */
function renderValue(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Assert one admin-tool namespace argument.
 * @param namespace - candidate namespace from the model.
 * @throws Error with a model-readable reason when the namespace is invalid.
 */
function expectNamespace(namespace: unknown): string {
  if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`namespace must be a string matching ${NAMESPACE_PATTERN.source} (for example "eatc")`)
  }
  return namespace
}

/**
 * Assert one admin-tool key argument.
 * @param key - candidate DSH KEY from the model (the user pasted it into the conversation).
 * @throws Error with a model-readable reason when the key does not carry full entropy.
 */
function expectKey(key: unknown): string {
  if (typeof key !== 'string' || !CLIENT_KEY_PATTERN.test(key)) {
    throw new Error(`key must be a string matching ${CLIENT_KEY_PATTERN.source}; the application generates it with the client SDK's generateClientKey`)
  }
  return key
}

/**
 * Register the three bridge-admin tools on `ctx.tools`.
 * @param ctx - plugin context carrying the tool registry.
 * @param deps - roster and server collaborators.
 * @returns the disposer removing every admin tool.
 */
export function registerAdminTools(ctx: Context, deps: AdminDeps): () => void {
  const register: ToolDefinition = {
    name: 'frontend_tools_register_client',
    description: '为前端工具桥登记一个应用接入凭证：应用自己生成 DSH KEY（客户端 SDK 的 generateClientKey，64 位十六进制，通常在应用"查看 DSH KEY"入口展示）并交给用户，用户把 KEY 连同命名空间告诉你（可直接粘贴应用的复制文本），你调用本工具完成登记。同一命名空间重复登记会替换旧 KEY 并使其立即失效。登记成功后应用即可连接。',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '应用命名空间（1-32 个 [A-Za-z0-9_-] 字符），将作为模型可见工具名前缀，如 eatc' },
        key: { type: 'string', description: '应用生成的 DSH KEY（64 位十六进制，来自应用的"查看 DSH KEY"入口或 generateClientKey）' },
      },
      required: ['namespace', 'key'],
    },
    output: { schema: {}, render: renderValue },
    execute(args: unknown): Promise<unknown> {
      const namespace = expectNamespace((args as { namespace?: unknown }).namespace)
      const key = expectKey((args as { key?: unknown }).key)
      const replaced = deps.roster.register(namespace, key)
      const port = deps.port()
      return Promise.resolve({
        namespace,
        url: port === undefined ? 'ws://127.0.0.1:<bridge-port>' : `ws://127.0.0.1:${String(port)}`,
        replaced,
        note: [
          '登记完成，凭证已生效；输出不回显 KEY（用户消息里已有）。',
          '应用侧使用 dsh-frontend-tools-client：createFrontendToolsClient({ url, key })，连接后注册工具。',
          '应用重新生成 KEY 后需再次登记（旧 KEY 立即失效）。',
        ].join('\n'),
      })
    },
  }

  const list: ToolDefinition = {
    name: 'frontend_tools_list_clients',
    description: '列出前端工具桥的全部已登记客户端（命名空间、连接状态、工具数）。不返回 KEY（凭证由应用自行生成与保管，任何工具输出都不回显）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: renderValue },
    execute(): Promise<unknown> {
      return Promise.resolve({
        clients: deps.roster.namespaces().map(namespace => ({ namespace, ...deps.sessionInfo(namespace) })),
      })
    },
  }

  const revoke: ToolDefinition = {
    name: 'frontend_tools_revoke_client',
    description: '吊销前端工具桥的一个应用接入凭证：删除该命名空间的登记，并立即断开其活跃连接、注销其全部工具。',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '要吊销的应用命名空间' },
      },
      required: ['namespace'],
    },
    output: { schema: {}, render: renderValue },
    execute(args: unknown): Promise<unknown> {
      const namespace = expectNamespace((args as { namespace?: unknown }).namespace)
      const existed = deps.roster.revoke(namespace)
      if (!existed) return Promise.resolve({ namespace, revoked: false, reason: '该命名空间没有已登记的凭证' })
      const dropped = deps.dropSession(namespace)
      return Promise.resolve({ namespace, revoked: true, connectionDropped: dropped })
    },
  }

  const disposers = [register, list, revoke].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}
