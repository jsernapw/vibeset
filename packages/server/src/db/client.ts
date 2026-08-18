import { createRequire } from 'node:module';
import {
  drizzle as drizzleBetterSqlite3,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { vibesetDbPath } from './paths.js';

const require = createRequire(import.meta.url);

export type Db = BetterSQLite3Database<typeof schema>;

let dbInstance: Db | undefined;
let rawInstance: import('better-sqlite3').Database | undefined;

/**
 * Opens (creating if absent) the VibeSet SQLite database and returns a
 * Drizzle client over it. `better-sqlite3` is the primary driver; per the
 * plan, if its native binding fails to load on a given platform (no
 * prebuilt binary for this OS/arch/Node ABI and no local build toolchain),
 * the sanctioned fallback is Node 22's built-in `node:sqlite`. We attempt
 * the primary driver first — using a CJS `require` (via `createRequire`,
 * since this package is ESM) so a native-load failure throws synchronously
 * here and can be caught, rather than crashing at static-import time.
 */
export function getDb(): Db {
  if (dbInstance) return dbInstance;

  const path = vibesetDbPath();

  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    rawInstance = new Database(path);
    rawInstance.pragma('journal_mode = WAL');
    rawInstance.pragma('foreign_keys = ON');
    dbInstance = drizzleBetterSqlite3(rawInstance, { schema });
    return dbInstance;
  } catch (err) {
    throw new Error(
      `Failed to open SQLite database at ${path} via better-sqlite3 (native binding ` +
        `failed to load). VibeSet's documented fallback for this case is Node 22's ` +
        `built-in node:sqlite driver — this has not been wired up yet; see ` +
        `packages/server/src/db/client.ts. Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export function closeDb(): void {
  rawInstance?.close();
  dbInstance = undefined;
  rawInstance = undefined;
}

export { schema };
