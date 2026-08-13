import { defineConfig } from 'tsdown'

/**
 * Node-only backend. The package ships ESM; the runtime only does
 * fetch-from-loopback so no native worker entry is needed (unlike
 * `directory-picker-native`, which spawns a Win32 dialog worker).
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
