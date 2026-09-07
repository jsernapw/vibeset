import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ComponentKey, DependencyEdge, DependencyGraphSource } from '@vibeset/core';
import type { Db } from '../db/client.js';
import { dependencyEdges } from '../db/schema.js';

function sourceForEdge(edge: DependencyEdge): string {
  if (edge.provenance === 'org') return 'tooling-api';
  return `supplemented:${edge.supplementKind}`;
}

function rowToEdge(row: typeof dependencyEdges.$inferSelect): DependencyEdge {
  const supplementKind =
    row.source === 'supplemented:profile-grant' || row.source === 'supplemented:permission-set-grant' || row.source === 'supplemented:layout-field-reference'
      ? (row.source.slice('supplemented:'.length) as NonNullable<DependencyEdge['supplementKind']>)
      : undefined;
  return {
    fromType: row.fromType,
    fromFullName: row.fromFullName,
    toType: row.toType,
    toFullName: row.toFullName,
    provenance: row.authoritative ? 'org' : 'supplemented',
    supplementKind,
    fromNamespace: row.fromNamespace ?? undefined,
    toNamespace: row.toNamespace ?? undefined,
  };
}

/**
 * The durable half of the dependency graph — `@vibeset/core` defines
 * `DependencyGraphSource` (the forward/reverse lookup seam both
 * `transitiveImpact` and `GraphDependencyReferenceChecker` consume) and an
 * in-memory implementation for tests; this is the real, SQLite-backed one,
 * scoped to a single connection (org) since edges from two different orgs
 * are never meaningfully comparable. Mirrors `DrizzleSnapshotStore`'s
 * split: `core` stays framework-free, `server` owns the actual database.
 */
export class DrizzleDependencyGraph implements DependencyGraphSource {
  constructor(
    private readonly db: Db,
    private readonly connectionId: string,
  ) {}

  async forward(key: ComponentKey): Promise<DependencyEdge[]> {
    const rows = this.db
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.connectionId, this.connectionId),
          eq(dependencyEdges.fromType, key.type),
          eq(dependencyEdges.fromFullName, key.fullName),
        ),
      )
      .all();
    return rows.map(rowToEdge);
  }

  async reverse(key: ComponentKey): Promise<DependencyEdge[]> {
    const rows = this.db
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.connectionId, this.connectionId),
          eq(dependencyEdges.toType, key.type),
          eq(dependencyEdges.toFullName, key.fullName),
        ),
      )
      .all();
    return rows.map(rowToEdge);
  }
}

/**
 * Replaces every stored edge for `connectionId` with `edges`, in one
 * transaction — see `schema.ts`'s `dependencyEdges` doc comment for why
 * this is delete-then-insert rather than an upsert: a stale edge (a
 * reference that no longer exists in the org) is exactly as dangerous as a
 * missing one for the delete-safety use case, so a sync must never leave
 * edges behind from a component that has since lost that reference.
 */
// SQLite caps bound-parameter count per statement (default 999/32766
// depending on build); 9 columns/row keeps a 500-row batch comfortably
// under either limit while still cutting statement count by ~500x versus
// one INSERT per row — real orgs can return tens of thousands of edges
// (see the Phase 3 verification report), and this is a one-time sync, not
// a hot path, but doesn't need to be O(n) statements either.
const INSERT_BATCH_SIZE = 500;

export function replaceDependencyEdges(
  db: Db,
  connectionId: string,
  syncRunId: string,
  edges: readonly DependencyEdge[],
): void {
  const now = new Date().toISOString();
  const rows = edges.map((edge) => ({
    id: nanoid(),
    connectionId,
    syncRunId,
    fromType: edge.fromType,
    fromFullName: edge.fromFullName,
    toType: edge.toType,
    toFullName: edge.toFullName,
    source: sourceForEdge(edge),
    authoritative: edge.provenance === 'org',
    fromNamespace: edge.fromNamespace,
    toNamespace: edge.toNamespace,
    createdAt: now,
  }));

  db.transaction((tx) => {
    tx.delete(dependencyEdges).where(eq(dependencyEdges.connectionId, connectionId)).run();
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      tx.insert(dependencyEdges).values(rows.slice(i, i + INSERT_BATCH_SIZE)).run();
    }
  });
}
