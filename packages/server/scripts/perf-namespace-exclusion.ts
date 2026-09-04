#!/usr/bin/env -S node --import tsx
/**
 * Measures namespace exclusion's real perf effect against RCA DEV / ARM
 * DEV, using the SAME methodology (`createInstrumentedOrgSource`,
 * `runInstrumentedComparison`, `PhaseTimer`, cold-then-warm on one
 * persisted scratch DB) as Livia's `test/perf/real-org-harness.ts` — this
 * script only IMPORTS that harness's exported pieces, it does not modify
 * `test/perf/**`. Parameterized with `excludeNamespaces`/
 * `excludeManagedPackages` so the "before" and "after" runs are directly
 * comparable to the documented ApexClass baseline (cold ~24s / warm
 * ~1.5s for 408 components).
 *
 * Read-only: listMetadata + retrieve only. No deploy/validate.
 *
 * Usage: VIBESET_PERF_TYPES=ApexClass tsx scripts/perf-namespace-exclusion.ts [--exclude-managed]
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DrizzleSnapshotStore } from '../src/store/drizzle-snapshot-store.js';
import { createInstrumentedOrgSource, type OrgSourceCounters } from '../test/perf/instrumented-org-source.js';
import { runInstrumentedComparison } from '../test/perf/instrumented-comparison.js';
import { persistDiffResults } from '../test/perf/persist-diff-results.js';
import { openScratchDb, reopenScratchDb } from '../test/perf/scratch-db.js';
import { PhaseTimer } from '../test/perf/phase-timer.js';
import { printRunReport, writeJsonReport, type RunReport } from '../test/perf/report.js';
import type { TypeFilter } from '@vibeset/core';

const LEFT_USERNAME = process.env.VIBESET_PERF_LEFT_USERNAME ?? 'jsarm@pw.com'; // RCA DEV
const RIGHT_USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV
const TYPES = (process.env.VIBESET_PERF_TYPES ?? 'ApexClass').split(',').map((s) => s.trim()).filter(Boolean);
const OUTPUT_DIR = process.env.VIBESET_PERF_OUTPUT_DIR ?? join(tmpdir(), 'vibeset-perf');
const EXCLUDE_MANAGED = process.argv.includes('--exclude-managed');

const filter: TypeFilter = EXCLUDE_MANAGED ? { types: TYPES, excludeManagedPackages: true } : { types: TYPES };

async function runOnce(
  label: string,
  db: ReturnType<typeof openScratchDb>['db'] | ReturnType<typeof reopenScratchDb>,
): Promise<{ report: RunReport; leftCounters: OrgSourceCounters; rightCounters: OrgSourceCounters }> {
  const timer = new PhaseTimer();
  const store = new DrizzleSnapshotStore(db);

  const { source: left, counters: leftCounters } = createInstrumentedOrgSource('perf-rca-dev', 'RCA DEV', { username: LEFT_USERNAME }, timer);
  const { source: right, counters: rightCounters } = createInstrumentedOrgSource('perf-arm-dev', 'ARM DEV', { username: RIGHT_USERNAME }, timer);

  const statsBefore = await store.stats();
  const wallStart = performance.now();

  const { results, summary } = await runInstrumentedComparison(left, right, store, { filter, timer });

  await persistDiffResults(db, `perf-ns-${label}-${Date.now()}`, label, results, timer);

  const totalWallMs = performance.now() - wallStart;
  const statsAfter = await store.stats();
  const hits = statsAfter.hits - statsBefore.hits;
  const misses = statsAfter.misses - statsBefore.misses;
  const totalLookups = hits + misses;

  const report: RunReport = {
    label,
    totalWallMs,
    componentCount: results.length,
    summary: summary as unknown as Record<string, number>,
    phases: timer.report(),
    cache: { hits, misses, hitRatePercent: totalLookups > 0 ? Math.round((hits / totalLookups) * 1000) / 10 : 0 },
    extra: {
      types: TYPES,
      filter,
      listMetadataCalls: { left: leftCounters.listMetadataCalls, right: rightCounters.listMetadataCalls },
      retrieveOperations: { left: leftCounters.retrieveOperations, right: rightCounters.retrieveOperations },
    },
  };
  return { report, leftCounters, rightCounters };
}

async function main(): Promise<void> {
  console.log(`Namespace-exclusion perf effect: left=${LEFT_USERNAME} right=${RIGHT_USERNAME} types=${TYPES.join(',')} filter=${JSON.stringify(filter)}`);
  console.log('Read-only: listMetadata + retrieve only. No deploy/validate.');

  const scratch = openScratchDb(`ns-${EXCLUDE_MANAGED ? 'excl' : 'noexcl'}`);
  console.log(`Scratch VIBESET_HOME: ${scratch.home}`);

  try {
    const { report: coldReport } = await runOnce('COLD (empty cache)', scratch.db);
    printRunReport(coldReport);

    const warmDb = reopenScratchDb(scratch.home);
    const { report: warmReport } = await runOnce('WARM (populated cache)', warmDb);
    printRunReport(warmReport);

    const speedup = warmReport.totalWallMs > 0 ? coldReport.totalWallMs / warmReport.totalWallMs : Number.NaN;
    console.log(`\n=== Cold vs warm (${EXCLUDE_MANAGED ? 'excludeManagedPackages=true' : 'no exclusion'}) ===`);
    console.log(`Cold: ${(coldReport.totalWallMs / 1000).toFixed(2)}s, ${coldReport.componentCount} components, ${coldReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Warm: ${(warmReport.totalWallMs / 1000).toFixed(2)}s, ${warmReport.componentCount} components, ${warmReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Speedup (cold / warm): ${speedup.toFixed(2)}x`);

    writeJsonReport(join(OUTPUT_DIR, `ns-exclusion-${EXCLUDE_MANAGED ? 'excl' : 'noexcl'}-${Date.now()}.json`), {
      leftUsername: LEFT_USERNAME,
      rightUsername: RIGHT_USERNAME,
      types: TYPES,
      filter,
      cold: coldReport,
      warm: warmReport,
      speedup,
    });
  } finally {
    scratch.close();
  }
}

main().catch((err) => {
  console.error('Namespace-exclusion perf script failed:', err);
  process.exitCode = 1;
});
