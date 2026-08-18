#!/usr/bin/env -S node --import tsx
/**
 * Synthetic-corpus performance harness — the only way to exercise the
 * plan's 50,000-component target in this environment, since the real orgs
 * registered here (RCA DEV, ARM DEV) only have hundreds of components.
 * Generates two local SFDX projects (`SfdxProjectSource`, network-free) and
 * runs the same instrumented comparison as the real-org harness, cold then
 * warm, against a synthetic ~2% changed / ~1% deleted / ~1% added mix.
 *
 * This isolates CPU/disk-bound work (inventory tree-walk, canonicalize/hash,
 * diff, SQLite persist) from network latency — exactly the split the
 * optimizer needs, per the brief.
 *
 * Run with `pnpm --filter @vibeset/server run perf:synthetic` or directly:
 * `tsx packages/server/test/perf/synthetic-harness.ts`.
 *
 * Env overrides:
 *   VIBESET_PERF_SYNTHETIC_COUNT  default: 50000
 *   VIBESET_PERF_OUTPUT_DIR       default: <os tmpdir>/vibeset-perf
 *   VIBESET_PERF_CORPUS_DIR       default: <os tmpdir>/vibeset-perf-corpus
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { SfdxProjectSource } from '@vibeset/core';
import { DrizzleSnapshotStore } from '../../src/store/drizzle-snapshot-store.js';
import { runInstrumentedComparison } from './instrumented-comparison.js';
import { persistDiffResults } from './persist-diff-results.js';
import { openScratchDb, reopenScratchDb } from './scratch-db.js';
import { PhaseTimer } from './phase-timer.js';
import { printRunReport, writeJsonReport, type RunReport } from './report.js';
import { everyNth, generateSyntheticApexProject } from './synthetic-corpus.js';

const COUNT = Number(process.env.VIBESET_PERF_SYNTHETIC_COUNT ?? 50_000);
const OUTPUT_DIR = process.env.VIBESET_PERF_OUTPUT_DIR ?? join(tmpdir(), 'vibeset-perf');
const CORPUS_DIR = process.env.VIBESET_PERF_CORPUS_DIR ?? join(tmpdir(), 'vibeset-perf-corpus');

async function runOnce(
  label: string,
  db: ReturnType<typeof openScratchDb>['db'] | ReturnType<typeof reopenScratchDb>,
  comparisonId: string,
  leftDir: string,
  rightDir: string,
): Promise<RunReport> {
  const timer = new PhaseTimer();
  const store = new DrizzleSnapshotStore(db);

  const left = new SfdxProjectSource('perf-synthetic-left', 'Synthetic Left', leftDir);
  const right = new SfdxProjectSource('perf-synthetic-right', 'Synthetic Right', rightDir);

  const statsBefore = await store.stats();
  const wallStart = performance.now();

  const { results, summary } = await runInstrumentedComparison(left, right, store, {
    filter: { types: ['ApexClass'] },
    timer,
  });

  await persistDiffResults(db, comparisonId, label, results, timer);

  const totalWallMs = performance.now() - wallStart;
  const statsAfter = await store.stats();
  const hits = statsAfter.hits - statsBefore.hits;
  const misses = statsAfter.misses - statsBefore.misses;
  const totalLookups = hits + misses;

  return {
    label,
    totalWallMs,
    componentCount: results.length,
    summary: summary as unknown as Record<string, number>,
    phases: timer.report(),
    cache: { hits, misses, hitRatePercent: totalLookups > 0 ? Math.round((hits / totalLookups) * 1000) / 10 : 0 },
  };
}

async function main(): Promise<void> {
  console.log(`Synthetic perf harness: ${COUNT} ApexClass components per side.`);

  const leftDir = join(CORPUS_DIR, 'left');
  const rightDir = join(CORPUS_DIR, 'right');

  const changed = everyNth(COUNT, 50); // ~2% changed
  const removed = everyNth(COUNT, 100); // ~1% deleted on the right
  const extra = Math.round(COUNT * 0.01); // ~1% new on the right

  console.log('Generating synthetic corpus (left: baseline, right: ~2% changed / ~1% deleted / ~1% added)...');
  const genLeft = await generateSyntheticApexProject(leftDir, { count: COUNT });
  const genRight = await generateSyntheticApexProject(rightDir, {
    count: COUNT,
    changedIndices: changed,
    skipIndices: removed,
    extraCount: extra,
  });
  console.log(
    `Corpus generated: left=${genLeft.written} files in ${(genLeft.generateMs / 1000).toFixed(1)}s, ` +
      `right=${genRight.written} files in ${(genRight.generateMs / 1000).toFixed(1)}s ` +
      `(corpus generation time is NOT included in any phase timing below).`,
  );

  const scratch = openScratchDb('synthetic');
  console.log(`Scratch VIBESET_HOME: ${scratch.home}`);

  try {
    const coldReport = await runOnce('COLD (empty cache)', scratch.db, `perf-synthetic-cold-${Date.now()}`, leftDir, rightDir);
    printRunReport(coldReport);

    const warmDb = reopenScratchDb(scratch.home);
    const warmReport = await runOnce('WARM (populated cache)', warmDb, `perf-synthetic-warm-${Date.now()}`, leftDir, rightDir);
    printRunReport(warmReport);

    const speedup = warmReport.totalWallMs > 0 ? coldReport.totalWallMs / warmReport.totalWallMs : Number.NaN;
    console.log(`\n=== Cold vs warm (${COUNT} components/side) ===`);
    console.log(`Cold: ${(coldReport.totalWallMs / 1000).toFixed(2)}s, ${coldReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Warm: ${(warmReport.totalWallMs / 1000).toFixed(2)}s, ${warmReport.cache?.hitRatePercent}% cache hit rate`);
    console.log(`Speedup (cold / warm): ${speedup.toFixed(2)}x`);
    const target = 3 * 60 * 1000;
    const verdict =
      COUNT < 50_000
        ? 'not at target scale (50,000) — see JSON report for extrapolation only, not a substitute for the full-scale run'
        : warmReport.totalWallMs <= target
          ? 'MEETS the 3-minute warm target, as measured'
          : 'MISSES the 3-minute warm target, as measured';
    console.log(`Target: 50,000 components under 3 minutes WARM. This run: ${COUNT} components, warm = ${(warmReport.totalWallMs / 1000).toFixed(1)}s (${verdict}).`);

    writeJsonReport(join(OUTPUT_DIR, `synthetic-${Date.now()}.json`), {
      componentCountPerSide: COUNT,
      cold: coldReport,
      warm: warmReport,
      speedup,
    });
  } finally {
    scratch.close();
    if (!process.env.VIBESET_PERF_KEEP_CORPUS) {
      await rm(CORPUS_DIR, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('Synthetic perf harness failed:', err);
  process.exitCode = 1;
});
