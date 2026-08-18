import { nanoid } from 'nanoid';
import type { DiffResult } from '@vibeset/core';
import type { Db } from '../../src/db/client.js';
import { comparisons, diffResults } from '../../src/db/schema.js';
import type { PhaseTimer } from './phase-timer.js';

/**
 * Replicates the write half of `packages/server/src/trpc/routers/comparisons.ts`'s
 * `createCompareJobHandler` (read in full before writing this) — a
 * `comparisons` row plus one `diffResults` row per component, batched in a
 * single transaction — so the harness's "persist" phase measures the SAME
 * real SQLite write pattern production does, not a synthetic stand-in. The
 * brief explicitly lists "Persist — snapshot store + diff_results writes"
 * as its own phase; `SnapshotStore.put()` is already timed inside
 * `instrumented-comparison.ts`'s `fetchAndCache` loop (phase
 * `persistSnapshots`), this covers the other half (`persistDiffResults`).
 */
export async function persistDiffResults(
  db: Db,
  comparisonId: string,
  label: string,
  results: readonly DiffResult[],
  timer: PhaseTimer,
): Promise<void> {
  const now = new Date().toISOString();
  db.insert(comparisons)
    .values({ id: comparisonId, name: label, status: 'completed', createdAt: now, completedAt: now })
    .run();

  if (results.length === 0) return;

  const rows = results.map((r) => ({
    id: nanoid(),
    comparisonId,
    type: r.key.type,
    fullName: r.key.fullName,
    parentFullName: r.key.parentFullName,
    status: r.status,
    leftSha256: r.leftSha256 ?? null,
    rightSha256: r.rightSha256 ?? null,
    entriesJson: r.entries ? JSON.stringify(r.entries) : null,
    textDiffJson: r.textDiff ? JSON.stringify(r.textDiff) : null,
  }));

  await timer.time('persistDiffResults', () => {
    db.transaction((tx) => {
      for (const row of rows) tx.insert(diffResults).values(row).run();
    });
  });
}
