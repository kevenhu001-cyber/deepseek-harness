# Agent Note: Tauri 桌面集成

Status: implemented

[English](2026-08-13-tauri-desktop-integration.md) | 中文

## 问题

Web 应用（`dsh --profile web`）是一个浏览器应用，但产品需要真正的桌面 GUI 壳，附带 Windows、macOS 和 Linux 的原生安装包（`.msi`/`.nsis`、`.app`/`.dmg`、`.deb`/`.AppImage`）。WebView 从沙箱中无法触及的操作系统特性——原生菜单、系统托盘和操作系统目录选择器——需要一个受信任的原生对等进程。

`directory-picker-native` 后端在 Node host 拥有控制台附件显示器（或与启动工具共享进程树）时工作正常，但在桌面嵌入式 WebView 场景中，Node 进程两者皆无。从纯 `dsh web` 升级到桌面壳的部署应当保持 Cordis 插件树不变；仅目录选择器提供方发生变化。

## 决策

**Tauri 2.x 作为壳框架。** Rust 进程（`dsh-desktop`）将 `dsh --profile web` 作为 sidecar 启动（与独立发布的同一二进制文件），并将构建好的 Web 前端嵌入系统 WebView。壳有意保持 Cordis 无关：它不导入 `@deepseek-ai/cordis`，不为插件树贡献任何行，仅拥有 WebView 无法触及的操作系统集成面。

**窄 IPC 通道。** Tauri IPC 暴露三个命令——`host_info`（loopback 描述符）、`shutdown_host`（仅停止 Node host）、`quit_app`（退出整个进程）。应用流量保留在已有的 `apiproxy` HTTP 表面。WebView 在设置时导航到 Node host 的 loopback URL，host 随壳一起终止（`CloseRequested` 和 `RunEvent::ExitRequested` 均调用 `NodeHost::shutdown()`）。

**跨进程对话框桥。** Node host 是一个独立进程，无法调用 Tauri 命令。`directory-picker-tauri` 消费者通过 `POST {DSH_DESKTOP_URL}/api/desktop/dialog/pick-directory` 转发 `pick` 请求。最外层的 Rust 进程运行一个小型 loopback HTTP 服务（`dialog.rs`，使用 axum），通过 `tauri-plugin-dialog` 的非阻塞 `pick_folder` API 处理该端点，并返回所选的绝对路径（取消时返回 HTTP `204`）。该服务运行在 OS 分配的 loopback 端口上，并在 host 启动前将自身发布为 `DSH_DESKTOP_URL`。每个壳进程一次只序列化一个对话框。

**Bundle 钉死。** `web-app` bundle 的 `directory-picker` 行直接钉死为 `@deepseek-ai/dsh-host-directory-picker-tauri`，取代了之前在启动时解析后端的 `-auto`。Cordis 加载器的 `name` 字段不支持 `!!js` 表达式（仅 `disabled` 支持），且同一文档不能有重复的 `id` 值，因此无法通过配置实现运行时切换。没有 `DSH_DESKTOP_INTEGRATION=tauri` 提示的浏览器启动 `dsh web` 会得到一个可操作错误，指导操作员设置 `DSH_DESKTOP_URL` 或组合 browse 后端——而不是静默回退。

**构建流水线。** `apps/desktop/scripts/before-build.mjs` 在 `cargo tauri build` 之前生成占位图标（如有缺失）、构建 webapp dist 并复制到 Tauri 的 `frontendDist` 目录。根 `package.json` 包含 `desktop:*` 脚本。

**CI。** `.github/workflows/desktop.yml` 独立于 `ci.yml` 及其 `all-checks-passed` 裁决，构建矩阵（ubuntu-22.04 / macos-latest / windows-latest）。仅路径触发避免在仅影响 Node 树的变更上运行桌面 legs。

## 曾考虑的替代方案

**Electron 作为壳框架。** Electron 捆绑完整的 Chromium 运行时（~100 MB+ 下载）；Tauri 2 使用系统 WebView 和 Rust 二进制（~5 MB 发布）。sidecar 模式适合现有架构——Node host 已经作为子进程运行——因此壳不增加第二个 Node 运行时、HTTP 之外的 IPC 协议或额外的生命周期复杂度。

**扩展原生 picker 后端以支持桌面场景（保留 `-auto`）。** `directory-picker-native` 依赖于 shell 访问控制台附件的显示工具（`osascript`、Zenity/kdialog、带 COM 的子进程派生）；桌面壳的 WebView 不提供这些。通过壳的 `tauri-plugin-dialog` 路由将对话框保留在正确的 OS 事件循环（消息队列、DPI 上下文）上，并避免了子进程中的平台特定 hack。跨进程桥（Node → Rust HTTP）是给定 Tauri 命令只能从 WebView JS 上下文调用、不能从独立子进程调用时的最小通道。

**使用 `!!js` 在 bundle `name` 字段上切换 `-auto` 和 `-tauri`。** Cordis 加载器只为 `disabled` 而不是 `name` 求值 JS 表达式，且同一文档中的重复 `id` 值会抛出 `duplicate loader entry id` 错误。唯一可行的方法是在携带该行的 bundle 中静态钉死。

**让 WebView 从 JavaScript 直接调用 `tauri-plugin-dialog`（跳过 HTTP 桥）。** 目录选择器由 Node host 进程内的 Cordis workspace 流程调用，而非 WebView。Node host 无法访问 Tauri 命令，因此 HTTP loopback 桥是保持消费者在 Node 端而不将选择器逻辑移入 WebView 运行时的唯一通道。

## 结果

- 目录选择现在需要 Rust 对话框桥：使用当前 `web-app` bundle 的纯 `dsh web` 进程在 `pick()` 上得到可操作错误，而不是回退到 `-auto`。运行纯浏览器部署的操作员必须组合 `-browse`、使用较早的 bundle 直到行更改，或者手动为远程托管的 helper 设置 `DSH_DESKTOP_URL`。
- Rust 壳携带 `axum` + `tokio` 作为额外依赖（仅编译时间影响；因 axum 是 Rust 原生栈，二进制体积很小）。
- Windows/macOS CI legs 现在运行 `tauri/tauri-action@v0`，它拉取 Rust 工具链并产生真实的 bundle 工件。这些是信息性的——它们不门控 `all-checks-passed`——但每个触及 `apps/desktop/**` 的 PR 都必须等待它们。
- 占位图标、存根菜单和存根托盘被跟踪为延后工作；它们不增加 Cordis 表面。