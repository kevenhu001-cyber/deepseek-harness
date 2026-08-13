/**
 * Tauri-shell chooser backend of the directory-picker seam: registers
 * `ctx.directoryPicker` with the `native` capability, whose `pick(signal)`
 * forwards the request to the running `dsh-desktop` Rust shell over a
 * loopback HTTP channel. The Rust shell owns the real OS dialog (via the
 * `tauri-plugin-dialog` runtime), so the Node host never spawns a child
 * process or talks to a Zenity/KDialog/osascript binary directly — the
 * Tauri runtime picks the right native tier per platform and surfaces the
 * chosen absolute path back through JSON.
 *
 * Only viable when the process is owned by `dsh-desktop`: the integration
 * hint (`DSH_DESKTOP_INTEGRATION === 'tauri'`) is the contract the bundle
 * uses to choose this backend in place of `-native` (which depends on
 * host-side tooling the desktop shell already owns). Operators using
 * `dsh web` from a regular browser compose `-auto` instead, and that
 * resolution ignores the desktop row entirely.
 *
 * @module @deepseek-ai/dsh-host-directory-picker-tauri
 */

import {
  DirectoryPicker,
  type DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'

/** Integration hint the Rust shell exports when it owns the lifecycle. */
const TauriIntegration = 'tauri' as const

/** Endpoint exposed by `dsh-desktop` over its loopback bridge. */
const PICK_DIRECTORY_ENDPOINT = '/api/desktop/dialog/pick-directory'

/** Hard ceiling on the round trip so an aborted operator never wedges a request. */
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Loopback descriptor returned by the Rust shell's `host_info` command. */
export interface TauriHostDescriptor {
  /** Loopback URL the Node host is reachable at. */
  readonly url: string
}

/** Testable fetcher seam; defaults to `fetch` on Node 22+. */
export type TauriPickerFetcher = typeof fetch

/** Injectable platform facts for deterministic tests. */
export interface TauriPickerInternals {
  /** Override the loopback descriptor resolution (tests pin a fake URL). */
  resolveHost?: () => TauriHostDescriptor | null
  /** Override `fetch` to assert the bridge call without touching the network. */
  fetch?: TauriPickerFetcher
  /** Override the timeout; tests use a short budget to surface hangs. */
  timeoutMs?: number
}

/**
 * Resolve the loopback descriptor exposed by `dsh-desktop`.
 *
 * Reads `DSH_DESKTOP_URL` (or the legacy `DSH_DESKTOP_HOST_URL`) so the
 * Node host can locate the Rust shell without a sidecar protocol. Returns
 * `null` when the integration hint is missing — a plain `dsh web` process
 * must never silently talk to a non-existent endpoint.
 */
function readHostFromEnv(env: NodeJS.ProcessEnv): TauriHostDescriptor | null {
  if (env.DSH_DESKTOP_INTEGRATION !== TauriIntegration) return null
  const raw = env.DSH_DESKTOP_URL ?? env.DSH_DESKTOP_HOST_URL
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return { url: url.toString().replace(/\/$/, '') }
  } catch {
    return null
  }
}

/**
 * Open the Tauri directory chooser.
 *
 * @param signal - caller/connection lifetime; abort terminates the dialog
 *   before the user finishes picking.
 * @param internals - Fetcher / resolver hooks for deterministic tests.
 * @returns the chosen absolute path, or `null` when the operator cancels.
 * @throws when the Tauri shell is unreachable or reports a non-recoverable
 *   failure; the surface is owned by the bridge, so any abort propagates.
 */
export async function pickTauriDirectory(
  signal: AbortSignal,
  internals: TauriPickerInternals = {},
): Promise<string | null> {
  const host = (internals.resolveHost ?? (() => readHostFromEnv(process.env)))()
  if (host === null) {
    throw new Error(
      'tauri directory picker is only available inside dsh-desktop (set DSH_DESKTOP_URL)',
    )
  }
  const fetcher = internals.fetch ?? fetch
  const timeoutMs = internals.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })

  const timeout = setTimeout(() => controller.abort(new Error('tauri dialog timed out')), timeoutMs)

  try {
    const response = await fetcher(`${host.url}${PICK_DIRECTORY_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })

    if (response.status === 204) return null
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(`tauri directory picker failed (HTTP ${response.status}): ${message}`)
    }

    const payload = await response.json() as { path?: unknown }
    if (payload.path === null || payload.path === undefined) return null
    if (typeof payload.path !== 'string') {
      throw new Error('tauri directory picker returned a non-string path')
    }
    return payload.path
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}

/** The `ctx.directoryPicker` Tauri-shell implementation (stable capability object per service life). */
export default class TauriDirectoryPicker extends DirectoryPicker {
  private readonly tauriCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => pickTauriDirectory(signal),
  }

  /**
   * The Tauri-shell interaction capability.
   * @returns the stable `native` capability object — the consumer surfaces
   * are identical to `-native`, only the implementation differs.
   */
  capability(): DirectoryPickerCapability {
    return this.tauriCapability
  }
}
