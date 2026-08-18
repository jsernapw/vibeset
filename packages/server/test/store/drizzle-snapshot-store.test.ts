import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@vibeset/core';
import { closeDb, getDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { DrizzleSnapshotStore } from '../../src/store/drizzle-snapshot-store.js';

let tmpHome: string;
let db: Db;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-snapshot-store-test-'));
  process.env.VIBESET_HOME = tmpHome;
  // `getDb()`/`closeDb()` are process-wide singletons; closing after each
  // test (see afterEach) resets them so the next `getDb()` call here opens
  // a fresh database at the new `VIBESET_HOME`, giving each test its own
  // isolated DB rather than sharing state across the file.
  db = getDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

describe('DrizzleSnapshotStore', () => {
  it('misses on an unknown key, against a real migrated SQLite database', async () => {
    const store = new DrizzleSnapshotStore(db);
    const sha = await store.lookup({ sourceId: 'org-1', key: { type: 'ApexClass', fullName: 'Foo' }, lastModifiedDate: '2026-01-01' });
    expect(sha).toBeUndefined();
    expect((await store.stats()).misses).toBe(1);
  });

  it('round-trips put -> lookup -> getBlob through real tables (component_snapshots + component_snapshot_refs)', async () => {
    const store = new DrizzleSnapshotStore(db);
    const key = { type: 'ApexClass', fullName: 'Foo' };
    const content = 'public class Foo {}';

    const snap = await store.put({ sourceId: 'org-1', key, lastModifiedDate: '2026-01-01T00:00:00.000Z', content, orgId: '00Dxx' });
    expect(snap.sha256).toBe(sha256Hex(content));

    const sha = await store.lookup({ sourceId: 'org-1', key, lastModifiedDate: '2026-01-01T00:00:00.000Z' });
    expect(sha).toBe(snap.sha256);

    const blob = await store.getBlob(sha!);
    expect(blob?.content).toBe(content);

    const stats = await store.stats();
    expect(stats.hits).toBe(1);
    expect(stats.blobCount).toBe(1);
    expect(stats.bytesSaved).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('dedupes identical content stored under different sourceIds into one blob row', async () => {
    const store = new DrizzleSnapshotStore(db);
    const key = { type: 'ApexClass', fullName: 'Foo' };
    const content = 'public class Foo {}';

    await store.put({ sourceId: 'org-a', key, lastModifiedDate: 'v1', content });
    await store.put({ sourceId: 'org-b', key, lastModifiedDate: 'v1', content });

    const stats = await store.stats();
    expect(stats.blobCount).toBe(1); // same sha256, one row in component_snapshots
  });

  it('treats a changed lastModifiedDate as a cache miss even for a previously-seen component', async () => {
    const store = new DrizzleSnapshotStore(db);
    const key = { type: 'ApexClass', fullName: 'Foo' };
    await store.put({ sourceId: 'org-1', key, lastModifiedDate: '2026-01-01', content: 'v1' });

    const sha = await store.lookup({ sourceId: 'org-1', key, lastModifiedDate: '2026-06-01' });
    expect(sha).toBeUndefined();
  });

  it('persists across a new DrizzleSnapshotStore instance over the same db (survives process-level reuse)', async () => {
    const key = { type: 'ApexClass', fullName: 'Foo' };
    const first = new DrizzleSnapshotStore(db);
    await first.put({ sourceId: 'org-1', key, lastModifiedDate: '2026-01-01', content: 'v1' });

    const second = new DrizzleSnapshotStore(db);
    const sha = await second.lookup({ sourceId: 'org-1', key, lastModifiedDate: '2026-01-01' });
    expect(sha).toBeDefined();
  });
});
