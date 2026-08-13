// Suppress the extra console window on Windows release builds; the WebView
// already owns the user-facing UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Native entry point. Defers all logic to `dsh_desktop_lib::run` so the
/// `lib` crate type stays a reusable `cdylib` (mobile, integration tests).
fn main() {
    dsh_desktop_lib::run();
}
