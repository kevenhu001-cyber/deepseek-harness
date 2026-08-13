/**
 * Detect whether the current JavaScript context is running inside the Tauri
 * desktop shell.
 *
 * Tauri 2.x injects `window.__TAURI_INTERNALS__` on every page it owns; the
 * global is the canonical signal that the host process is `dsh-desktop`
 * rather than a regular browser tab. The detection never throws so the
 * webapp can keep rendering even if the desktop shell failed to inject the
 * global (for example when the bundled binary cannot resolve the sidecar).
 *
 * @returns `true` when the WebView is owned by the Tauri shell.
 */

declare global {
  interface Window {
    /**
     * Internal metadata exposed by the Tauri 2.x runtime. The presence of an
     * object here is the contract this module relies on; do not consume its
     * fields directly — use `@tauri-apps/api/core#invoke` instead.
     */
    __TAURI_INTERNALS__?: unknown
  }
}

export function isTauriDesktop(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.__TAURI_INTERNALS__ === 'object' && window.__TAURI_INTERNALS__ !== null
}
