/**
 * Package-owned invariant companion for `dsh-frontend-tools-bridge`.
 * @module dsh-frontend-tools-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-frontend-tools-bridge'

/** Cordis companion plugin name. */
export const name = 'frontend-tools-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge writes no session events and owns no
 * durable state. Its connection↔registration relation is effect-scoped and
 * covered by the lifecycle tests (a dropped socket must unregister its tools).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
