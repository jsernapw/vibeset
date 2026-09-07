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
  // Explicit belt-and-suspenders alongside package.json `dependencies`
  // (tsdown auto-externalizes anything listed there). These SDKs carry their
  // own transitive version requirements (notably @salesforce/core's zod ^4,
  // vs. VibeSet's zod ^3) — bundling any of them lets a bundler collapse two
  // incompatible majors onto one, which is what broke `vibeset up` when
  // @salesforce/core and @salesforce/source-deploy-retrieve ended up inlined
  // into packages/server's bundle (they were miscategorized as
  // devDependencies there, so the auto-external check missed them). Listing
  // them here too means this package's build stays correct even if the
  // package.json categorization ever drifts.
  external: [
    '@salesforce/core',
    '@salesforce/source-deploy-retrieve',
    '@salesforce/apex-node',
    '@jsforce/jsforce-node',
  ],
});
