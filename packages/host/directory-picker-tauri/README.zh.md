# @deepseek-ai/dsh-host-directory-picker-tauri

[English](README.md) | 中文

[directory-picker 能力缝](../directory-picker/README.md)的 **Tauri 外壳选择器后端**: `TauriDirectoryPicker` 以 `native` 能力注册 `ctx.directoryPicker`,其 `pick(signal)` 通过 loopback HTTP 通道把每个请求转发到正在运行的 [`dsh-desktop`](../../../../apps/desktop/README.md) Rust 外壳。Rust 外壳通过 `tauri-plugin-dialog` 拥有真正的系统对话框;Node host 从不派生子进程,也不直接调用 Zenity / KDialog / osascript。

仅当 Node host 由 `dsh-desktop` 拥有时才能使用: 集成提示 `DSH_DESKTOP_INTEGRATION === 'tauri'` 是 bundle 用以选择本后端代替 [`-native`](../directory-picker-native/README.md) 的契约。从普通浏览器使用 `dsh web` 的操作员组合 [`-auto`](../directory-picker-auto/README.md),该解析永远走不到本 desktop 行。

端点契约是 `POST {DSH_DESKTOP_URL}/api/desktop/dialog/pick-directory`,返回 `{ path: string | null }`(取消时返回 HTTP `204`)。`dsh-desktop` 必须在 Tauri command 表面同时注册对应的处理器;否则 `pick` 直接抛出可读错误,而不是静默超时。

## Model Experience

无。后端只服务 GUI host 的目录选择;本包不触及任何模型请求。

#### KV Cache effect

无;本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **依赖桌面外壳端点** — 若 `dsh-desktop` 未运行,或未暴露 `/api/desktop/dialog/pick-directory`,`pick` 直接抛出可读错误。在非 Tauri 部署中组合本行会在加载时失败。
- **无回退等级** — browse 后端([`-browse`](../directory-picker-browse/README.md))仍是组合层的回退;同时挂载本行与 `-browse` 的 overlay 把两个选项都留给操作员。
- **不可选择 native binary** — 对话框由 `tauri-plugin-dialog` 的原生层提供(Win32 `IFileOpenDialog`、macOS `NSOpenPanel`、Linux GTK portal),因此 `-native` 现有的平台工具保证(Zenity / KDialog 回退)不再适用。
