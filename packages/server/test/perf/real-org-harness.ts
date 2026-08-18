#!/usr/bin/env -S node --import tsx
/**
 * Cold-vs-warm performance harness against the two real Salesforce orgs
 * registered in this environment (RCA DEV / ARM DEV). Read-only: only calls
 * `listMetadata` (inventory) and `retrieve` (materialize) — no `deploy` /
 * `validate` anywhere in this file or anything it imports.
 *
 * Run with `pnpm --filter @vibeset/server run perf:real-org` (see
 * package.json) or directly: `tsx packages/server/test/perf/real-org-harness.ts`.
 *
 * Env overrides:
 *   VIBESET_PERF_LEFT_USERNAME   default: jsarm@pw.com      (RCA DEV)
 *   VIBESET_PERF_RIGHT_USERNAME  default: jsarm2pw@pw.com   (ARM DEV)
 *   VIBESET_PERF_TYPES           default: ApexClass          (comma-separated)
 *   VIBESET_PERF_OUTPUT_DIR      default: <os tmpdir>/vibeset-perf
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DrizzleSnapshotStore } from '../../src/store/drizzle-snapshot-store.js';
import { createInstrumentedOrgSource, type OrgSourceCounters } from './instrumented-org-source.js';
import { runInstrumentedComparison } from './instrumented-comparison.js';
import { persistDiffResults } from './persist-diff-results.js';
import { openScratchDb, reopenScratchDb } from './scratch-db.js';
import { PhaseTimer } from './phase-timer.js';
import { printRunReport, writeJsonReport, type RunReport } from './report.js';

const LEFT_USERNAME = process.env.VIBESET_PERF_LEFT_USERNAME ?? 'jsarm@pw.com'; // RCA DEV
const RIGHT_USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV
const TYPES = (process.env.VIBESET_PERF_TYPES ?? 'ApexClass').split(',').map((s) => s.trim()).filter(Boolean);
const OUTPUT_DIR = process.env.VIBESET_PERF_OUTPUT_DIR ?? join(tmpdir(), 'vibeset-perf');

async function runOnce(
  label: string,
  db: ReturnType<typeof openScratchDb>['db'] | ReturnType<typeof reopenScratchDb>,
  comparisonId: string,
): Promise<{ report: RunReport; leftCounters: OrgSourceCounters; rightCounters: OrgSourceCounters }> {
  const timer = new PhaseTimer();
  const store = new DrizzleSnapshotStore(db);

  const { source: left, counters: leftCounters } = createInstrumentedOrgSource('perf-rca-dev', 'RCA DEV', { username: LEFT_USERNAME }, timer);
  const { source: right, counters: rightCounters } = createInstrumentedOrgSource('perf-arm-dev', 'ARM DEV', { username: RIGHT_USERNAME }, timer);

  const statsBefore = await store.stats();
  const wallStart = performance.now();

  const { results, summary } = await runInstrumentedComparison(left, right, store, { filter: { types: TYPES }, timer });

  await persistDiffResults(db, comparisonId, label, results, timer);

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
      listMetadataCalls: { left: leftCounters.listMetadataCalls, right: rightCounters.listMetadataCalls },
      listMetadataBatches: { left: leftCounters.listMetadataBatches, right: rightCounters.listMetadataBatches },
      retrieveOperations: { left: leftCounters.retrieveOperations, right: rightCounters.retrieveOperations },
    },
  };
  return { report, leftCounters, rightCounters };
}

async function main(): Promise<void> {
  console.log(`Real-org perf harness: left=${LEFT_USERNAME} (RCA DEV) right=${RIGHT_USERNAME} (ARM DEV) types=${TYPES.join(',')}`);
  console.log('Read-only: listMetadata + retrieve only. No deploy/validate.');

  const scratch = openScratchDb('real-org');
  console.log(`Scratch VIBESET_HOME: ${scratch.home}`);

  try {
    const coldId = `perf-cold-${Date.now()}`;
    const { report: coldReport } = await runOnce('COLD (empty cache)', scratch.db, coldId);
    printRunReport(coldReport);

    // Re-open the SAME on-disk db (do not delete scratch.home) — this is
    // the "warm" half: identical persisted snapshot store, second run.
    const warmDb = reopenScratchDb(scratch.home);
    const warmId = `perf-warm-${Date.now()}`;
    const { report: warmReport } = await runOnce('WARM (populated cache)', warmDb, warmId);
    printRunReport(warmReport);

    const speedup = warmReport.totalWallMs > 0 ? coldReport.totalWallMs / warmReport.totalWallMs : Number.NaN;
    console.log(`\n=== Cold vs warm ===`);
    console.log(`Cold: ${(coldReport.totalWallMs / 1000).toFixed(2)}s, ${coldReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Warm: ${(warmReport.totalWallMs / 1000).toFixed(2)}s, ${warmReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Speedup (cold / warm): ${speedup.toFixed(2)}x`);

    writeJsonReport(join(OUTPUT_DIR, `real-org-${Date.now()}.json`), {
      leftUsername: LEFT_USERNAME,
      rightUsername: RIGHT_USERNAME,
      types: TYPES,
      cold: coldReport,
      warm: warmReport,
      speedup,
    });
  } finally {
    scratch.close();
  }
}

main().catch((err) => {
  console.error('Real-org perf harness failed:', err);
  process.exitCode = 1;
});
