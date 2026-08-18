import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/types/index.ts'],
  format: ['esm'],
  dts: true,
  // Never clean in watch mode: `turbo run dev` starts @vibeset/server and
  // @vibeset/cli against this package's dist/, and wiping it on every rebuild
  // makes them crash with ERR_MODULE_NOT_FOUND on @vibeset/core/dist/index.js.
  // Full (non-watch) builds still clean, so stale output can't accumulate.
  clean: !process.argv.includes('--watch'),
  platform: 'node',
});
