//! System tray. Placeholder stub.
//!
//! The Tauri builder calls `tray::install` during setup so the desktop
//! shell boots even without a tray icon. A future PR will wire the real
//! tray with show/quit actions and a status indicator that mirrors the
//! Node host lifecycle.

use tauri::tray::{TrayIcon, TrayIconBuilder};

/// Install the (placeholder) tray icon.
///
/// Returning an empty `TrayIcon` (no icon, no menu) keeps the shell
/// functional without a visible tray entry. Users on platforms without a
/// system tray (e.g. some Linux desktops) see no regression; the WebView's
/// in-app close button is the supported shutdown path. The real tray lands
/// alongside the menu and global shortcuts work tracked in the desktop
/// integration plan.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    TrayIconBuilder::with_id("dsh-desktop-placeholder").build(app)
}
