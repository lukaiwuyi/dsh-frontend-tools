// Proves the client roster: static and persisted entries merge under strict
// uniqueness, lookups authenticate a presented key in constant time per
// candidate, register enforces the application-key pattern and replaces or
// persists credentials, revoke removes and persists, and a malformed roster
// file fails load instead of discarding credentials.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRoster } from '../src/index.ts'

/** Deterministic 64-hex keys; register input comes from applications. */
const KEY_A = 'aa'.repeat(32)
const KEY_B = 'bb'.repeat(32)

/** Fresh temp directory per roster, so persisted files never cross tests. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'ftb-roster-'))
}

/** POSIX owner-only file mode asserted when the platform supports chmod. */
function mode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('ClientRoster · load', () => {
  it('treats a missing roster file as an empty registered set', () => {
    const roster = ClientRoster.load(freshDir(), [])
    expect(roster.namespaces()).toEqual([])
  })

  it('merges persisted and static entries, static entries stay unmanageable', () => {
    const dir = freshDir()
    const roster = ClientRoster.load(dir, [])
    roster.register('eatc', KEY_A)
    const reloaded = ClientRoster.load(dir, [{ namespace: 'demo', key: 'demo-secret' }])
    expect(reloaded.namespaces()).toEqual(['demo', 'eatc'])
    expect(reloaded.lookup(KEY_A)).toBe('eatc')
    expect(reloaded.lookup('demo-secret')).toBe('demo')
    expect(() => reloaded.register('demo', KEY_B)).toThrow(/statically configured/)
    expect(() => reloaded.revoke('demo')).toThrow(/statically configured/)
  })

  it('rejects a namespace colliding across the file and static list', () => {
    const dir = freshDir()
    ClientRoster.load(dir, []).register('eatc', KEY_A)
    expect(() => ClientRoster.load(dir, [{ namespace: 'eatc', key: 'other' }])).toThrow(/collides/)
  })

  it('rejects a static key reused by another client', () => {
    const dir = freshDir()
    ClientRoster.load(dir, []).register('eatc', KEY_A)
    const persisted = JSON.parse(readFileSync(join(dir, 'frontend-tools-clients.json'), 'utf8')) as Array<{ namespace: string; key: string }>
    expect(() => ClientRoster.load(dir, [{ namespace: 'demo', key: persisted[0]!.key }])).toThrow(/reuses a key/)
  })

  it('fails loud on a roster file that is valid JSON but not an array', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), '{"namespace": "eatc"}')
    expect(() => ClientRoster.load(dir, [])).toThrow(/must be a JSON array/)
  })

  it('fails loud on a malformed roster file', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), '{not json')
    expect(() => ClientRoster.load(dir, [])).toThrow(/not valid JSON/)
  })

  it('fails loud on a roster file that is not an array of client objects', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), '[{"namespace": 42}]')
    expect(() => ClientRoster.load(dir, [])).toThrow(/must carry string/)
  })

  it('fails loud on roster file entries that are not objects', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), '[42]')
    expect(() => ClientRoster.load(dir, [])).toThrow(/must be an object/)
    writeFileSync(join(dir, 'frontend-tools-clients.json'), '[null]')
    expect(() => ClientRoster.load(dir, [])).toThrow(/must be an object/)
  })

  it('fails loud on roster file keys that are not non-empty strings', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), JSON.stringify([{ namespace: 'eatc', key: 42 }]))
    expect(() => ClientRoster.load(dir, [])).toThrow(/must carry string/)
    writeFileSync(join(dir, 'frontend-tools-clients.json'), JSON.stringify([{ namespace: 'eatc', key: '' }]))
    expect(() => ClientRoster.load(dir, [])).toThrow(/must carry string/)
  })

  it('rejects a namespace repeated inside the roster file', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'frontend-tools-clients.json'), JSON.stringify([
      { namespace: 'eatc', key: 'one' },
      { namespace: 'eatc', key: 'two' },
    ]))
    expect(() => ClientRoster.load(dir, [])).toThrow(/repeats namespace/)
  })

  it('rejects invalid namespaces from static configuration', () => {
    expect(() => ClientRoster.load(freshDir(), [{ namespace: 'not allowed!', key: 'x' }])).toThrow(/must match/)
  })

  it('rejects an empty static key', () => {
    expect(() => ClientRoster.load(freshDir(), [{ namespace: 'eatc', key: '' }])).toThrow(/non-empty key/)
  })
})

describe('ClientRoster · lookup', () => {
  it('resolves registered and static keys to their namespaces', () => {
    const roster = ClientRoster.load(freshDir(), [{ namespace: 'demo', key: 'demo-secret' }])
    roster.register('eatc', KEY_A)
    expect(roster.lookup(KEY_A)).toBe('eatc')
    expect(roster.lookup('demo-secret')).toBe('demo')
    expect(roster.lookup('unknown')).toBeUndefined()
  })
})

describe('ClientRoster · register', () => {
  it('persists a fresh credential and replaces the previous key on re-register', () => {
    const dir = freshDir()
    const roster = ClientRoster.load(dir, [])
    expect(roster.register('eatc', KEY_A)).toBe(false)
    expect(roster.lookup(KEY_A)).toBe('eatc')

    expect(roster.register('eatc', KEY_B)).toBe(true)
    expect(roster.lookup(KEY_A)).toBeUndefined()
    expect(roster.lookup(KEY_B)).toBe('eatc')

    // The replacement survived persistence.
    expect(ClientRoster.load(dir, []).lookup(KEY_B)).toBe('eatc')
    if (process.platform !== 'win32') expect(mode(join(dir, 'frontend-tools-clients.json'))).toBe(0o600)
  })

  it('accepts re-registering the same key for the same namespace (idempotent)', () => {
    const dir = freshDir()
    const roster = ClientRoster.load(dir, [])
    roster.register('eatc', KEY_A)
    expect(roster.register('eatc', KEY_A)).toBe(true)
    expect(roster.lookup(KEY_A)).toBe('eatc')
  })

  it('rejects a key already bound to another namespace', () => {
    const roster = ClientRoster.load(freshDir(), [{ namespace: 'demo', key: 'demo-secret' }])
    roster.register('eatc', KEY_A)
    expect(() => roster.register('other', KEY_A)).toThrow(/already registered/)
  })

  it('rejects keys that do not carry the required entropy', () => {
    const roster = ClientRoster.load(freshDir(), [])
    for (const key of ['short', 'X'.repeat(64), KEY_A.slice(0, 63), '']) {
      expect(() => roster.register('eatc', key)).toThrow(/must match/)
    }
  })

  it('rejects an invalid namespace', () => {
    const roster = ClientRoster.load(freshDir(), [])
    expect(() => roster.register('bad namespace', KEY_A)).toThrow(/must match/)
  })
})

describe('ClientRoster · revoke', () => {
  it('removes the credential, persists the change, and reports unknown namespaces', () => {
    const dir = freshDir()
    const roster = ClientRoster.load(dir, [])
    roster.register('eatc', KEY_A)
    expect(roster.revoke('eatc')).toBe(true)
    expect(roster.lookup(KEY_A)).toBeUndefined()
    expect(roster.namespaces()).toEqual([])
    expect(roster.revoke('eatc')).toBe(false)
    expect(ClientRoster.load(dir, []).namespaces()).toEqual([])
  })
})

describe('ClientRoster · persistence resilience', () => {
  it('keeps serving lookups when the roster directory disappears after load', () => {
    const dir = freshDir()
    const roster = ClientRoster.load(dir, [])
    roster.register('eatc', KEY_A)
    rmSync(dir, { recursive: true, force: true })
    // Read-only operations keep working; a later register would recreate the directory.
    expect(roster.lookup(KEY_A)).toBe('eatc')
  })
})
