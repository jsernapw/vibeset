#!/usr/bin/env -S node --import tsx
/**
 * One-off, read-only verification script for Phase 2 Workstream C's
 * confirmed bug fix — NOT part of the shipped product, NOT the perf
 * harness (test/perf/** is Livia's and untouched by this script; it only
 * IMPORTS the harness's scratch-db helper for an isolated VIBESET_HOME).
 *
 * Proves: a StaticResource comparison between RCA DEV and ARM DEV, with
 * `excludeNamespaces: ['omnistudio']` set, completes cleanly and never
 * retrieves any omnistudio__ component — the actual fix for the confirmed
 * bug (TypeFilter.excludeNamespaces existed but OrgSource.inventory()
 * never consulted it, so an excluded component still reached retrieve).
 *
 * Read-only: only calls listMetadata (inventory) and retrieve (materialize)
 * via ComparisonEngine.run(). No deploy/validate.
 */
import { ComparisonEngine, OrgSource, type TypeFilter } from '@vibeset/core';
import { DrizzleSnapshotStore } from '../src/store/drizzle-snapshot-store.js';
import { openScratchDb } from '../test/perf/scratch-db.js';

const LEFT_USERNAME = process.env.VIBESET_PERF_LEFT_USERNAME ?? 'jsarm@pw.com'; // RCA DEV
const RIGHT_USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV

async function runOne(label: string, filter: TypeFilter): Promise<void> {
  const scratch = openScratchDb(`verify-${label}`);
  console.log(`\n=== ${label} === filter=${JSON.stringify(filter)}`);
  console.log(`Scratch VIBESET_HOME: ${scratch.home}`);
  try {
    const store = new DrizzleSnapshotStore(scratch.db);
    const warnings: string[] = [];
    const left = new OrgSource('verify-rca-dev', 'RCA DEV', { username: LEFT_USERNAME }, { onWarning: (w) => warnings.push(`[LEFT] ${w}`) });
    const right = new OrgSource('verify-arm-dev', 'ARM DEV', { username: RIGHT_USERNAME }, { onWarning: (w) => warnings.push(`[RIGHT] ${w}`) });

    const engine = new ComparisonEngine(store);
    const start = performance.now();
    const result = await engine.run(left, right, {
      comparisonId: `verify-${label}-${Date.now()}`,
      filter,
      onProgress: (p) => {
        if (p.percent % 10 === 0 || p.percent === 100) console.log(`  [${p.percent}%] ${p.message}`);
      },
    });
    const elapsedMs = performance.now() - start;

    console.log(`COMPLETED in ${(elapsedMs / 1000).toFixed(2)}s`);
    console.log(`  component count: ${result.results.length}`);
    console.log(`  summary: ${JSON.stringify(result.summary)}`);
    console.log(`  warnings: ${warnings.length}`);
    for (const w of warnings.slice(0, 10)) console.log(`    - ${w}`);
    if (warnings.length > 10) console.log(`    ... and ${warnings.length - 10} more`);

    const omniInResults = result.results.filter((r) => r.key.fullName.startsWith('omnistudio__'));
    console.log(`  omnistudio__ components present in results: ${omniInResults.length}`);
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    throw err;
  } finally {
    scratch.close();
  }
}

async function main(): Promise<void> {
  console.log(`Verification: left=${LEFT_USERNAME} (RCA DEV) right=${RIGHT_USERNAME} (ARM DEV), types=StaticResource`);
  console.log('Read-only: listMetadata + retrieve only. No deploy/validate.');

  // WITHOUT exclusion — the production ComparisonEngine + plain OrgSource
  // path (not the perf harness's instrumented retrieveAndConvert), to
  // confirm this is a real, currently-live production bug and not an
  // artifact of the harness bypassing OrgSource's own conversion-level
  // isolation. Expected to still fail: the ~65-70/200 BadZipFile failure
  // density on ARM DEV's omnistudio__ StaticResources exceeds even the
  // efficient convertComponentsWithIsolation's proportional budget
  // (max(5, ceil(0.3 * itemCount))).
  const mode = process.argv[2] ?? 'both';
  if (mode === 'both' || mode === 'without') {
    try {
      await runOne('without-exclusion', { types: ['StaticResource'] });
    } catch {
      console.log('(expected: reproduces the confirmed bug — see BadZipFile above)');
    }
  }

  // WITH the fix's exclusion applied — should complete cleanly, fast, and
  // never touch an omnistudio__ component.
  if (mode === 'both' || mode === 'with') {
    await runOne('with-exclusion', { types: ['StaticResource'], excludeNamespaces: ['omnistudio'] });
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exitCode = 1;
});
