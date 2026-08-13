# 桌面集成

[English](desktop.md) | 中文

本文档是 Tauri 桌面外壳的架构主入口,定义外壳的职责范围、保留在 Node 宿主中的内容,以及每个 capability seam 跨越 WebView 边界的位置。逐 crate 的参考位于 [`apps/desktop/README.md`](../apps/desktop/README.md),运行时子进程参考位于 [`apps/desktop/src-tauri/src/host.rs`](../apps/desktop/src-tauri/src/host.rs);本文描述集成形态,而非构建步骤。

## 外壳的职责

外壳是一个轻量 Rust 进程,只承担三件事:

- **派生 Node 宿主** 作为 sidecar,并把 WebView 引导到宿主的回环端口([`host.rs`](../apps/desktop/src-tauri/src/host.rs))。
- **桥接 WebView 沙箱无法完成的 OS 集成**:原生菜单、系统托盘、目录选择器所需的 IPC 联通([`menu.rs`](../apps/desktop/src-tauri/src/menu.rs)、[`tray.rs`](../apps/desktop/src-tauri/src/tray.rs),以及 [`lib.rs`](../apps/desktop/src-tauri/src/lib.rs) 中的 `/api/desktop/dialog/pick-directory` 路由)。
- **共同退出**:WebView 的 `CloseRequested` 钩子与 Tauri `RunEvent::ExitRequested` 都会调用 `NodeHost::shutdown()`,保证宿主随外壳一起关闭。

其余所有内容——Cordis 插件、会话日志、agent 循环、模型适配器、工具、持久化、设置——都运行在 Node 宿主之中。外壳在设计上完全脱离 Cordis:`dsh-desktop` 不导入 `@deepseek-ai/cordis`,也不会向插件树贡献任何 row。

## 边界示意图

```
+-------------------+  sidecar  +----------------------+
|  Tauri shell      | --------> |  dsh --profile web    |
|  (Rust + WebView) |           |  (Node + Cordis tree) |
+-------------------+           +----------------------+
        |                                  |
        |  IPC: host_info / shutdown       |  HTTP: /api/* + /webapp/*
        |       / quit_app                |         + /api/desktop/dialog/*
        v                                  v
   WebView window                    Loopback port (default 3080)
   http://127.0.0.1:3080
```

WebView 不通过 Tauri IPC 传输应用流量;凡是 Cordis 树已对外提供的能力,均通过既有的 `apiproxy` HTTP 表面消费。Tauri IPC 保持为狭窄的运营通道(宿主生命周期、退出)。

## 跨越边界的 capability seam

| Seam | 宿主侧 | 外壳侧 |
|---|---|---|
| `webserver` + `apiproxy` | 标准 HTTP 表面 | 不变——WebView 直接消费 |
| `directoryPicker` | [`directory-picker-tauri`](../packages/host/directory-picker-tauri/README.md)(Consumer) | 回环 HTTP 桥 ([`dialog.rs`](../apps/desktop/src-tauri/src/dialog.rs) + `tauri-plugin-dialog`)(Provider)——`POST /api/desktop/dialog/pick-directory` |
| 原生菜单 | 无 | `apps/desktop/src-tauri/src/menu.rs`(桩) |
| 系统托盘 | 无 | `apps/desktop/src-tauri/src/tray.rs`(桩) |
| Sidecar 生命周期 | Node 宿主进程 | `host.rs` 中的 `NodeHost` 状态机 |
| 窗口生命周期 | 无 | `lib.rs` 的 `on_window_event` + `RunEvent::ExitRequested` |

[`directory-picker`](../packages/host/directory-picker/README.md) seam 在 native、browse 与 Tauri 三种部署下共用同一个 Service Definition,只有 Provider 变化。同时组合 `-native` 与 `-tauri` 会重复注册 `directoryPicker`,因此桌面集成补丁 [`packages/bundle/web-app/cordis.patch.yml`](../packages/bundle/web-app/cordis.patch.yml) 将 `-tauri` 钉为 Web 表面所组合的行。

## 前端 ↔ 外壳桥

- [`host-detect.ts`](../apps/desktop/src/host-detect.ts) 检测 `window.__TAURI_INTERNALS__`——Tauri 2.x 标识宿主进程为 `dsh-desktop` 的标准信号。
- [`tauri-bridge.ts`](../apps/desktop/src/tauri-bridge.ts) 包装三个 IPC 命令(`host_info`、`shutdown_host`、`quit_app`),在外壳之外直接 no-op,因此 webapp 在普通浏览器里仍可正常渲染。

桥有意保持精简:重型协调走既有的 `apiproxy` HTTP 表面,IPC 通道仅承担运营层面的生命周期。

## Sidecar 宿主约定

`host::NodeHost::start()` 返回 `{ port, url }`,外壳随后把 WebView 导航到该 `url`。宿主选取一个可用端口(可通过 `DSH_DESKTOP_PORT` 覆盖),并通过同一个回环回报 `/healthz` 就绪状态。宿主进程正是单独发行时的 `dsh --profile web` 二进制;外壳不向 Cordis 树增加任何内容。

`host::NodeHost::shutdown()` 同时挂在 WebView close 钩子与 `RunEvent::ExitRequested` 上,通过 async 运行时执行,确保 Node 宿主与 WebView 同生同死。webapp 通过 `shutdown_host` 二次触发是幂等的。

## 构建流水线

复合 pre-build 脚本 [`apps/desktop/scripts/before-build.mjs`](../apps/desktop/scripts/before-build.mjs) 在 `cargo tauri build` 之前依次执行三步:

1. 若任一图标缺失则重新生成占位图标([`scripts/gen-tauri-placeholder-icons.mjs`](../scripts/gen-tauri-placeholder-icons.mjs))。
2. 执行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build` 产出 webapp dist。
3. 把 webapp dist 拷贝到 `apps/desktop/webapp`([`copy-web-dist.mjs`](../apps/desktop/scripts/copy-web-dist.mjs))。

webapp 拥有自己的 Vite 配置;桌面外壳从不直接 import 它的源码。dist 拷贝在每次构建时清空并重建目标目录,确保 Tauri 打包器始终走一份全新的目录树。

## 已知限制

外壳当前只提供占位的菜单、托盘与图标实现。目录选择器是唯一已落地的 OS 集成面(对应 Cordis `directoryPicker` 能力);菜单与托盘的替换属于后续工作,不涉及 Cordis 表面的改动。尚未注册自动更新(`tauri-plugin-updater`);集成阶段以手动重装作为受支持的更新路径。

[桌面集成 Agent Note](../.agents/notes/implemented/architecture/2026-08-13-tauri-desktop-integration.md) 记录设计决策与被否决的备选方案;[Tauri Windows CI 拓扑笔记](../.agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.md) 覆盖跨平台 CI 策略。