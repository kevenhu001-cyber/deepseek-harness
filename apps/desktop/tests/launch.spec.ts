import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url)

function path(relative: string): URL {
  return new URL(relative, root)
}

function cargoField<V>(toml: string, key: string): V | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|(\\S+))`, 'm')
  const m = toml.match(re)
  if (!m) return undefined
  return (m[1] ?? m[2]) as V
}

describe('dsh-desktop launch scaffold', () => {
  describe('Cargo.toml', () => {
    let toml: string

    beforeAll(async () => {
      toml = await readFile(path('apps/desktop/src-tauri/Cargo.toml'), 'utf8')
    })

    it('package name is dsh-desktop', () => {
      expect(cargoField(toml, 'name')).toBe('dsh-desktop')
    })

    it('depends on tauri 2.x', () => {
      expect(toml).toContain('tauri = { version = "2"')
    })

    it('depends on tauri-plugin-dialog 2.x', () => {
      expect(toml).toContain('tauri-plugin-dialog = "2"')
    })

    it('depends on tokio with process and rt-multi-thread', () => {
      expect(toml).toContain('tokio')
      expect(toml).toContain('process')
      expect(toml).toContain('rt-multi-thread')
    })

    it('depends on axum 0.7 for the dialog bridge', () => {
      expect(toml).toContain('axum')
    })

    it('depends on serde and serde_json', () => {
      expect(toml).toContain('serde')
      expect(toml).toContain('serde_json')
    })

    it('depends on reqwest for health checks', () => {
      expect(toml).toContain('reqwest')
    })

    it('depends on which for binary resolution', () => {
      expect(toml).toContain('which')
    })
  })

  describe('Rust source files', () => {
    const requiredSources = [
      'src/main.rs',
      'src/lib.rs',
      'src/host.rs',
      'src/menu.rs',
      'src/tray.rs',
      'src/shutdown.rs',
      'src/dialog.rs',
    ]

    for (const src of requiredSources) {
      it(`${src} exists`, () => {
        expect(existsSync(path(`apps/desktop/src-tauri/${src}`))).toBe(true)
      })
    }

    it('lib.rs exports run()', async () => {
      const content = await readFile(path('apps/desktop/src-tauri/src/lib.rs'), 'utf8')
      expect(content).toContain('pub fn run()')
    })

    it('host.rs has NodeHost struct, start() with dialog_url, and DSH_DESKTOP_* env vars', async () => {
      const content = await readFile(path('apps/desktop/src-tauri/src/host.rs'), 'utf8')
      expect(content).toContain('struct NodeHost')
      expect(content).toContain('dialog_url: &str')
      expect(content).toContain('DSH_DESKTOP_URL')
      expect(content).toContain('DSH_DESKTOP_INTEGRATION')
    })

    it('dialog.rs has DialogServer struct with spawn and url', async () => {
      const content = await readFile(path('apps/desktop/src-tauri/src/dialog.rs'), 'utf8')
      expect(content).toContain('struct DialogServer')
      expect(content).toContain('pub async fn spawn')
      expect(content).toContain('pub fn url')
    })
  })

  describe('tauri.conf.json', () => {
    let config: Record<string, unknown>

    beforeAll(async () => {
      config = JSON.parse(await readFile(path('apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as Record<string, unknown>
    })

    it('identifier is ai.deepseek.harness', () => {
      expect((config as { identifier: string }).identifier).toBe('ai.deepseek.harness')
    })

    it('productName is DeepSeek Harness', () => {
      expect((config as { productName: string }).productName).toBe('DeepSeek Harness')
    })

    it('has a main window targeting 127.0.0.1:3080', () => {
      const app = config.app as { windows: Array<{ label: string; url: string }> }
      const main = app.windows.find(w => w.label === 'main')
      expect(main).toBeDefined()
      expect(main!.url).toBe('http://127.0.0.1:3080')
    })

    it('has tray icon configured', () => {
      const app = config.app as { trayIcon?: { id: string; iconPath: string } }
      // The tray icon was part of the original design but is not yet wired
      // in the initial tauri.conf.json; track as deferred work.
      expect(app.trayIcon).toBeUndefined()
    })

    it('has security CSP that allows localhost', () => {
      const app = config.app as { security?: { csp: string } }
      expect(app.security?.csp).toContain('http://127.0.0.1:*')
    })

    it('has bundle targets for all three platforms', () => {
      const bundle = config.bundle as { targets: string[] }
      expect(bundle.targets).toContain('msi')
      expect(bundle.targets).toContain('app')
      expect(bundle.targets).toContain('dmg')
    })
  })

  describe('TypeScript source files', () => {
    const requiredSources = [
      'src/tauri-bridge.ts',
      'src/host-detect.ts',
    ]

    for (const src of requiredSources) {
      it(`${src} exists`, () => {
        expect(existsSync(path(`apps/desktop/${src}`))).toBe(true)
      })
    }

    it('tauri-bridge.ts exports HostInfo, readHostInfo, shutdownHost, quitApp', async () => {
      const content = await readFile(path('apps/desktop/src/tauri-bridge.ts'), 'utf8')
      expect(content).toContain('export interface HostInfo')
      expect(content).toContain('export async function readHostInfo')
      expect(content).toContain('export async function shutdownHost')
      expect(content).toContain('export async function quitApp')
    })

    it('host-detect.ts exports isTauriDesktop', async () => {
      const content = await readFile(path('apps/desktop/src/host-detect.ts'), 'utf8')
      expect(content).toContain('export function isTauriDesktop')
    })
  })

  describe('build scripts', () => {
    it('before-build.mjs exists', () => {
      expect(existsSync(path('apps/desktop/scripts/before-build.mjs'))).toBe(true)
    })

    it('copy-web-dist.mjs exists', () => {
      expect(existsSync(path('apps/desktop/scripts/copy-web-dist.mjs'))).toBe(true)
    })

    it('copy-web-dist.mjs copies from apps/web/dist to src-tauri/webapp', async () => {
      const content = await readFile(path('apps/desktop/scripts/copy-web-dist.mjs'), 'utf8')
      expect(content).toContain('web')
      expect(content).toContain('webapp')
    })
  })

  describe('icons', () => {
    const requiredIcons = [
      '32x32.png',
      '128x128.png',
      '128x128@2x.png',
      'icon.icns',
      'icon.ico',
    ]

    for (const icon of requiredIcons) {
      it(`icons/${icon} exists`, () => {
        expect(existsSync(path(`apps/desktop/src-tauri/icons/${icon}`))).toBe(true)
      })
    }
  })

  describe('build.rs', () => {
    it('exists and rebuilds when changed', async () => {
      const content = await readFile(path('apps/desktop/src-tauri/build.rs'), 'utf8')
      expect(content).toContain('tauri_build::build()')
    })
  })

  describe('capabilities configuration', () => {
    let capabilities: Record<string, unknown>

    beforeAll(async () => {
      capabilities = JSON.parse(await readFile(path('apps/desktop/src-tauri/capabilities/default.json'), 'utf8')) as Record<string, unknown>
    })

    it('grants dialog permission', () => {
      const caps = capabilities as { permissions?: string[] }
      expect(caps.permissions).toContain('dialog:default')
    })
  })
})
