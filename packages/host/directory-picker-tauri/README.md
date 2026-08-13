# @deepseek-ai/dsh-host-directory-picker-tauri

English | [中文](README.zh.md)

The **Tauri-shell chooser backend** of the [directory-picker seam](../directory-picker/README.md): `TauriDirectoryPicker` registers `ctx.directoryPicker` with the `native` capability, whose `pick(signal)` forwards each request to the running [`dsh-desktop`](../../../../apps/desktop/README.md) Rust shell over a loopback HTTP channel. The Rust shell owns the real OS dialog through `tauri-plugin-dialog`; the Node host never spawns a child process or talks to Zenity / KDialog / osascript directly.

Only viable when the Node host is owned by `dsh-desktop`: the integration hint `DSH_DESKTOP_INTEGRATION === 'tauri'` is the contract the bundle uses to choose this backend in place of [`-native`](../directory-picker-native/README.md). Operators using `dsh web` from a regular browser compose [`-auto`](../directory-picker-auto/README.md) instead, and that resolution never reaches the desktop row.

The endpoint contract is `POST {DSH_DESKTOP_URL}/api/desktop/dialog/pick-directory` returning `{ path: string | null }` (or HTTP `204` on cancel). `dsh-desktop` must register a matching handler alongside the Tauri command surface; without it `pick` throws with a descriptive message rather than silently timing out.

## Model Experience

None, as the backend serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Requires the desktop shell endpoint** — without `dsh-desktop` running and exposing `/api/desktop/dialog/pick-directory`, `pick` rejects with an actionable error. Composing this row outside a Tauri deployment fails loud at load.
- **No fallback tier** — the browse backend ([`-browse`](../directory-picker-browse/README.md)) remains the fallback at the composition level; an overlay that mounts this row plus `-browse` keeps both options open to the operator.
- **No choice of native binary** — the dialog comes from `tauri-plugin-dialog`'s native tier (Win32 `IFileOpenDialog`, macOS `NSOpenPanel`, Linux GTK portal), so the existing platform-tooling guarantees of `-native` (Zenity / KDialog fallback) do not apply.
