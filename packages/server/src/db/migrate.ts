import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.js';

/**
 * Finds `packages/server/drizzle/` (the generated SQL migrations, checked
 * into the repo) starting from this module's own location. Deliberately
 * does NOT use a fixed relative `../../drizzle` offset: tsdown bundles this
 * file into a single `dist/index.js`, so `import.meta.url` at runtime is
 * `dist/index.js` in production but this file's own real path
 * (`src/db/migrate.ts`) when run unbundled (tests, `pnpm dev` via
 * vite-node/tsx) — the correct relative offset to the package root differs
 * between the two. Instead, locate the package root (the directory
 * containing `src`/`dist`) directly, which is stable either way.
 */
function migrationsFolder(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const marker = thisFile.includes(`${sep}dist${sep}`) ? `${sep}dist${sep}` : `${sep}src${sep}`;
  const packageRoot = thisFile.slice(0, thisFile.indexOf(marker));
  return `${packageRoot}${sep}drizzle`;
}

/**
 * Applies all pending SQL migrations from `packages/server/drizzle/` (generated
 * by `pnpm --filter @vibeset/server db:generate`). Safe to call on every boot —
 * drizzle tracks applied migrations in its own bookkeeping table.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}
