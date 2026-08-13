//! Application menu. Placeholder stub.
//!
//! The Tauri builder calls `menu::build` for every window, so the function
//! must return a `tauri::Result<Menu<R>>` even when the team has not yet
//! designed a native menu. Returning `Menu::default()` keeps the shell
//! functional; a future PR will replace this with the real menu wired to
//! the WebView's commands.

use tauri::menu::Menu;

/// Build the (placeholder) application menu.
///
/// Returning `Menu::default()` ensures the desktop shell boots even when the
/// user-installed build does not include the rich menu yet (for example on
/// internal CI builds). A real menu will land alongside the tray and global
/// shortcuts work tracked in the desktop integration plan.
pub fn build<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    Menu::default(_app)
}