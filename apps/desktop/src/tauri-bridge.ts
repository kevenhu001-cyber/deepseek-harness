/**
 * Typed wrappers around the Tauri commands registered by `dsh-desktop`.
 *
 * The desktop shell exposes three commands (see `apps/desktop/src-tauri/src/host.rs`
 * and `shutdown.rs`):
 *
 * - `host_info`     → loopback URL the Node host listens on.
 * - `shutdown_host` → terminates only the Node host, leaving the WebView alive.
 * - `quit_app`      → tears down the entire desktop application.
 *
 * Every wrapper falls through to a safe no-op when the page is not loaded
 * inside the Tauri shell, so the webapp can keep rendering in a plain browser
 * without `dsh-desktop`. The bridge is intentionally tiny: the host is the
 * same Node process that powers `dsh web`, so heavy coordination goes
 * through the existing `apiproxy` HTTP surface rather than this channel.
 */

import { invoke } from '@tauri-apps/api/core'

import { isTauriDesktop } from './host-detect'

/** Loopback descriptor returned by the `host_info` Tauri command. */
export interface HostInfo {
  /** Loopback port the Node host is bound to. */
  readonly port: number
  /** Loopback URL the WebView is expected to navigate to. */
  readonly url: string
}

/**
 * Read the loopback descriptor of the Node host. Returns `null` outside the
 * Tauri shell so the caller can decide whether to wait, retry, or fall back
 * to a manually configured address.
 */
export async function readHostInfo(): Promise<HostInfo | null> {
  if (!isTauriDesktop()) return null
  return invoke<HostInfo>('host_info')
}

/** Terminate the Node host without closing the WebView. */
export async function shutdownHost(): Promise<void> {
  if (!isTauriDesktop()) return
  await invoke('shutdown_host')
}

/** Tear down the entire desktop application (WebView + Node host). */
export async function quitApp(): Promise<void> {
  if (!isTauriDesktop()) return
  await invoke('quit_app')
}
