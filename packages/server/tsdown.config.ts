import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/jobs/workers/demo-worker.ts'],
  format: ['esm'],
  dts: true,
  // See @vibeset/core's config: cleaning during `--watch` yanks dist/ out from
  // under downstream packages that are already running against it.
  clean: !process.argv.includes('--watch'),
  platform: 'node',
  // Salesforce SDKs must never be inlined into this bundle. tsdown's
  // auto-external plugin only externalizes modules listed in this package's
  // own `dependencies`/`peerDependencies` (see tsdown's getProductionDeps) —
  // it does not know or care about a package's transitive dependency
  // versions. @salesforce/core declares zod ^4, while every VibeSet package
  // is on zod ^3; if any of these SDKs get bundled, esbuild/rollup collapse
  // both zod majors onto whichever copy the bundle's own deps resolve to
  // (zod 3), and the SDK's zod-4-only schema code (`z.string().meta(...)`)
  // throws at import time. This is exactly what broke `vibeset up` in
  // production while `pnpm verify` (which never boots the built artifact)
  // stayed green — see the boot smoke test in packages/cli/test.
  //
  // @salesforce/core and @salesforce/source-deploy-retrieve are bundled
  // today via merge.ts's direct `RegistryAccess` import; @salesforce/apex-node
  // and @jsforce/jsforce-node aren't imported directly from server src yet,
  // but are listed here too so a future direct import doesn't silently
  // regress into the same bundling trap.
  external: [
    'better-sqlite3',
    'node:sqlite',
    'piscina',
    '@salesforce/core',
    '@salesforce/source-deploy-retrieve',
    '@salesforce/apex-node',
    '@jsforce/jsforce-node',
  ],
});
