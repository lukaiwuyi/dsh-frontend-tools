/**
 * Client roster: the authoritative namespace↔key mapping the bridge
 * authenticates against. Each registered key carries exactly one namespace,
 * so the key doubles as the client's identity: the handshake presents only
 * the key, and the namespace bound at registration time decides the public
 * tool-name prefix. Applications generate their own DSH KEYs (64 hex chars,
 * {@link CLIENT_KEY_PATTERN}) and have them registered through the admin
 * tools; registered credentials persist as a JSON file (mode 600 on POSIX)
 * under the harness state directory, so they survive bridge restarts.
 * Statically configured clients live only in `cordis.yml` (their keys are
 * free-form strings owned by the configuration) and cannot be replaced or
 * revoked through the admin tools.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLIENT_KEY_PATTERN, NAMESPACE_PATTERN } from 'dsh-frontend-tools-client'

/** One statically configured client entry from `cordis.yml`. */
export interface StaticClient {
  /** Namespace this client's tools are mirrored under. */
  readonly namespace: string
  /** Handshake DSH KEY presented by this client; binds it to the namespace. */
  readonly key: string
}

/** One client credential as persisted to the roster file. */
interface PersistedClient {
  readonly namespace: string
  readonly key: string
}

/** Roster file name inside the resolved state directory. */
const ROSTER_FILE = 'frontend-tools-clients.json'

/**
 * Assert a namespace against the wire pattern shared with the protocol.
 * @param namespace - candidate namespace from config, admin tools, or the roster file.
 * @throws Error when the namespace does not match `NAMESPACE_PATTERN`.
 */
function expectNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`frontend-tools namespace ${JSON.stringify(namespace)} must match ${NAMESPACE_PATTERN.source}`)
  }
}

/**
 * Decode and validate the persisted roster file.
 * @param raw - file contents.
 * @returns the persisted clients in file order.
 * @throws Error when the contents are not an array of `{namespace, key}` string pairs;
 *   a corrupted roster fails load instead of silently discarding credentials.
 */
function parseRosterFile(raw: string): PersistedClient[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`frontend-tools client roster is not valid JSON: ${String(error)}`)
  }
  if (!Array.isArray(value)) throw new Error('frontend-tools client roster must be a JSON array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`frontend-tools client roster entry #${index} must be an object`)
    }
    const { namespace, key } = entry as Record<string, unknown>
    if (typeof namespace !== 'string' || typeof key !== 'string' || key.length === 0) {
      throw new Error(`frontend-tools client roster entry #${index} must carry string { namespace, key }`)
    }
    expectNamespace(namespace)
    return { namespace, key }
  })
}

/**
 * The live roster: registered credentials (persisted) plus statically
 * configured ones (config-only), indexed both ways for O(1) identity lookup.
 */
export class ClientRoster {
  /** namespace → key, covering static and registered entries. */
  private readonly keys = new Map<string, string>()
  /** Namespaces owned by `cordis.yml` static configuration. */
  private readonly staticNamespaces = new Set<string>()
  /** Absolute path of the persisted roster file. */
  private readonly file: string

  private constructor(file: string) {
    this.file = file
  }

  /**
   * Load the roster: read the persisted file (an absent file is an empty
   * roster), then merge the static clients on top.
   * @param stateDir - directory holding the roster file; created when missing.
   * @param staticClients - statically configured clients from `cordis.yml`.
   * @returns the loaded roster.
   * @throws Error when the roster file is unreadable or malformed, or a
   *   namespace (or key) repeats across the file and the static list —
   *   duplicate identities are configuration errors and fail loud at load.
   */
  static load(stateDir: string, staticClients: readonly StaticClient[]): ClientRoster {
    const file = join(stateDir, ROSTER_FILE)
    const roster = new ClientRoster(file)
    const persisted = (() => {
      try {
        return parseRosterFile(readFileSync(file, 'utf8'))
      } catch (error) {
        // A missing file is the first-run state, not an error.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    })()
    for (const client of persisted) {
      if (roster.keys.has(client.namespace)) {
        throw new Error(`frontend-tools client roster repeats namespace "${client.namespace}"`)
      }
      roster.keys.set(client.namespace, client.key)
    }
    for (const client of staticClients) {
      expectNamespace(client.namespace)
      if (client.key.length === 0) {
        throw new Error(`static client "${client.namespace}" must carry a non-empty key`)
      }
      if (roster.keys.has(client.namespace)) {
        throw new Error(`static client namespace "${client.namespace}" collides with the registered roster`)
      }
      if ([...roster.keys.values()].includes(client.key)) {
        throw new Error(`static client "${client.namespace}" reuses a key already held by another client`)
      }
      roster.keys.set(client.namespace, client.key)
      roster.staticNamespaces.add(client.namespace)
    }
    return roster
  }

  /**
   * Resolve one presented key to its bound namespace.
   *
   * Comparison against every candidate runs in constant time per candidate
   * (`timingSafeEqual`); candidate count is not a secret worth protecting.
   * @param key - key presented in a `hello` frame.
   * @returns the bound namespace, or `undefined` when the key is unknown.
   */
  lookup(key: string): string | undefined {
    for (const [namespace, candidate] of this.keys) {
      if (candidate.length !== key.length) continue
      if (timingSafeEqual(Buffer.from(candidate), Buffer.from(key))) return namespace
    }
    return undefined
  }

  /**
   * Register (or replace) the credential for one namespace and persist it.
   *
   * The key comes from the application (generated with the client SDK);
   * this entry point is model-reachable through the admin tools, so it
   * enforces the full-entropy {@link CLIENT_KEY_PATTERN} and rejects a
   * key another namespace already holds (one credential must identify one
   * client). Re-registering replaces the previous key immediately: the old
   * credential stops authenticating, and a connection still holding it is
   * dropped by the caller through the returned namespace.
   * @param namespace - namespace to bind the key to.
   * @param key - application-generated DSH KEY matching `CLIENT_KEY_PATTERN`.
   * @returns whether a previous credential for the namespace was replaced.
   * @throws Error when the namespace is invalid, the key does not match the
   *   pattern, the key is already bound to another namespace, or the
   *   namespace is statically configured.
   */
  register(namespace: string, key: string): boolean {
    expectNamespace(namespace)
    if (!CLIENT_KEY_PATTERN.test(key)) {
      throw new Error(`frontend-tools client key must match ${CLIENT_KEY_PATTERN.source} (generate it with the client SDK's generateClientKey)`)
    }
    if (this.staticNamespaces.has(namespace)) {
      throw new Error(`namespace "${namespace}" is statically configured in cordis.yml; edit the configuration instead of registering`)
    }
    if (key !== this.keys.get(namespace) && [...this.keys.values()].includes(key)) {
      throw new Error('key is already registered for another namespace; one credential identifies one client')
    }
    const replaced = this.keys.has(namespace)
    this.keys.set(namespace, key)
    this.persist()
    return replaced
  }

  /**
   * Revoke one registered credential and persist the change.
   * @param namespace - namespace whose credential is revoked.
   * @returns whether a credential existed and was removed.
   * @throws Error when the namespace is statically configured.
   */
  revoke(namespace: string): boolean {
    if (this.staticNamespaces.has(namespace)) {
      throw new Error(`namespace "${namespace}" is statically configured in cordis.yml; remove it from the configuration instead of revoking`)
    }
    const existed = this.keys.delete(namespace)
    if (existed) this.persist()
    return existed
  }

  /**
   * Namespaces in the roster, sorted for stable admin-tool output.
   * @returns every static and registered namespace.
   */
  namespaces(): string[] {
    return [...this.keys.keys()].sort()
  }

  /** Persist the registered (non-static) credentials to the roster file with owner-only permissions. */
  private persist(): void {
    const registered = [...this.keys.entries()]
      .filter(([namespace]) => !this.staticNamespaces.has(namespace))
      .map(([namespace, key]) => ({ namespace, key }))
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(registered, null, 2)}\n`)
    // POSIX owner-only permissions; Windows has no portable chmod, so the
    // roster there relies on the user profile's directory ACL.
    /* v8 ignore next -- platform branch: each lane exercises its own side only. */
    if (process.platform !== 'win32') chmodSync(this.file, 0o600)
  }
}
