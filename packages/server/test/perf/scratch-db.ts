import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Opens an isolated, freshly migrated VibeSet SQLite database under a
 * throwaway `VIBESET_HOME`, exactly like `test/store/drizzle-snapshot-store.test.ts`
 * does — never the user's real `~/.vibeset/vibeset.db`. Used for the "cold
 * cache" half of the cold-vs-warm comparison: an empty, real (not
 * in-memory) database with real migrations applied, so `DrizzleSnapshotStore`
 * behaves exactly as it does in production, including actual SQLite I/O.
 */
export interface ScratchDb {
  readonly db: Db;
  readonly home: string;
  close(): void;
}

export function openScratchDb(label: string): ScratchDb {
  const home = mkdtempSync(join(tmpdir(), `vibeset-perf-${label}-`));
  process.env.VIBESET_HOME = home;
  const db = getDb();
  runMigrations(db);
  return {
    db,
    home,
    close: () => {
      closeDb();
      rmSync(home, { recursive: true, force: true });
      delete process.env.VIBESET_HOME;
    },
  };
}

/** Re-opens the SAME on-disk database (same `home`) as a fresh `Db` handle — used to go from "cold" to "warm" against identical persisted state without wiping it. */
export function reopenScratchDb(home: string): Db {
  process.env.VIBESET_HOME = home;
  closeDb();
  const db = getDb();
  return db;
}
