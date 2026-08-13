# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The Tauri 2.x desktop shell: a thin Rust process that spawns the existing `dsh --profile web` Node host as a sidecar and embeds the built web frontend in a system WebView (Windows/macOS/Linux). The desktop binary adds nothing new to the Cordis plugin tree — every capability seam (provider, consumer, and Service Definition) lives in the Node host, and the host serves them through the unchanged `webserver` + `apiproxy` pair. The Tauri process is Cordis-free and only owns OS integration that the WebView cannot do from a sandbox: native menu, system tray, sidecar lifecycle, and IPC reachability for the directory chooser.

## Architecture

```
+-------------------+  sidecar  +--------------------+
|  Tauri shell      | --------> |  dsh --profile web |
|  (Rust + WebView) |           |  (Node + Cordis)   |
+-------------------+           +--------------------+
        |                                 |
        |  IPC: host_info / shutdown      |  HTTP: /api/* + /webapp/*
        |       / quit_app                |        + /api/desktop/dialog/*
        v                                 v
   WebView window                  Loopback port (default 3080)
   http://127.0.0.1:3080
```

The WebView is configured to navigate to the loopback URL the host binds during setup. The host picks an available port (overridable through `DSH_DESKTOP_PORT`) and reports it back to the shell, which then calls `window.navigate(url)` and `window.show()`. If the host fails to start, the shell writes the error into the page body so the developer console can read it.

## Sidecar lifecycle

`apps/desktop/src-tauri/src/host.rs` owns the `NodeHost` state machine:

- `start()` resolves the `dsh` binary (PATH first, then the binary's own directory), spawns it with `--profile web`, polls `/healthz` until ready, and returns `{ port, url }`.
- `shutdown()` runs on the async runtime from the WebView `CloseRequested` hook and on `RunEvent::ExitRequested` so the host dies whenever the WebView dies.
- The webapp can also call `shutdown_host` or `quit_app` over the Tauri IPC surface (see `apps/desktop/src/tauri-bridge.ts`) without a hard reload.

## Frontend ↔ shell bridge

`apps/desktop/src/`:

- `host-detect.ts` exposes `isTauriDesktop()` — true only when `window.__TAURI_INTERNALS__` is present.
- `tauri-bridge.ts` wraps the three commands (`host_info`, `shutdown_host`, `quit_app`) and falls through to a no-op outside the shell, so the webapp keeps rendering in a plain browser without `dsh-desktop`.

The Cordis sidecar host uses [`directory-picker-tauri`](../../packages/host/directory-picker-tauri/README.md) as its directory chooser; that consumer posts to `POST /api/desktop/dialog/pick-directory`. The outermost shell process runs a tiny loopback HTTP service ([`dialog.rs`](src-tauri/src/dialog.rs)) that serves this endpoint and calls `tauri-plugin-dialog`'s non-blocking `pick_folder` API, then returns the chosen absolute path (or HTTP `204` on cancel). One dialog is serialised at a time per shell process.

The bridge is intentionally split: the IPC channel stays limited to operational lifecycle (`host_info` / `shutdown_host` / `quit_app`), while the dialog bridge is a second, HTTP-based channel so the Node host can reach it without any WebView-IPC glue.

## Build scripts

`apps/desktop/scripts/`:

- `before-build.mjs` — composite pre-build: regenerate placeholder icons if any are missing, run `pnpm --filter @deepseek-ai/dsh-web-frontend run build`, then copy the webapp dist into `apps/desktop/webapp`.
- `copy-web-dist.mjs` — wipes and refills `apps/desktop/webapp` from `packages/web-frontend/dist` so the Tauri bundler walks a fresh tree on every build.

The root-level `pnpm run desktop:build` script forwards to `apps/desktop/package.json::build`; `pnpm run desktop:dev` forwards to `dev` (which runs `before:build && sync:web && cargo tauri dev`).

## Build matrix

| Platform | Target | Bundle outputs |
|---|---|---|
| Linux | `x86_64-unknown-linux-gnu` | `.deb`, `.AppImage` |
| macOS | `aarch64-apple-darwin` | `.app`, `.dmg`, `.app.tar.gz` |
| Windows | `x86_64-pc-windows-msvc` | `.msi`, `.nsis.zip` |

The desktop shell has no Windows/macOS-specific code; platform facts stay in `tauri-plugin-dialog`, `tauri-plugin-shell`, and the bundler defaults declared in `apps/desktop/src-tauri/tauri.conf.json`.

## Downloads

The Tauri matrix produces real installer artefacts for every desktop platform. The most recent `.msi` / `.nsis.zip` (Windows), `.app.tar.gz` / `.dmg` (macOS) and `.deb` / `.AppImage` (Linux) bundles are attached to each GitHub Release; pre-release drafts live in the [Releases tab](../../releases). Pull the Windows `.msi` for the simplest install, the NSIS `.exe` for a per-user install, and the `.AppImage` on Linux to skip `dpkg` entirely.

## Brand assets

`scripts/gen-tauri-brand-icons.mjs` renders `apps/desktop/src-tauri/icons/{32x32,128x128,128x128@2x}.png`, `icon.ico`, and `icon.icns` from a single 1024x1024 source PNG. Run it after dropping a new source at `deepseek-logo.png`:

```sh
node scripts/gen-tauri-brand-icons.mjs path/to/source.png
```

The Tauri bundler picks the five files by their fixed names, so the script is the only place that knows about resampling and ICO/ICNS container layout.

## CI

`.github/workflows/desktop.yml` runs the matrix on every pull request that touches `apps/desktop/**`, the `directory-picker-tauri` package, the `web-app` bundle patch, or this workflow, plus on master pushes with the same path filter. The matrix installs the Linux Tauri runtime (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`); hosted Windows and macOS runners ship with their system WebView preinstalled and need no extra packages. Each leg uploads its bundle artefacts under `dsh-desktop-<target>` and (on tag pushes) lets `tauri-apps/tauri-action` publish a draft GitHub Release.

## Development

The Node host launches the same Cordis tree as `dsh web`, so a desktop build starts by following the web app's [development guide](../../docs/development.md). The desktop shell only needs three additional steps once the webapp's normal preconditions hold:

```sh
pnpm install --frozen-lockfile    # also pulls @tauri-apps/cli, @tauri-apps/api, plugin-dialog
pnpm run desktop:typecheck        # confirms the typed IPC wrappers still align
pnpm run desktop:dev              # cargo tauri dev with auto-rebuild of the webapp dist
```

`desktop:build` produces a release artifact under `apps/desktop/src-tauri/target/<host-triple>/release/bundle/`; the Linux leg additionally requires `webkit2gtk-4.1`, `gtk-3`, and `libayatana-appindicator3-1` to be installed at install time (declared in `tauri.conf.json`'s `bundle.linux.deb.depends`).

## Limitations and deferred work

- **No auto-update wiring yet** — `dsh-desktop` does not register Tauri updater listeners. Manual reinstalls are the supported update path during the integration phase.
- **Menu and tray are stubs** — `menu.rs` returns Tauri defaults, `tray.rs` installs a placeholder `TrayIconBuilder`. Replacing them is a follow-up that adds no Cordis surface.