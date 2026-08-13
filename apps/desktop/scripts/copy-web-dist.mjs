/**
 * Copy the built webapp dist into the desktop shell's `frontendDist` directory.
 *
 * Tauri reads `tauri.conf.json::build.frontendDist` to know which static
 * assets to ship with the installer; the desktop shell points at
 * `apps/desktop/webapp/`. The webapp's own `vite build` output stays in its
 * workspace (`apps/web/dist/`); we copy it here at Tauri build time so the
 * two build paths stay decoupled — `pnpm --filter
 * @deepseek-ai/dsh-web-frontend run build` remains the single source of
 * truth for the webapp bundle.
 *
 * The destination is wiped before each copy so a partial previous run never
 * leaves stale chunks behind (which would otherwise mask a freshly fixed
 * build issue).
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const workspaceRoot = resolve(desktopRoot, '..', '..');
const source = resolve(workspaceRoot, 'apps', 'web', 'dist');
const destination = resolve(desktopRoot, 'webapp');

if (!existsSync(source)) {
  console.error(`[copy-web-dist] missing webapp dist: ${source}`);
  console.error('Run `pnpm --filter @deepseek-ai/dsh-web-frontend run build` first.');
  process.exit(1);
}

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}

cpSync(source, destination, { recursive: true });
console.log(`[copy-web-dist] copied ${source} -> ${destination}`);
