//! Node host sidecar: spawns `dsh --profile web` and supervises its lifetime.
//!
//! The Tauri process is the desktop shell only; the actual Cordis plugin tree,
//! HTTP server, and LLM adapters run in the Node host so the existing `dsh web`
//! command stays the single source of truth for plugin composition. The host
//! is started hidden, bound to a randomly chosen loopback port, and torn down
//! when the WebView window closes.
//!
//! @module dsh_desktop_lib::host

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;

/// Maximum time the supervisor waits for the host to answer the health probe.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Poll interval for the health probe.
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Grace period between `start_kill` and a hard `kill` during shutdown.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Information returned to the WebView through the `host_info` command.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// Loopback port the Node host is listening on.
    pub port: u16,
    /// Loopback URL the WebView is expected to load.
    pub url: String,
}

/// Supervises one `dsh` subprocess. Cloning is cheap: both halves share the
/// same child handle through an `Arc<Mutex<…>>`.
#[derive(Clone)]
pub struct NodeHost {
    child: Arc<Mutex<Option<Child>>>,
    info: Arc<Mutex<Option<HostInfo>>>,
}

impl NodeHost {
    /// Construct an empty supervisor. `start()` populates the child handle.
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            info: Arc::new(Mutex::new(None)),
        }
    }

    /// Resolve the absolute path of the `dsh` binary.
    ///
    /// Resolution order:
    /// 1. `DSH_DESKTOP_HOST_BIN` (escape hatch for testing custom builds).
    /// 2. Production: a sibling of the current executable (the bundler
    ///    drops `dsh` next to `dsh-desktop` on Windows/Linux; macOS places
    ///    it under `Contents/Resources`).
    /// 3. Development: first hit in `PATH`.
    fn resolve_dsh_binary(app: &tauri::AppHandle) -> Result<PathBuf> {
        if let Ok(explicit) = std::env::var("DSH_DESKTOP_HOST_BIN") {
            let path = PathBuf::from(explicit);
            if path.exists() {
                return Ok(path);
            }
        }

        // Production: walk from the current executable to a sibling `dsh` (or
        // `dsh.cmd` on Windows) and macOS `Contents/Resources/dsh`.
        if let Ok(exe) = std::env::current_exe() {
            let exe_dir = exe.parent().map(PathBuf::from);
            if let Some(dir) = exe_dir {
                #[cfg(windows)]
                let candidates: &[&str] = &["dsh.cmd", "dsh.exe", "dsh"];
                #[cfg(not(windows))]
                let candidates: &[&str] = &["dsh"];

                for name in candidates {
                    let candidate = dir.join(name);
                    if candidate.exists() {
                        return Ok(candidate);
                    }
                }

                // macOS app bundle: Contents/MacOS/<exe> → Contents/Resources/dsh
                if cfg!(target_os = "macos") {
                    let resources = dir
                        .parent()
                        .map(|p| p.join("Resources").join("dsh"));
                    if let Some(path) = resources {
                        if path.exists() {
                            return Ok(path);
                        }
                    }
                }
            }
        }

        // Development: rely on `which` against the current PATH.
        if let Ok(path) = which::which("dsh") {
            return Ok(path);
        }

        // Last resort: walk up from CARGO_MANIFEST_DIR (the `src-tauri` dir)
        // and look for `node_modules/.bin/dsh(.cmd)` shipped by the workspace.
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let root = PathBuf::from(manifest)
                .parent()
                .map(|p| p.parent())
                .flatten()
                .map(|p| p.to_path_buf());
            if let Some(root) = root {
                #[cfg(windows)]
                let bins: &[&str] = &[
                    "node_modules/.bin/dsh.cmd",
                    "node_modules/.bin/dsh.exe",
                ];
                #[cfg(not(windows))]
                let bins: &[&str] = &["node_modules/.bin/dsh"];

                for rel in bins {
                    let candidate = root.join(rel);
                    if candidate.exists() {
                        return Ok(candidate);
                    }
                }
            }
        }

        let app_name = app.package_info().name.clone();
        bail!(
            "{app_name}: cannot locate the `dsh` binary. Set DSH_DESKTOP_HOST_BIN, install it on PATH, \
             or place it next to the desktop executable."
        )
    }

    /// Resolve the port the Node host should listen on.
    ///
    /// Resolution order:
    /// 1. `DSH_DESKTOP_PORT` (escape hatch: pin a port so a debugger can
    ///    reach the host directly, or so an existing `dsh web` on
    ///    `127.0.0.1:3080` is reused).
    /// 2. An OS-assigned loopback port from a probe bind.
    fn pick_port() -> Result<u16> {
        if let Ok(raw) = std::env::var("DSH_DESKTOP_PORT") {
            if let Ok(port) = raw.trim().parse::<u16>() {
                if port != 0 {
                    // Verify the chosen port is actually free: a stale
                    // `dsh` from a previous launch could still hold it.
                    if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                        return Ok(port);
                    }
                }
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").context("bind 127.0.0.1:0")?;
        let port = listener
            .local_addr()
            .context("read local_addr from probe listener")?
            .port();
        drop(listener);
        Ok(port)
    }

    /// Wait until `http://127.0.0.1:{port}/healthz` returns 2xx, or fail
    /// with the captured child stderr when the deadline elapses.
    async fn wait_ready(port: u16) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .context("build reqwest client")?;
        let url = format!("http://127.0.0.1:{port}/healthz");
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    log::info!("node host ready on {url}");
                    return Ok(());
                }
                Ok(resp) => {
                    log::debug!("node host not ready yet: HTTP {}", resp.status());
                }
                Err(err) => {
                    log::debug!("node host not ready yet: {err}");
                }
            }

            if tokio::time::Instant::now() >= deadline {
                bail!("node host did not become ready within {READY_TIMEOUT:?} (probed {url})");
            }
            sleep(READY_POLL_INTERVAL).await;
        }
    }

    /// Spawn the Node host, wait for it to accept HTTP traffic, and store
    /// its descriptor so the Tauri command layer can read it.
    ///
    /// `dialog_url` is the loopback address of the dialog bridge (see
    /// `dialog.rs`); it is exported to the host as `DSH_DESKTOP_URL` so the
    /// directory-picker-tauri consumer can forward `pick` requests to it.
    pub async fn start(&self, app: &tauri::AppHandle, dialog_url: &str) -> Result<HostInfo> {
        if self.info.lock().await.is_some() {
            bail!("node host already started");
        }

        let port = Self::pick_port()?;
        let bin = Self::resolve_dsh_binary(app)?;
        log::info!("spawning dsh: {} --profile web --port {port} --host 127.0.0.1", bin.display());

        // We deliberately do not pass the parent's stdio to the host: the
        // host writes its own log file under $DSH_HOME/logs, and a Tauri
        // window would otherwise steal a pipe the WebView never sees.
        let mut cmd = Command::new(&bin);
        cmd.args(["--profile", "web", "--port", &port.to_string(), "--host", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Forward the env so the host can read DSH_* vars (credentials,
        // settings paths, snapshot toggles) the same way `dsh web` does.
        for (key, value) in std::env::vars() {
            if key.starts_with("DSH_") || key == "PATH" || key == "HOME" || key == "USERPROFILE" {
                cmd.env(key, value);
            }
        }
        // Hint the host that the Tauri shell owns the lifecycle so the
        // bundle can pick the right configuration overlay, and publish the
        // dialog-bridge descriptor the directory-picker-tauri consumer
        // forwards its `pick` requests to.
        cmd.env("DSH_DESKTOP_INTEGRATION", "tauri");
        cmd.env("DSH_DESKTOP_URL", dialog_url);

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn `dsh` (looked at {})", bin.display()))?;

        *self.child.lock().await = Some(child);
        Self::wait_ready(port).await?;

        let info = HostInfo {
            port,
            url: format!("http://127.0.0.1:{port}"),
        };
        *self.info.lock().await = Some(info.clone());
        Ok(info)
    }

    /// Ask the host to exit. `start_kill` is SIGTERM on Unix and a console
    /// close on Windows; the grace window falls back to a hard `kill` if the
    /// child ignores the polite signal.
    pub async fn shutdown(&self) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            log::info!("shutting down node host");
            let _ = child.start_kill();
            match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
                Ok(_) => log::info!("node host exited cleanly"),
                Err(_) => {
                    log::warn!(
                        "node host did not exit within {SHUTDOWN_GRACE:?}; forcing kill"
                    );
                    let _ = child.kill().await;
                }
            }
        }
        *guard = None;
        *self.info.lock().await = None;
    }

    /// Snapshot of the host descriptor. `None` until `start()` resolves.
    pub async fn info(&self) -> Option<HostInfo> {
        self.info.lock().await.clone()
    }
}

impl Default for NodeHost {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri command: hand the WebView the loopback URL the Node host listens on.
#[tauri::command]
pub async fn host_info(state: tauri::State<'_, NodeHost>) -> Result<HostInfo, String> {
    state
        .info()
        .await
        .ok_or_else(|| "node host has not finished initialising".to_string())
}

/// Tauri command: ask the supervisor to terminate the Node host. Called by
/// the WebView when the user quits through the in-app close button; the
/// native window's `CloseRequested` handler calls into the same state.
#[tauri::command]
pub async fn shutdown_host(state: tauri::State<'_, NodeHost>) -> Result<(), String> {
    state.shutdown().await;
    Ok(())
}
