# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

Tauri 2.x 桌面外壳:一个轻量 Rust 进程,把现有的 `dsh --profile web` Node 宿主作为 sidecar 派生出来,并把构建好的 Web 前端嵌入到系统 WebView(Windows/macOS/Linux)。桌面二进制没有给 Cordis 插件树新增任何内容——每条 capability seam(Provider、Consumer 与 Service Definition)都位于 Node 宿主之中,宿主通过不变的 `webserver` + `apiproxy` 配对来对外提供它们。Tauri 进程完全脱离 Cordis,只承担 WebView 沙箱无法完成的 OS 集成:原生菜单、系统托盘、sidecar 生命周期,以及目录选择器所需的 IPC 联通。

## 架构

```
+-------------------+  sidecar  +--------------------+
|  Tauri shell      | --------> |  dsh --profile web |
|  (Rust + WebView) |           |  (Node + Cordis)   |
+-------------------+           +--------------------+
        |                                 |
        |  IPC: host_info / shutdown      |  HTTP: /api/* + /webapp/*
        |       / quit_app                |        + /api/desktop/dialog/*
        v                                 v
   WebView window                  Loopback port (default 3080)
   http://127.0.0.1:3080
```

WebView 在 setup 阶段被导航到宿主绑定的回环 URL。宿主选取一个可用端口(可通过 `DSH_DESKTOP_PORT` 覆盖)并回传给外壳,外壳随后调用 `window.navigate(url)` 与 `window.show()`。若宿主启动失败,外壳会把错误写入页面正文,开发者控制台即可读取。

## Sidecar 生命周期

`apps/desktop/src-tauri/src/host.rs` 拥有 `NodeHost` 状态机:

- `start()` 解析 `dsh` 二进制(优先 PATH,再退回到二进制所在目录),以 `--profile web` 派生它,轮询 `/healthz` 直至就绪,然后返回 `{ port, url }`。
- `shutdown()` 在 WebView `CloseRequested` 钩子与 `RunEvent::ExitRequested` 上,通过 async 运行时执行,确保宿主与 WebView 同生同死。
- Web 端亦可通过 Tauri IPC 表面调用 `shutdown_host` 或 `quit_app`(见 `apps/desktop/src/tauri-bridge.ts`),无需硬刷新即可触发。

## 前端 ↔ 外壳桥

`apps/desktop/src/`:

- `host-detect.ts` 暴露 `isTauriDesktop()`——仅当 `window.__TAURI_INTERNALS__` 存在时为真。
- `tauri-bridge.ts` 包装三个命令(`host_info`、`shutdown_host`、`quit_app`),在外壳之外直接 no-op,因此 webapp 在没有 `dsh-desktop` 的普通浏览器里仍能正常渲染。

Cordis sidecar 宿主使用 [`directory-picker-tauri`](../../packages/host/directory-picker-tauri/README.md) 作为目录选择器;该 Consumer 发起 `POST /api/desktop/dialog/pick-directory`。最外层的外壳进程运行一个微型回环 HTTP 服务([`dialog.rs`](src-tauri/src/dialog.rs)),由它处理该端点并调用 `tauri-plugin-dialog` 的非阻塞式 `pick_folder` API,然后返回所选绝对路径(取消时返回 HTTP `204`)。每个外壳进程每次只序列化一个对话框。

桥的拆分是有意为之:IPC 通道只承担运营生命周期(`host_info` / `shutdown_host` / `quit_app`),对话框桥则是一条独立的、基于 HTTP 的通道,使得 Node 宿主无需任何 WebView-IPC 胶水即可触达。

## 构建脚本

`apps/desktop/scripts/`:

- `before-build.mjs`——复合 pre-build:若占位图标缺失则重新生成,然后执行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build`,再把 webapp dist 拷贝到 `apps/desktop/webapp`。
- `copy-web-dist.mjs`——清空并重建 `apps/desktop/webapp`,源数据来自 `packages/web-frontend/dist`,保证 Tauri 打包器每次都走一份全新的目录树。

根级 `pnpm run desktop:build` 脚本转发到 `apps/desktop/package.json::build`;`pnpm run desktop:dev` 转发到 `dev`(执行 `before:build && sync:web && cargo tauri dev`)。

## 构建矩阵

| 平台 | Target | 打包产物 |
|---|---|---|
| Linux | `x86_64-unknown-linux-gnu` | `.deb`、`.AppImage` |
| macOS | `aarch64-apple-darwin` | `.app`、`.dmg`、`.app.tar.gz` |
| Windows | `x86_64-pc-windows-msvc` | `.msi`、`.nsis.zip` |

桌面外壳没有任何 Windows/macOS 专属代码;平台差异收敛在 `tauri-plugin-dialog`、`tauri-plugin-shell`,以及 `apps/desktop/src-tauri/tauri.conf.json` 里声明的打包器默认项。

## 下载

Tauri 矩阵为每个桌面平台产出真实的安装包产物。最新的 `.msi` / `.nsis.zip`(Windows)、`.app.tar.gz` / `.dmg`(macOS)与 `.deb` / `.AppImage`(Linux)包均附在每个 GitHub Release 中;预发布的草稿位于 [Releases 页面](../../releases)。Windows 上 `.msi` 是最简单的安装方式,NSIS `.exe` 适合按用户安装,Linux 上直接使用 `.AppImage` 可绕过 `dpkg`。

## 品牌资源

`scripts/gen-tauri-brand-icons.mjs` 会从一张 1024x1024 的源 PNG 生成 `apps/desktop/src-tauri/icons/{32x32,128x128,128x128@2x}.png`、`icon.ico` 与 `icon.icns`。当 `deepseek-logo.png` 替换为新源后:

```sh
node scripts/gen-tauri-brand-icons.mjs path/to/source.png
```

Tauri 打包器按固定文件名读取这五个文件,因此重采样与 ICO/ICNS 容器布局的全部知识都收敛在此脚本中。

## CI

`.github/workflows/desktop.yml` 在每个触及 `apps/desktop/**`、`directory-picker-tauri` 包、`web-app` 组合包 patch 或本 workflow 的 PR 上运行矩阵,并在 master 上以同样的路径过滤运行。Linux 矩阵会安装 Tauri 运行时依赖(`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`patchelf`);Windows 与 macOS hosted runner 自带系统 WebView,无需额外包。每个 leg 将其打包产物以 `dsh-desktop-<target>` 名称上传,并在标签推送时由 `tauri-apps/tauri-action` 自动创建 GitHub 草稿 Release。

## 开发

Node 宿主启动与 `dsh web` 完全一致的 Cordis 树,所以桌面构建首先遵循 Web 应用[开发指南](../../docs/development.md)。在 Web 应用的一般前置条件满足后,桌面外壳只需要额外三步:

```sh
pnpm install --frozen-lockfile    # also pulls @tauri-apps/cli, @tauri-apps/api, plugin-dialog
pnpm run desktop:typecheck        # confirms the typed IPC wrappers still align
pnpm run desktop:dev              # cargo tauri dev with auto-rebuild of the webapp dist
```

`desktop:build` 在 `apps/desktop/src-tauri/target/<host-triple>/release/bundle/` 下产出 release 产物;Linux leg 在安装时还需要 `webkit2gtk-4.1`、`gtk-3`、`libayatana-appindicator3-1`(`tauri.conf.json` 的 `bundle.linux.deb.depends` 已声明)。

## 已知限制与延期工作

- **尚未接入自动更新**——`dsh-desktop` 没有注册 Tauri updater 监听器。集成阶段以手动重装作为受支持的更新路径。
- **菜单与托盘仍为桩模块**——`menu.rs` 返回 Tauri 默认项,`tray.rs` 安装一个占位 `TrayIconBuilder`。替换它们是后续工作,不涉及 Cordis 表面的改动。