import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/jobs/workers/demo-worker.ts'],
  format: ['esm'],
  dts: true,
  // See @vibeset/core's config: cleaning during `--watch` yanks dist/ out from
  // under downstream packages that are already running against it.
  clean: !process.argv.includes('--watch'),
  platform: 'node',
  external: ['better-sqlite3', 'node:sqlite', 'piscina'],
});
