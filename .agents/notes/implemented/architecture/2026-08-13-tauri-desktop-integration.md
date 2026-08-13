# Agent Note: Tauri desktop integration

Status: implemented

English | [中文](2026-08-13-tauri-desktop-integration.zh.md)

## Problem

The web app (`dsh --profile web`) is a browser application, but the product needs a real desktop GUI shell with native installers (`.msi`/`.nsis`, `.app`/`.dmg`, `.deb`/`.AppImage`) for Windows, macOS, and Linux. The operating system features the WebView cannot reach from a sandbox — native menu, system tray, and the OS directory chooser — require a trusted native peer process.

The `directory-picker-native` backend works when the Node host has a console-attached display (or shares a process tree with the launching tool), but in a desktop-embedded WebView scenario the Node process has neither. A deployment that upgrades from a plain `dsh web` to a desktop shell should keep the unchanged Cordis plugin tree; only the directory chooser provider changes.

## Decision

**Tauri 2.x as the shell framework.** The Rust process (`dsh-desktop`) spawns `dsh --profile web` as a sidecar (the same binary that ships standalone) and embeds the built web frontend in a system WebView. The shell is deliberately Cordis-free: it imports no `@deepseek-ai/cordis`, contributes no row to the plugin tree, and only owns OS integration surfaces the WebView cannot reach.

**Narrow IPC channel.** Tauri IPC exposes three commands — `host_info` (loopback descriptor), `shutdown_host` (stop the Node host only), `quit_app` (exit the whole process). Application traffic stays on the existing `apiproxy` HTTP surface. The WebView navigates to the Node host's loopback URL at setup, and the host dies with the shell (both `CloseRequested` and `RunEvent::ExitRequested` call `NodeHost::shutdown()`).

**Cross-process dialog bridge.** The Node host is a separate process and cannot call Tauri commands. The `directory-picker-tauri` consumer forwards `pick` requests via `POST {DSH_DESKTOP_URL}/api/desktop/dialog/pick-directory`. The outermost Rust process runs a tiny loopback HTTP service (`dialog.rs` using axum) that handles this endpoint through `tauri-plugin-dialog`'s non-blocking `pick_folder` API and returns the chosen absolute path (HTTP `204` on cancel). The service runs on an OS-assigned loopback port and publishes itself to the Node host as `DSH_DESKTOP_URL` before the host spawns. One dialog is serialised at a time per shell process.

**Bundle pinning.** The `web-app` bundle's `directory-picker` row is pinned to `@deepseek-ai/dsh-host-directory-picker-tauri` directly, replacing the previous `-auto` that resolved the backend at boot. The Cordis loader's `name` field does not support `!!js` expressions (only `disabled` does), and the same document cannot carry duplicate `id` values, so a runtime toggle through config is impossible. A browser-launched `dsh web` without the `DSH_DESKTOP_INTEGRATION=tauri` hint gets an actionable error that guides the operator to set `DSH_DESKTOP_URL` or compose the browse backend — not a silent fallback.

**Build pipeline.** `apps/desktop/scripts/before-build.mjs` generates placeholder icons if any are missing, builds the webapp dist, and copies it into the Tauri `frontendDist` directory, all before `cargo tauri build`. The root `package.json` carries `desktop:*` scripts.

**CI.** `.github/workflows/desktop.yml` builds the matrix (ubuntu-22.04 / macos-latest / windows-latest) independently of `ci.yml` and its `all-checks-passed` verdict. Paths-only triggering avoids running desktop legs on changes that only affect the Node tree.

## Alternatives considered

**Electron as the shell framework.** Electron bundles a full Chromium runtime (~100 MB+ download); Tauri 2 uses the system WebView and a Rust binary (~5 MB release). The sidecar pattern fits the existing architecture — the Node host already runs as a child process — so the shell adds no second Node runtime, no IPC protocol beyond HTTP, and no extra lifecycle complexity.

**Extend the native picker backend for the desktop scenario (keep `-auto`).** `directory-picker-native` relies on shell access to console-attached display tooling (`osascript`, Zenity/kdialog, a spawned child process with COM); the desktop shell's WebView provides none of these. Routing through the shell's `tauri-plugin-dialog` keeps the dialog on the correct OS event loop (message queue, DPI context) and avoids platform-specific hacks in the child process. The cross-process bridge (Node → Rust HTTP) is the minimal channel given that Tauri commands are only callable from the WebView JS context, not from a separate child process.

**Use `!!js` on the bundle `name` field to toggle between `-auto` and `-tauri` at boot.** The Cordis loader only evaluates JS expressions for `disabled`, not `name`, and duplicate `id` values in the same document throw a `duplicate loader entry id` error. The only viable approach is to pin the row statically in the bundle that carries the row.

**Let the WebView call `tauri-plugin-dialog` from JavaScript directly (skip the HTTP bridge).** The directory picker is invoked by the Cordis workspace flow inside the Node host process, not the WebView. The Node host cannot reach Tauri commands, so an HTTP loopback bridge is the only channel that keeps the consumer on the Node side without moving the chooser logic into the WebView's runtime.

## Consequences

- Directory selection now requires the Rust dialog bridge: a plain `dsh web` process with the current `web-app` bundle gets an actionable error on `pick()` rather than falling back to `-auto`. Operators who run a browser-only deployment must compose `-browse` or stick with an older bundle until the bundle row changes, or set a `DSH_DESKTOP_URL` manually for a remotely-hosted helper.
- The Rust shell carries `axum` + `tokio` as additional dependencies (compilation time only; the binary stays small because axum is a Rust-native stack).
- Windows/macOS CI legs now run `tauri/tauri-action@v0` which pulls the Rust toolchain and produces real bundle artifacts. These are informational — they do not gate `all-checks-passed` — but every PR touching `apps/desktop/**` must wait for them.
- Placeholder icons, stub menu, and stub tray are tracked as deferred work; they add no Cordis surface.