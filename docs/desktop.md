# Desktop integration

English | [中文](desktop.zh.md)

This document is the architectural home for the Tauri desktop shell. It defines what the shell owns, what stays in the Node host, and where each capability seam crosses the WebView boundary. The crate-by-crate reference lives in [`apps/desktop/README.md`](../apps/desktop/README.md) and the runtime subprocess reference in [`apps/desktop/src-tauri/src/host.rs`](../apps/desktop/src-tauri/src/host.rs); this document describes the integration shape rather than the build steps.

## What the shell owns

The shell is a thin Rust process with exactly three responsibilities:

- **Spawn the Node host** as a sidecar and bring up the WebView on the host's loopback port ([`host.rs`](../apps/desktop/src-tauri/src/host.rs)).
- **Bridge OS integration** the WebView cannot do from a sandbox: native menu, system tray, IPC reachability for the directory chooser ([`menu.rs`](../apps/desktop/src-tauri/src/menu.rs), [`tray.rs`](../apps/desktop/src-tauri/src/tray.rs), the `/api/desktop/dialog/pick-directory` route in [`lib.rs`](../apps/desktop/src-tauri/src/lib.rs)).
- **Tear down together**: the WebView's `CloseRequested` hook and Tauri `RunEvent::ExitRequested` both call `NodeHost::shutdown()` so the host dies with the shell.

Everything else — Cordis plugins, the session log, the agent loop, model adapters, tools, persistence, settings — runs in the Node host. The shell is Cordis-free by design: `dsh-desktop` does not import `@deepseek-ai/cordis` and does not contribute a row to the plugin tree.

## Boundary diagram

```
+-------------------+  sidecar  +----------------------+
|  Tauri shell      | --------> |  dsh --profile web    |
|  (Rust + WebView) |           |  (Node + Cordis tree) |
+-------------------+           +----------------------+
        |                                  |
        |  IPC: host_info / shutdown       |  HTTP: /api/* + /webapp/*
        |       / quit_app                |         + /api/desktop/dialog/*
        v                                  v
   WebView window                    Loopback port (default 3080)
   http://127.0.0.1:3080
```

The WebView never speaks Tauri IPC for application traffic; it uses the existing `apiproxy` HTTP surface for everything the Cordis tree already serves. Tauri IPC stays a narrow operational channel (host lifecycle, quit).

## Capability seams crossing the boundary

| Seam | In the host | In the shell |
|---|---|---|
| `webserver` + `apiproxy` | Standard HTTP surface | Unchanged — the WebView consumes it directly |
| `directoryPicker` | [`directory-picker-tauri`](../packages/host/directory-picker-tauri/README.md) (consumer) |  Loopback HTTP bridge via [`dialog.rs`](../apps/desktop/src-tauri/src/dialog.rs) + `tauri-plugin-dialog` (provider) — `POST /api/desktop/dialog/pick-directory` |
| Native menu | None | `apps/desktop/src-tauri/src/menu.rs` (stub) |
| System tray | None | `apps/desktop/src-tauri/src/tray.rs` (stub) |
| Sidecar lifecycle | Node host process | `NodeHost` state machine in `host.rs` |
| Window lifecycle | None | `lib.rs` `on_window_event` + `RunEvent::ExitRequested` |

The [`directory-picker`](../packages/host/directory-picker/README.md) seam keeps a single Service Definition across native, browse, and Tauri deployments; only the provider changes. Composing both `-native` and `-tauri` is a duplicate `directoryPicker` registration, so the desktop integration patch in [`packages/bundle/web-app/cordis.patch.yml`](../packages/bundle/web-app/cordis.patch.yml) pins `-tauri` as the row the Web surface composes.

## Frontend ↔ shell bridge

- [`host-detect.ts`](../apps/desktop/src/host-detect.ts) detects `window.__TAURI_INTERNALS__` — the canonical Tauri 2.x signal that the host process is `dsh-desktop`.
- [`tauri-bridge.ts`](../apps/desktop/src/tauri-bridge.ts) wraps the three IPC commands (`host_info`, `shutdown_host`, `quit_app`) and falls through to a no-op outside the shell so the webapp keeps rendering in a plain browser.

The bridge is intentionally tiny: heavy coordination goes through the existing `apiproxy` HTTP surface, and the IPC channel stays limited to operational lifecycle.

## Sidecar host contract

`host::NodeHost::start()` returns `{ port, url }` and the shell navigates the WebView to that `url`. The host picks an available port (overridable through `DSH_DESKTOP_PORT`) and reports `/healthz` readiness through the same loopback. The host process is the same `dsh --profile web` binary that ships standalone; the shell adds nothing to the Cordis tree.

`host::NodeHost::shutdown()` runs on the async runtime from both the WebView close hook and `RunEvent::ExitRequested`, so the Node host dies whenever the WebView dies. A second shutdown from the webapp via `shutdown_host` is idempotent.

## Build pipeline

The composite pre-build script [`apps/desktop/scripts/before-build.mjs`](../apps/desktop/scripts/before-build.mjs) runs three steps ahead of `cargo tauri build`:

1. Regenerate placeholder icons when any are missing ([`scripts/gen-tauri-placeholder-icons.mjs`](../scripts/gen-tauri-placeholder-icons.mjs)).
2. Run `pnpm --filter @deepseek-ai/dsh-web-frontend run build` to produce the webapp dist.
3. Copy the webapp dist into `apps/desktop/webapp` ([`copy-web-dist.mjs`](../apps/desktop/scripts/copy-web-dist.mjs)).

The webapp owns its Vite config; the desktop shell never imports its source directly. The dist copy wipes and refills the target directory on every build so the Tauri bundler walks a fresh tree.

## Limitations

The shell currently ships placeholder menu, tray, and icon implementations. The directory chooser is the only OS-integration surface that has a real consumer (the Cordis `directoryPicker` capability); menu and tray updates belong to follow-up work that adds no Cordis surface. Update wiring (`tauri-plugin-updater`) is not registered; manual reinstalls are the supported update path during the integration phase.

The [desktop integration Agent Note](../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-integration.md) records the design decisions and rejected alternatives; the [Tauri Windows CI topology note](../.agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.md) covers the cross-platform CI strategy.