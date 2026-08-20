import { and, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ComponentSnapshot, SnapshotLookupKey, SnapshotPutParams, SnapshotStore, SnapshotStoreStats } from '@vibeset/core';
import { componentKeyString, sha256Hex } from '@vibeset/core';
import type { Db } from '../db/client.js';
import { componentSnapshotRefs, componentSnapshots } from '../db/schema.js';

/**
 * The durable half of the content-addressed retrieval cache. `@vibeset/core`
 * defines the `SnapshotStore` interface (and an in-memory implementation
 * for tests) but must never depend on Drizzle/SQLite directly — this class
 * is the real implementation, injected into `core`'s `RetrievalPlanner`
 * from the server's composition root. Blobs live in `component_snapshots`,
 * keyed by `sha256`; lookups go through `component_snapshot_refs`, indexed
 * on exactly the cache key the plan specifies:
 * `(sourceId, type, fullName, lastModifiedDate)`.
 */
export class DrizzleSnapshotStore implements SnapshotStore {
  private hits = 0;
  private misses = 0;
  private bytesSaved = 0;

  constructor(private readonly db: Db) {}

  async lookup(params: SnapshotLookupKey): Promise<string | undefined> {
    const row = this.db
      .select({ sha256: componentSnapshotRefs.sha256 })
      .from(componentSnapshotRefs)
      .where(
        and(
          eq(componentSnapshotRefs.sourceId, params.sourceId),
          eq(componentSnapshotRefs.type, params.key.type),
          eq(componentSnapshotRefs.fullName, params.key.fullName),
          eq(componentSnapshotRefs.lastModifiedDate, params.lastModifiedDate),
        ),
      )
      .orderBy(sql`${componentSnapshotRefs.capturedAt} desc`)
      .limit(1)
      .get();

    if (!row) {
      this.misses += 1;
      return undefined;
    }

    this.hits += 1;
    const blob = this.db
      .select({ size: componentSnapshots.size })
      .from(componentSnapshots)
      .where(eq(componentSnapshots.sha256, row.sha256))
      .get();
    if (blob) this.bytesSaved += blob.size;
    return row.sha256;
  }

  /**
   * Batched `lookup()`: one `SELECT ... WHERE sourceId = ? AND type = ? AND
   * fullName IN (...)` per distinct `type` in the batch, instead of one
   * query per component. `component_snapshot_refs_lookup_idx` already
   * covers `(sourceId, type, fullName, lastModifiedDate)`, so each of these
   * grouped queries is still index-backed — this only cuts the NUMBER of
   * round trips (and, more importantly, the number of separate statement
   * dispatches through better-sqlite3's synchronous API), not the index
   * usage.
   *
   * `lastModifiedDate` is matched in JS rather than pushed into the SQL
   * `WHERE` (which would require one `OR` clause per requested
   * `(fullName, lastModifiedDate)` pair — no simpler than one query per
   * component). When more than one ref row matches the same
   * `(fullName, lastModifiedDate)` — possible if the same component was
   * captured more than once at that exact date — the most recently
   * `capturedAt` one wins, matching `lookup()`'s `orderBy(capturedAt
   * desc).limit(1)` tie-break exactly.
   */
  async lookupMany(params: readonly SnapshotLookupKey[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    if (params.length === 0) return result;

    const bySourceAndType = new Map<string, SnapshotLookupKey[]>();
    for (const p of params) {
      const groupKey = `${p.sourceId}\u0000${p.key.type}`;
      const list = bySourceAndType.get(groupKey);
      if (list) list.push(p);
      else bySourceAndType.set(groupKey, [p]);
    }

    const hitShas: string[] = [];

    for (const group of bySourceAndType.values()) {
      const { sourceId, key } = group[0]!;
      const type = key.type;
      const fullNames = [...new Set(group.map((p) => p.key.fullName))];

      const rows = this.db
        .select({
          fullName: componentSnapshotRefs.fullName,
          lastModifiedDate: componentSnapshotRefs.lastModifiedDate,
          sha256: componentSnapshotRefs.sha256,
          capturedAt: componentSnapshotRefs.capturedAt,
        })
        .from(componentSnapshotRefs)
        .where(
          and(
            eq(componentSnapshotRefs.sourceId, sourceId),
            eq(componentSnapshotRefs.type, type),
            inArray(componentSnapshotRefs.fullName, fullNames),
          ),
        )
        .all();

      // Most-recent-wins per (fullName, lastModifiedDate), same tie-break as lookup().
      const best = new Map<string, { sha256: string; capturedAt: string }>();
      for (const r of rows) {
        const rowKey = `${r.fullName}\u0000${r.lastModifiedDate}`;
        const existing = best.get(rowKey);
        if (!existing || r.capturedAt > existing.capturedAt) {
          best.set(rowKey, { sha256: r.sha256, capturedAt: r.capturedAt });
        }
      }

      for (const p of group) {
        const match = best.get(`${p.key.fullName}\u0000${p.lastModifiedDate}`);
        if (match) {
          result.set(componentKeyString(p.key), match.sha256);
          hitShas.push(match.sha256);
        }
      }
    }

    this.hits += result.size;
    this.misses += params.length - result.size;

    if (hitShas.length > 0) {
      const distinctShas = [...new Set(hitShas)];
      const sizeRows = this.db
        .select({ sha256: componentSnapshots.sha256, size: componentSnapshots.size })
        .from(componentSnapshots)
        .where(inArray(componentSnapshots.sha256, distinctShas))
        .all();
      const sizeBySha = new Map(sizeRows.map((r) => [r.sha256, r.size] as const));
      for (const sha256 of hitShas) this.bytesSaved += sizeBySha.get(sha256) ?? 0;
    }

    return result;
  }

  async put(params: SnapshotPutParams): Promise<ComponentSnapshot> {
    const [result] = await this.putMany([params]);
    return result!;
  }

  /**
   * Batched `put()`: wraps the whole batch's inserts in ONE SQLite
   * transaction instead of each `put()` call committing (and fsync-ing its
   * journal) independently. This is the fix for the measured ~5x-per-row
   * cost gap against `persistDiffResults`'s already-batched write — that
   * code already wraps its inserts in a single `db.transaction()`; `put()`
   * never did. Semantics are otherwise identical to N sequential `put()`
   * calls, including per-row content-addressed dedup
   * (`onConflictDoNothing` on `component_snapshots.sha256`).
   */
  async putMany(params: readonly SnapshotPutParams[]): Promise<ComponentSnapshot[]> {
    if (params.length === 0) return [];

    const now = new Date().toISOString();
    const prepared = params.map((p) => ({
      params: p,
      sha256: sha256Hex(p.content),
      size: Buffer.byteLength(p.content, 'utf8'),
    }));

    this.db.transaction((tx) => {
      for (const { params: p, sha256, size } of prepared) {
        tx.insert(componentSnapshots)
          .values({
            sha256,
            type: p.key.type,
            fullName: p.key.fullName,
            parentFullName: p.key.parentFullName,
            content: p.content,
            size,
            firstSeenAt: now,
          })
          .onConflictDoNothing({ target: componentSnapshots.sha256 })
          .run();

        tx.insert(componentSnapshotRefs)
          .values({
            id: nanoid(),
            sourceId: p.sourceId,
            orgId: p.orgId,
            type: p.key.type,
            fullName: p.key.fullName,
            parentFullName: p.key.parentFullName,
            lastModifiedDate: p.lastModifiedDate,
            sha256,
            capturedAt: now,
          })
          .run();
      }
    });

    return prepared.map(({ params: p, sha256, size }) => ({ sha256, key: p.key, content: p.content, size, firstSeenAt: now }));
  }

  async getBlob(sha256: string): Promise<ComponentSnapshot | undefined> {
    const row = this.db.select().from(componentSnapshots).where(eq(componentSnapshots.sha256, sha256)).get();
    if (!row) return undefined;
    return {
      sha256: row.sha256,
      key: { type: row.type, fullName: row.fullName, parentFullName: row.parentFullName ?? undefined },
      content: row.content,
      size: row.size,
      firstSeenAt: row.firstSeenAt,
    };
  }

  async stats(): Promise<SnapshotStoreStats> {
    const agg = this.db
      .select({ blobCount: sql<number>`count(*)`, totalBytes: sql<number>`coalesce(sum(${componentSnapshots.size}), 0)` })
      .from(componentSnapshots)
      .get();
    return {
      hits: this.hits,
      misses: this.misses,
      bytesSaved: this.bytesSaved,
      blobCount: agg?.blobCount ?? 0,
      totalBytes: agg?.totalBytes ?? 0,
    };
  }
}
