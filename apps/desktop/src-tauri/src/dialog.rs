//! Loopback HTTP bridge for the directory chooser.
//!
//! The Node host is a separate process and cannot call Tauri commands, so
//! `dsh-desktop` exposes a tiny loopback HTTP service that the
//! `directory-picker-tauri` Cordis consumer forwards its `pick` requests to.
//! The service owns the real OS dialog through `tauri-plugin-dialog` and
//! answers with the chosen absolute path (HTTP `204` on cancel).
//!
//! The service listens on `127.0.0.1` on an OS-assigned port and publishes
//! that URL to the Node host as `DSH_DESKTOP_URL`; only the local harness
//! process can reach it. One dialog can be in flight at a time per shell
//! process; a second concurrent `pick` request waits for the first dialog to
//! settle before its own dialog opens.
//!
//! @module dsh_desktop_dialog

use std::path::PathBuf;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Loopback HTTP service owning the OS directory dialog.
pub struct DialogServer {
    /// Port the service listens on.
    pub port: u16,
}

impl DialogServer {
    /// Start the bridge on an OS-assigned loopback port and serve until the
    /// process exits. Fails loud when the listener cannot bind.
    pub async fn spawn(app: AppHandle) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();

        let router = Router::new().route(
            "/api/desktop/dialog/pick-directory",
            post(move || pick_directory(app.clone())),
        );

        tauri::async_runtime::spawn(async move {
            if let Err(err) = axum::serve(listener, router).await {
                log::error!("dialog bridge exited: {err}");
            }
        });

        Ok(Self { port })
    }

    /// Loopback URL the Node host forwards `pick` requests to.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// One dialog in flight: a second `pick` request waits for the first dialog
/// to settle so the OS dialog stack stays single-file.
static DIALOG_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Open the OS directory dialog and answer with the chosen absolute path.
///
/// The non-blocking `pick_folder` API keeps the dialog on the UI thread while
/// this handler waits on a oneshot channel; the callback delivers the chosen
/// `FilePath` (or `None` on cancel). Any abort from the caller surfaces as an
/// HTTP error because the dialog itself cannot be force-closed from here.
async fn pick_directory(app: AppHandle) -> Response {
    let _guard = DIALOG_MUTEX.lock().await;

    let (tx, rx) = oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title("Choose a directory")
        .pick_folder(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });

    match rx.await {
        Ok(Some(path)) => Json(serde_json::json!({ "path": path.to_string_lossy() })).into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "dialog callback was dropped without a result",
        )
            .into_response(),
    }
}
