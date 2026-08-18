import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ComponentSnapshot, SnapshotLookupKey, SnapshotPutParams, SnapshotStore, SnapshotStoreStats } from '@vibeset/core';
import { sha256Hex } from '@vibeset/core';
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

  async put(params: SnapshotPutParams): Promise<ComponentSnapshot> {
    const sha256 = sha256Hex(params.content);
    const size = Buffer.byteLength(params.content, 'utf8');
    const now = new Date().toISOString();

    this.db
      .insert(componentSnapshots)
      .values({
        sha256,
        type: params.key.type,
        fullName: params.key.fullName,
        parentFullName: params.key.parentFullName,
        content: params.content,
        size,
        firstSeenAt: now,
      })
      .onConflictDoNothing({ target: componentSnapshots.sha256 })
      .run();

    this.db
      .insert(componentSnapshotRefs)
      .values({
        id: nanoid(),
        sourceId: params.sourceId,
        orgId: params.orgId,
        type: params.key.type,
        fullName: params.key.fullName,
        parentFullName: params.key.parentFullName,
        lastModifiedDate: params.lastModifiedDate,
        sha256,
        capturedAt: now,
      })
      .run();

    return { sha256, key: params.key, content: params.content, size, firstSeenAt: now };
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
