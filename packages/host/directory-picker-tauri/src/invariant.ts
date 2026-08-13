/**
 * Package-owned invariant companion for the Tauri-shell directory-picker backend.
 * @module @deepseek-ai/dsh-host-directory-picker-tauri/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-directory-picker-tauri'

/** Cordis companion plugin name. */
export const name = 'host-directory-picker-tauri-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each pick is one stateless HTTP round trip to the Tauri shell. */
const install: InvariantInstaller = () => {}

/**
 * Register the Tauri-shell directory-picker invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
