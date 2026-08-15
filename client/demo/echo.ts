/**
 * Minimal demo: connect to a running frontend-tools bridge and register one
 * `echo` tool the model can call. Run with (from packages/frontend-tools/client):
 *
 *   node --import tsx/esm demo/echo.ts
 *
 * The demo owns its credential like a real application: without
 * `DSH_FRONTEND_TOOLS_KEY` it generates a fresh DSH KEY, prints it, and exits —
 * register that key with the bridge (for example `frontend_tools_register_client`
 * with namespace `demo`) and run again with it in the environment. The process
 * stays alive while connected; interrupt it to unregister.
 */

import { createFrontendToolsClient, generateClientKey } from '../src/index.ts'

const url = process.env.DSH_FRONTEND_TOOLS_URL ?? 'ws://127.0.0.1:31870'
const key = process.env.DSH_FRONTEND_TOOLS_KEY
if (key === undefined || key.length === 0) {
  console.error(`demo: no credential yet — register this freshly generated DSH KEY under namespace "demo", then rerun with DSH_FRONTEND_TOOLS_KEY set:\n\n  ${generateClientKey()}\n`)
  process.exit(1)
}

const client = createFrontendToolsClient({ url, key })
client.onStateChange(state => console.log(`demo: ${state}`))

await client.connect()
const names = await client.registerTools([{
  name: 'echo',
  description: 'Echo the provided message back. Use it to verify the frontend-tools bridge end to end.',
  parametersSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The text to echo back.' },
    },
    required: ['message'],
  },
  async execute(args: unknown) {
    const message = (args as { message?: unknown }).message
    return { echoed: message }
  },
}])

console.log(`demo: registered ${names.join(', ')} — the model can now call them`)
