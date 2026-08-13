//! dsh-desktop: Tauri 2.x shell around the `dsh` Node host.
//!
//! The crate is the desktop half of the desktop integration. It embeds the
//! built web frontend, spawns the `dsh --profile web` host in a sidecar
//! process, and exposes a small IPC surface (`host_info`, `shutdown_host`)
//! so the WebView can synchronise with the host lifecycle.
//!
//! @module dsh_desktop_lib

mod dialog;
mod host;
mod menu;
mod shutdown;
mod tray;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};
use tokio::sync::Notify;

/// Cordis-agnostic desktop bootstrap. The Tauri process is intentionally
/// Cordis-free: every Cordis plugin lives in the Node host, and the host
/// serves them through the unchanged `webserver` + `apiproxy` pair.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialise a single env_logger subscriber; the WebView swallows
    // stdout on release builds so this is mostly useful while developing.
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .try_init();

    let host = host::NodeHost::new();
    let host_for_setup = host.clone();
    let host_for_event = host.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .manage(host)
        .manage(Arc::new(Notify::new()))
        .setup(move |app| {
            tray::install(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // The dialog bridge must be listening before the Node host
                // spawns: its URL goes into the host's `DSH_DESKTOP_URL`.
                let dialog_url = match dialog::DialogServer::spawn(handle.clone()).await {
                    Ok(server) => server.url(),
                    Err(err) => {
                        log::error!("dialog bridge failed to start: {err:?}");
                        return;
                    }
                };
                match host_for_setup.start(&handle, &dialog_url).await {
                    Ok(info) => {
                        log::info!("node host is up at {}", info.url);
                        // The window in tauri.conf.json targets a placeholder
                        // URL; the host picked a (possibly different) port,
                        // so navigate the WebView to the real address.
                        if let Some(window) = handle.get_webview_window("main") {
                            if let Err(err) = window.navigate(info.url.parse().unwrap()) {
                                log::error!("navigate to {} failed: {err}", info.url);
                            }
                            if let Err(err) = window.show() {
                                log::error!("show main window failed: {err}");
                            }
                            if let Err(err) = window.set_focus() {
                                log::error!("set focus failed: {err}");
                            }
                        } else {
                            log::error!("main WebView window was not created");
                        }
                    }
                    Err(err) => {
                        log::error!("node host failed to start: {err:?}");
                        if let Some(window) = handle.get_webview_window("main") {
                            // Surface the error in the WebView rather than
                            // exiting silently; the user can copy it from the
                            // dev tools.
                            let body = format!(
                                "DeepSeek Harness failed to start the Node host.\n\n\
                                 {err}\n\n\
                                 See $DSH_HOME/logs/ for the host-side trace."
                            );
                            let _ = window.eval(format!(
                                "document.body.innerText = {};",
                                serde_json::to_string(&body)
                                    .unwrap_or_else(|_| "\"<encode error>\"".to_string())
                            ));
                            let _ = window.show();
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // The Node host must die with the WebView; running on the
                // async runtime keeps the close from blocking the UI.
                let host = host_for_event.clone();
                tauri::async_runtime::block_on(async move {
                    host.shutdown().await;
                });
                let _ = window;
            }
        })
        .menu(menu::build)
        .invoke_handler(tauri::generate_handler![
            host::host_info,
            host::shutdown_host,
            shutdown::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Make sure the host is gone even when the OS forces the
                // process down. `block_on` here is safe: the Tauri runtime
                // already finished dispatching UI events.
                tauri::async_runtime::block_on(async move {
                    let state: tauri::State<'_, host::NodeHost> = app_handle.state();
                    state.shutdown().await;
                });
            }
        });
}
