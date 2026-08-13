//! Shutdown IPC commands exposed to the WebView.
//!
//! The Tauri builder registers `quit_app` so the WebView (and any future
//! tray "Quit" entry) can request a clean application exit. `app.exit(0)`
//! raises `RunEvent::ExitRequested`, which the builder in `lib.rs` uses to
//! tear down the Node host before the process dies.

/// Tauri command: terminate the desktop application cleanly.
///
/// Returns `()`; the actual process exit happens on the Tauri event loop
/// after the host shutdown hook runs.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
