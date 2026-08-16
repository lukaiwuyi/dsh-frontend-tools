// Proves the authoritative wire protocol decodes exactly the declared
// vocabulary in each direction and handshake phase, rejects every malformed
// variant with a coded error, and cross-round-trips: every frame one side
// encodes, the opposite side decodes.
import { describe, expect, it } from 'vitest'
import {
  CLIENT_KEY_PATTERN,
  FrontendToolsError,
  buildClientKeyClipboardText,
  encodeClientMessage,
  encodeServerMessage,
  generateClientKey,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  SERVER_ID,
} from '../src/index.ts'
import type { ClientMessage } from '../src/index.ts'

const HELLO = { type: 'hello', protocol: PROTOCOL_VERSION, key: 'secret' }
const ECHO = { name: 'echo', description: 'echo it back', parametersSchema: { type: 'object' } }

/** Assert a client frame rejects with the given code (and return the message). */
function rejectsWith(raw: string, phase: 'hello' | 'session', code: string): string {
  let thrown: unknown
  try {
    parseClientMessage(raw, phase)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(FrontendToolsError)
  expect((thrown as FrontendToolsError).code).toBe(code)
  return (thrown as FrontendToolsError).message
}

/** Assert a server frame rejects with the given code. */
function serverRejectsWith(raw: string, code: string): void {
  let thrown: unknown
  try {
    parseServerMessage(raw)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(FrontendToolsError)
  expect((thrown as FrontendToolsError).code).toBe(code)
}

describe('parseClientMessage · hello phase', () => {
  it('accepts a well-formed hello', () => {
    expect(parseClientMessage(JSON.stringify(HELLO), 'hello')).toEqual(HELLO)
  })

  it('rejects frames that are not JSON', () => {
    expect(rejectsWith('{not json', 'hello', 'invalid_message')).toContain('not valid JSON')
  })

  it('rejects frames that are not objects', () => {
    for (const raw of ['42', '"hello"', 'null', '[]']) rejectsWith(raw, 'hello', 'invalid_message')
  })

  it('rejects an unsupported protocol version', () => {
    expect(rejectsWith(JSON.stringify({ ...HELLO, protocol: PROTOCOL_VERSION + 1 }), 'hello', 'invalid_message')).toContain('not supported')
  })

  it('rejects a non-string key', () => {
    rejectsWith(JSON.stringify({ ...HELLO, key: 42 }), 'hello', 'invalid_message')
  })

  it('ignores unknown fields in hello (a v2 client still carrying namespace)', () => {
    expect(parseClientMessage(JSON.stringify({ ...HELLO, namespace: 'eatc' }), 'hello')).toEqual(HELLO)
  })

  it('rejects session vocabulary before the handshake', () => {
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [ECHO] }), 'hello', 'invalid_message')).toContain('completed handshake')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: 'x', ok: true }), 'hello', 'invalid_message')).toContain('completed handshake')
  })
})

describe('parseClientMessage · session phase', () => {
  it('rejects a second hello after the handshake', () => {
    expect(rejectsWith(JSON.stringify(HELLO), 'session', 'invalid_message')).toContain('first frame')
  })

  it('accepts a register batch and normalizes each spec', () => {
    const spec = { ...ECHO, outputSchema: { type: 'object' } }
    expect(parseClientMessage(JSON.stringify({ type: 'register', tools: [spec] }), 'session')).toEqual({
      type: 'register',
      tools: [spec],
    })
  })

  it('carries an optional readOnly flag through and drops it when absent', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'register', tools: [{ ...ECHO, readOnly: true }] }), 'session'))
      .toEqual({ type: 'register', tools: [{ ...ECHO, readOnly: true }] })
    // Absent stays absent (the bridge's safe default treats it as write).
    expect(parseClientMessage(JSON.stringify({ type: 'register', tools: [ECHO] }), 'session'))
      .toEqual({ type: 'register', tools: [ECHO] })
  })

  it('rejects a register without a non-empty tools array', () => {
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [] }), 'session', 'invalid_message')).toContain('non-empty array')
    rejectsWith(JSON.stringify({ type: 'register', tools: 'echo' }), 'session', 'invalid_message')
  })

  it('rejects malformed tool specs as invalid_tool', () => {
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [42] }), 'session', 'invalid_tool')).toContain('must be an object')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, name: 'has space' }] }), 'session', 'invalid_tool')).toContain('must match')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, name: '' }] }), 'session', 'invalid_tool')).toContain('must match')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, description: 42 }] }), 'session', 'invalid_tool')).toContain('description must be a string')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, readOnly: 'yes' }] }), 'session', 'invalid_tool')).toContain('readOnly must be a boolean')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, parametersSchema: 42 }] }), 'session', 'invalid_message')).toContain('must be a JSON object')
    expect(rejectsWith(JSON.stringify({ type: 'register', tools: [{ ...ECHO, outputSchema: [] }] }), 'session', 'invalid_message')).toContain('must be a JSON object')
  })

  it('accepts a successful callResult without an error field', () => {
    const frame = JSON.stringify({ type: 'callResult', callId: 'c1', ok: true, result: { value: 1 } })
    expect(parseClientMessage(frame, 'session')).toEqual({ type: 'callResult', callId: 'c1', ok: true, result: { value: 1 } })
  })

  it('accepts a failed callResult carrying a structured error', () => {
    const frame = JSON.stringify({ type: 'callResult', callId: 'c1', ok: false, error: { code: 'denied', message: 'not logged in' } })
    expect(parseClientMessage(frame, 'session')).toEqual({ type: 'callResult', callId: 'c1', ok: false, error: { code: 'denied', message: 'not logged in' } })
  })

  it('rejects malformed callResults', () => {
    expect(rejectsWith(JSON.stringify({ type: 'callResult', ok: true }), 'session', 'invalid_message')).toContain('callId')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: '', ok: true }), 'session', 'invalid_message')).toContain('callId')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: 'c1', ok: 'yes' }), 'session', 'invalid_message')).toContain('boolean')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: 'c1', ok: true, error: { code: 'denied', message: 'x' } }), 'session', 'invalid_message')).toContain('must be absent')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: 'c1', ok: false }), 'session', 'invalid_message')).toContain('must carry error')
    expect(rejectsWith(JSON.stringify({ type: 'callResult', callId: 'c1', ok: false, error: { code: 42 } }), 'session', 'invalid_message')).toContain('must carry error')
  })

  it('rejects unknown message types', () => {
    expect(rejectsWith(JSON.stringify({ type: 'goodbye' }), 'session', 'invalid_message')).toContain('unknown message type')
  })

  it('accepts a pong in the session phase and rejects it before the handshake', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'pong' }), 'session')).toEqual({ type: 'pong' })
    expect(rejectsWith(JSON.stringify({ type: 'pong' }), 'hello', 'invalid_message')).toContain('completed handshake')
  })

  it('accepts an unregister batch of raw names in the session phase', () => {
    const frame = JSON.stringify({ type: 'unregister', names: ['echo', 'probe'] })
    expect(parseClientMessage(frame, 'session')).toEqual({ type: 'unregister', names: ['echo', 'probe'] })
  })

  it('rejects malformed unregister batches', () => {
    expect(rejectsWith(JSON.stringify({ type: 'unregister', names: [] }), 'session', 'invalid_message')).toContain('non-empty array')
    rejectsWith(JSON.stringify({ type: 'unregister', names: 'echo' }), 'session', 'invalid_message')
    rejectsWith(JSON.stringify({ type: 'unregister', names: ['echo', 42] }), 'session', 'invalid_message')
    rejectsWith(JSON.stringify({ type: 'unregister', names: [''] }), 'session', 'invalid_message')
    expect(rejectsWith(JSON.stringify({ type: 'unregister', names: ['echo'] }), 'hello', 'invalid_message')).toContain('completed handshake')
  })
})

describe('parseServerMessage', () => {
  it('accepts every well-formed server message', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID, namespace: 'eatc' })))
      .toEqual({ type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID, namespace: 'eatc' })
    expect(parseServerMessage(JSON.stringify({ type: 'error', code: 'denied', message: 'not logged in' })))
      .toEqual({ type: 'error', code: 'denied', message: 'not logged in' })
    expect(parseServerMessage(JSON.stringify({ type: 'registered', names: ['eatc__echo'] })))
      .toEqual({ type: 'registered', names: ['eatc__echo'] })
    expect(parseServerMessage(JSON.stringify({ type: 'ping' })))
      .toEqual({ type: 'ping' })
    expect(parseServerMessage(JSON.stringify({ type: 'unregistered', names: ['echo'] })))
      .toEqual({ type: 'unregistered', names: ['echo'] })
    expect(parseServerMessage(JSON.stringify({ type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' } })))
      .toEqual({ type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' } })
  })

  it('rejects frames that are not JSON or not objects', () => {
    serverRejectsWith('{not json', 'invalid_message')
    serverRejectsWith('null', 'invalid_message')
  })

  it('rejects a welcome with an unsupported protocol, non-string server, or missing namespace', () => {
    serverRejectsWith(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION + 1, server: 'x', namespace: 'eatc' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, namespace: 'eatc' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID }), 'invalid_message')
  })

  it('rejects a welcome namespace outside the alphabet or length budget', () => {
    const base = { type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID }
    serverRejectsWith(JSON.stringify({ ...base, namespace: 'has space' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ ...base, namespace: '' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ ...base, namespace: 'a'.repeat(33) }), 'invalid_message')
  })

  it('rejects an error frame without code and message strings', () => {
    serverRejectsWith(JSON.stringify({ type: 'error', code: 42 }), 'invalid_message')
  })

  it('rejects a registered frame without a string-array names field', () => {
    serverRejectsWith(JSON.stringify({ type: 'registered', names: 'eatc__echo' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ type: 'registered', names: [42] }), 'invalid_message')
  })

  it('rejects a call frame without callId and name', () => {
    serverRejectsWith(JSON.stringify({ type: 'call', callId: '', name: 'echo' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ type: 'call', callId: 'c1' }), 'invalid_message')
  })

  it('rejects an unregistered frame without a string-array names field', () => {
    serverRejectsWith(JSON.stringify({ type: 'unregistered', names: 'echo' }), 'invalid_message')
    serverRejectsWith(JSON.stringify({ type: 'unregistered', names: [42] }), 'invalid_message')
  })

  it('rejects unknown message types', () => {
    serverRejectsWith(JSON.stringify({ type: 'goodbye' }), 'invalid_message')
  })
})

describe('cross-direction round-trips', () => {
  it('decodes every client-encoded frame in the server direction', () => {
    expect(parseClientMessage(encodeClientMessage(HELLO as ClientMessage), 'hello')).toEqual(HELLO)
    expect(parseClientMessage(encodeClientMessage({ type: 'register', tools: [ECHO] }), 'session')).toEqual({
      type: 'register',
      tools: [ECHO],
    })
    expect(parseClientMessage(encodeClientMessage({ type: 'unregister', names: ['echo'] }), 'session')).toEqual({
      type: 'unregister', names: ['echo'],
    })
    expect(parseClientMessage(encodeClientMessage({ type: 'callResult', callId: 'c1', ok: true, result: 1 }), 'session')).toEqual({
      type: 'callResult', callId: 'c1', ok: true, result: 1,
    })
    expect(parseClientMessage(encodeClientMessage({ type: 'callResult', callId: 'c1', ok: false, error: { code: 'denied', message: 'no' } }), 'session')).toEqual({
      type: 'callResult', callId: 'c1', ok: false, error: { code: 'denied', message: 'no' },
    })
    expect(parseClientMessage(encodeClientMessage({ type: 'pong' }), 'session')).toEqual({ type: 'pong' })
  })

  it('decodes every server-encoded frame in the client direction', () => {
    expect(parseServerMessage(encodeServerMessage({ type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID, namespace: 'eatc' }))).toEqual({
      type: 'welcome', protocol: PROTOCOL_VERSION, server: SERVER_ID, namespace: 'eatc',
    })
    expect(parseServerMessage(encodeServerMessage({ type: 'registered', names: ['eatc__echo'] }))).toEqual({
      type: 'registered', names: ['eatc__echo'],
    })
    expect(parseServerMessage(encodeServerMessage({ type: 'unregistered', names: ['echo'] }))).toEqual({
      type: 'unregistered', names: ['echo'],
    })
    expect(parseServerMessage(encodeServerMessage({ type: 'ping' }))).toEqual({ type: 'ping' })
    expect(parseServerMessage(encodeServerMessage({ type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' } }))).toEqual({
      type: 'call', callId: 'c1', name: 'echo', args: { message: 'hi' },
    })
    expect(parseServerMessage(encodeServerMessage({ type: 'error', code: 'denied', message: 'not logged in' }))).toEqual({
      type: 'error', code: 'denied', message: 'not logged in',
    })
  })
})

describe('client key contract', () => {
  it('generates keys matching the wire pattern', () => {
    for (let i = 0; i < 8; i++) {
      expect(generateClientKey()).toMatch(CLIENT_KEY_PATTERN)
    }
  })

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 32 }, () => generateClientKey()))
    expect(keys.size).toBe(32)
  })

  it('rejects guessable shapes against the pattern', () => {
    for (const candidate of ['', 'secret', 'A'.repeat(64), '0'.repeat(63), 'g'.repeat(64)]) {
      expect(CLIENT_KEY_PATTERN.test(candidate)).toBe(false)
    }
  })
})

describe('buildClientKeyClipboardText', () => {
  it('renders the three-line handoff text with an application name', () => {
    expect(buildClientKeyClipboardText({ namespace: 'eatc', key: 'a'.repeat(64), appName: '易统筹' }))
      .toBe(`[易统筹 · DSH 前端工具桥接入]\nnamespace: eatc\nkey: ${'a'.repeat(64)}`)
  })

  it('falls back to a bare header when no application name is given', () => {
    expect(buildClientKeyClipboardText({ namespace: 'demo', key: '0'.repeat(64) }))
      .toBe(`[DSH 前端工具桥接入]\nnamespace: demo\nkey: ${'0'.repeat(64)}`)
  })
})
