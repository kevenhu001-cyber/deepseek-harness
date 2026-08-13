/**
 * Composite pre-build step for the desktop shell.
 *
 * Runs everything the Tauri bundler expects to find before it walks the
 * `frontendDist` directory:
 *
 * 1. Regenerate the Tauri placeholder icons if any are missing. The
 *    `scripts/gen-tauri-placeholder-icons.mjs` script lives at the workspace
 *    root so it is shared by both `apps/desktop` and any future mobile shell.
 * 2. Build the webapp bundle through the existing pnpm workspace filter.
 *    The webapp owns its Vite config; the desktop shell never imports its
 *    source directly.
 * 3. Copy the webapp dist into the Tauri `frontendDist` directory via
 *    `copy-web-dist.mjs`.
 *
 * The script is invoked by `apps/desktop/package.json::before:build` and
 * therefore runs ahead of `cargo tauri build`. Exits non-zero on any
 * sub-step failure so the bundler halts instead of shipping a half-built
 * installer.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const workspaceRoot = resolve(desktopRoot, '..', '..');

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: workspaceRoot,
    // Use the shell so pnpm is found via PATH (spawnSync without shell
    // resolves the bare command name against the child environment, which
    // may lack the parent's PATH augmentation from shell init scripts).
    shell: true,
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[before-build] ${label} failed (exit ${result.status ?? 'unknown'})`);
    process.exit(result.status ?? 1);
  }
}

// 1. Ensure placeholder icons exist.
const iconsDir = resolve(desktopRoot, 'src-tauri', 'icons');
const expectedIcons = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.icns'];
const missing = expectedIcons.filter((name) => !existsSync(resolve(iconsDir, name)));

if (missing.length > 0) {
  console.log(`[before-build] regenerating ${missing.length} placeholder icon(s)`);
  run(
    'icon generation',
    'node',
    [resolve(workspaceRoot, 'scripts', 'gen-tauri-placeholder-icons.mjs')],
  );
}

// 2. Build the webapp.
run('webapp build', 'pnpm', [
  '--filter',
  '@deepseek-ai/dsh-web-frontend',
  'run',
  'build',
]);

// 3. Copy the dist into the Tauri frontendDist directory.
run('webapp dist copy', 'node', [
  resolve(desktopRoot, 'scripts', 'copy-web-dist.mjs'),
].map(p => /\s/.test(p) ? JSON.stringify(p) : p));

console.log('[before-build] done');
