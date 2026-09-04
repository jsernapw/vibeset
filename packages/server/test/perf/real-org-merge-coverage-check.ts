#!/usr/bin/env -S node --import tsx
/**
 * Real-org proof that the merge route (trpc/routers/merge.ts) passes
 * ACCURATE retrieve-pairing coverage into mergeComponent for a
 * Profile/PermissionSet -- not assumed, not guessed -- and that an
 * unretrieved permission is never mistaken for a real deletion.
 *
 * This exercises the full stack end to end: an in-process server
 * (startServer), real "org" connections against RCA DEV and ARM DEV
 * (the local sf CLI auth store via @salesforce/core -- no credentials
 * handled by this script), a real comparisons.start job, and a real
 * merge.resolve tRPC call. Read-only throughout: only ever calls
 * listMetadata/retrieve (via ComparisonEngine). Never deploy.deploy or
 * deploy.validate.
 *
 * Each run below happens in its OWN child process (spawned via --mode),
 * each with its own scratch VIBESET_HOME -- deliberately, not just two
 * calls in this same process: db/client.ts's getDb() and the
 * SnapshotStore it backs are per-process module singletons, so sharing a
 * process between the "narrow" and "wide" runs below would let the second
 * run's retrieval see the first run's cached blobs and silently take the
 * cache-hit (empty-coverage) branch regardless of that run's own filter --
 * exactly the ambiguity this script exists to keep OUT of the comparison.
 *
 * THE PROOF, IN TWO RUNS:
 *
 *  Run NARROW: compare RCA DEV vs ARM DEV with filter types=[Profile]
 *  only -- no PROFILE_PAIRED_TYPES component retrieved alongside it, so
 *  every Profile's stored coverage should be scoped with an EMPTY
 *  retrievedComponents set on a fresh store. Any classAccesses/
 *  fieldPermissions/... entry present on one side and absent on the other
 *  is therefore AMBIGUOUS, not a confirmed deletion -- and merge.resolve
 *  must report those as status "unchanged", never "take-left"/
 *  "take-right" (which would mean "deploy this as a removal").
 *
 *  Run WIDE: the same two orgs, a FRESH scratch store, filter
 *  types=[Profile, ApexClass] -- Profile is now co-retrieved with
 *  ApexClass, so coverage includes real ApexClass refs. A classAccesses
 *  entry whose apexClass IS one of those covered refs, and is present on
 *  one side/absent on the other, is a CONFIRMED difference -- merge.resolve
 *  should report take-left/take-right for it, exactly the entries the
 *  narrow run had to suppress as ambiguous.
 *
 * Env overrides:
 *   VIBESET_PERF_LEFT_USERNAME   default: jsarm@pw.com      (RCA DEV)
 *   VIBESET_PERF_RIGHT_USERNAME  default: jsarm2pw@pw.com   (ARM DEV)
 *   VIBESET_MERGE_PROFILE        default: Admin
 */
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Static, not dynamic: `startServer` reads `VIBESET_HOME` lazily (via
// `getDb()`) only once actually called, well after `runOnce` below sets it
// per-process -- so a static top-level import is just as correctly scoped
// as a dynamic one here, without tripping a tsx lexer quirk where a
// shebang line preceding a dynamic `import(...)` mis-scans offsets and
// throws a bogus parse error.
import { startServer } from '../../src/server.js';
import { getDb } from '../../src/db/client.js';
import { comparisons } from '../../src/db/schema.js';
import { componentKeyString } from '@vibeset/core';

const LEFT_USERNAME = process.env.VIBESET_PERF_LEFT_USERNAME ?? 'jsarm@pw.com'; // RCA DEV
const RIGHT_USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV
const PROFILE_NAME = process.env.VIBESET_MERGE_PROFILE ?? 'Admin';

const THIS_FILE = fileURLToPath(import.meta.url);
const RESULT_MARKER = '@@VIBESET_MERGE_COVERAGE_RESULT@@';

interface RunResult {
  readonly label: string;
  readonly comparisonId: string;
  readonly diffStatus: string;
  readonly merged: any;
  /** Real ApexClass fullNames seen in this run's `comparisons.results` (either side). Used to cross-check the recorded coverage against what was actually retrieved. */
  readonly apexClassNames: string[];
  /**
   * The `{ left, right }` `SideCoverage` this comparison recorded for the
   * Profile under test, read directly from `comparisons.profileCoverageJson`
   * -- i.e. exactly what `merge.resolve` itself would read via
   * `requireMergeProfileCoverage`, inspected here instead of just trusted,
   * per the task's "show the coverage you passed is accurate rather than
   * assumed" bar. `retrievedComponents` is serialized as an array (a `Set`
   * doesn't survive `JSON.stringify` as one).
   */
  readonly recordedCoverage: unknown;
}

/** The single-run worker: runs inside its own child process (see the module doc comment for why). Prints its JSON result on a marked line and exits. */
async function runOnce(label: string, types: string[]): Promise<void> {
  const tmpHome = mkdtempSync(join(tmpdir(), `vibeset-merge-coverage-${label}-`));
  process.env.VIBESET_HOME = tmpHome;

  const started = await startServer({ port: 0 });

  const authHeaders = { 'x-vibeset-token': started.token, origin: `http://127.0.0.1:${started.port}` };
  const trpcQuery = async (path: string, input: unknown) => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: authHeaders });
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body));
    return body.result.data;
  };
  const trpcMutate = async (path: string, input: unknown) => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body));
    return body.result.data;
  };
  const waitForJob = async (jobId: string) => {
    let job: any;
    for (let i = 0; i < 2400; i += 1) {
      job = await trpcQuery('jobs.get', { jobId });
      if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled')) return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Job ${jobId} did not reach a terminal state in time (last status: ${job?.status})`);
  };

  try {
    console.error(`[${label}] filter={types:[${types.join(', ')}]} — starting comparison against ${LEFT_USERNAME} (RCA DEV) / ${RIGHT_USERNAME} (ARM DEV)...`);
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'org', label: 'RCA DEV', username: LEFT_USERNAME });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'org', label: 'ARM DEV', username: RIGHT_USERNAME });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types, excludeManagedPackages: false },
    });
    console.error(`[${label}] comparisonId=${comparisonId} jobId=${jobId} — running (this can take a while on real orgs)...`);
    const job = await waitForJob(jobId);
    if (job.status !== 'succeeded') throw new Error(`[${label}] job did not succeed: ${JSON.stringify(job)}`);

    const results = await trpcQuery('comparisons.results', { comparisonId });
    const profileRow = results.find((r: any) => r.type === 'Profile' && r.fullName === PROFILE_NAME);
    if (!profileRow) {
      throw new Error(
        `[${label}] no Profile "${PROFILE_NAME}" in results — set VIBESET_MERGE_PROFILE to one that exists in both orgs. Profiles seen: ${results
          .filter((r: any) => r.type === 'Profile')
          .map((r: any) => r.fullName)
          .join(', ')}`,
      );
    }
    console.error(`[${label}] Profile "${PROFILE_NAME}" diff status: ${profileRow.status}`);

    const apexClassNames: string[] = results.filter((r: any) => r.type === 'ApexClass').map((r: any) => r.fullName);

    // Read the RAW stored coverage directly off the same DB `merge.resolve`
    // itself reads (via `getDb()`'s process-local singleton -- see
    // db/client.ts) -- inspected here, not just trusted, per the task's
    // "show the coverage you passed is accurate rather than assumed" bar.
    // This is the on-disk JSON shape from `shared/profile-coverage-json.ts`'s
    // `serializeProfileCoverage` (arrays, not Sets -- see that file for why).
    const db = getDb();
    const comparisonRow = db.select().from(comparisons).where(eq(comparisons.id, comparisonId)).get();
    const rawCoverage = comparisonRow?.profileCoverageJson ? JSON.parse(comparisonRow.profileCoverageJson) : undefined;
    const recordedCoverage = rawCoverage?.[componentKeyString({ type: 'Profile', fullName: PROFILE_NAME })];

    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: PROFILE_NAME });
    const result: RunResult = { label, comparisonId, diffStatus: profileRow.status, merged, apexClassNames, recordedCoverage };
    console.log(`${RESULT_MARKER}${JSON.stringify(result)}`);
  } finally {
    await started.close();
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function oneSidedEntries(merged: any): any[] {
  return merged.entries.filter((e: any) => {
    if (!e.path.includes('.')) return false; // skip top-level scalars (description, ...)
    const leftDefined = e.left !== undefined;
    const rightDefined = e.right !== undefined;
    return leftDefined !== rightDefined; // exactly one side has this permission entry
  });
}

function spawnRun(mode: 'narrow' | 'wide'): RunResult {
  const res = spawnSync(process.execPath, ['--import', 'tsx', THIS_FILE, `--mode=${mode}`], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`[${mode}] child process exited with status ${res.status}`);
  }
  const line = res.stdout.split('\n').find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`[${mode}] child process produced no result line (stdout: ${res.stdout.slice(-2000)})`);
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

async function main() {
  const modeArg = process.argv.find((a) => a.startsWith('--mode='));
  if (modeArg) {
    const mode = modeArg.slice('--mode='.length);
    if (mode === 'narrow') return runOnce('narrow', ['Profile']);
    if (mode === 'wide') return runOnce('wide', ['Profile', 'ApexClass']);
    throw new Error(`Unknown --mode=${mode}`);
  }

  console.log('Spawning narrow run (filter: Profile only) in its own process...');
  const narrow = spawnRun('narrow');
  console.log('Spawning wide run (filter: Profile + ApexClass) in its own process...');
  const wide = spawnRun('wide');

  console.log('\n=== RESULTS ===');
  console.log(`narrow run: diffStatus=${narrow.diffStatus} mode=${narrow.merged.mode} summary=${JSON.stringify(narrow.merged.summary)}`);
  console.log(`wide run:   diffStatus=${wide.diffStatus} mode=${wide.merged.mode} summary=${JSON.stringify(wide.merged.summary)}`);

  // === Coverage-accuracy check: is the STORED coverage the real retrieval,
  // not a guess? === This holds regardless of whether the Profile's content
  // happened to diff, since `ComparisonEngine.diffAll` records coverage for
  // every Profile-like key it diffs, identical or not.
  console.log('\n=== COVERAGE ACCURACY (comparisons.profileCoverageJson, read directly off the DB) ===');
  console.log(`[narrow] recorded coverage: ${JSON.stringify(narrow.recordedCoverage)}`);
  console.log(`[wide]   recorded coverage left.retrievedComponents size: ${wide.recordedCoverage?.left?.retrievedComponents?.length}, right: ${wide.recordedCoverage?.right?.retrievedComponents?.length}`);
  console.log(`[wide]   real ApexClass components in results: left-side inventory count unknown from results alone; total ApexClass rows in comparison: ${wide.apexClassNames.length}`);

  let coverageAccuracyFailed = false;
  const narrowRetrievedLeft = narrow.recordedCoverage?.left?.retrievedComponents ?? [];
  const narrowRetrievedRight = narrow.recordedCoverage?.right?.retrievedComponents ?? [];
  if (narrow.recordedCoverage?.left?.mode !== 'scoped' || narrow.recordedCoverage?.right?.mode !== 'scoped') {
    console.error(`FAIL: [narrow] expected mode 'scoped' on both sides for an org source with no paired type retrieved — got ${JSON.stringify(narrow.recordedCoverage)}`);
    coverageAccuracyFailed = true;
  } else if (narrowRetrievedLeft.length !== 0 || narrowRetrievedRight.length !== 0) {
    console.error(`FAIL: [narrow] filter had no ApexClass, yet recorded coverage claims ${narrowRetrievedLeft.length}/${narrowRetrievedRight.length} retrieved ApexClass refs — coverage does not match the real retrieval.`);
    coverageAccuracyFailed = true;
  } else {
    console.log("PASS: [narrow] coverage is 'scoped' with an EMPTY retrievedComponents on both sides -- matches the real retrieval (Profile alone, no paired ApexClass).");
  }

  const wideRetrievedLeft: string[] = wide.recordedCoverage?.left?.retrievedComponents ?? [];
  const wideRetrievedRight: string[] = wide.recordedCoverage?.right?.retrievedComponents ?? [];
  const wideApexRefs = new Set(wide.apexClassNames.map((n) => `ApexClass:${n}`));
  const bogusLeftRefs = wideRetrievedLeft.filter((r) => !wideApexRefs.has(r));
  const bogusRightRefs = wideRetrievedRight.filter((r) => !wideApexRefs.has(r));
  if (wideRetrievedLeft.length === 0 && wideRetrievedRight.length === 0) {
    console.error('FAIL: [wide] filter included ApexClass, yet recorded coverage has zero retrieved refs on both sides.');
    coverageAccuracyFailed = true;
  } else if (bogusLeftRefs.length > 0 || bogusRightRefs.length > 0) {
    console.error(`FAIL: [wide] recorded coverage contains refs that were never actually in this comparison's ApexClass results: left=${JSON.stringify(bogusLeftRefs.slice(0, 5))} right=${JSON.stringify(bogusRightRefs.slice(0, 5))}`);
    coverageAccuracyFailed = true;
  } else {
    console.log(`PASS: [wide] coverage is 'scoped' with ${wideRetrievedLeft.length}/${wideRetrievedRight.length} retrieved ApexClass refs (left/right), every one of them a real ApexClass this comparison actually retrieved (cross-checked against comparisons.results) -- not guessed, not "full".`);
  }

  if (coverageAccuracyFailed) {
    console.error('\nFAIL: coverage-accuracy check failed -- see above.');
    process.exit(1);
  }

  if (narrow.diffStatus === 'identical' && wide.diffStatus === 'identical') {
    console.log(`\nBoth runs saw a byte-identical "${PROFILE_NAME}" Profile -- the permission-suppression side of the fix (an actual one-sided entry resolving 'unchanged') can't be demonstrated on this profile since there's nothing to merge, but the coverage-accuracy checks above already prove the route reads real, non-guessed retrieve-pairing data. Try VIBESET_MERGE_PROFILE=<some other profile that differs between RCA DEV and ARM DEV> to also see the suppression in action.`);
    process.exit(0);
  }

  const narrowOneSided = oneSidedEntries(narrow.merged);
  console.log(`\n[narrow] one-sided permission entries (present on exactly one side): ${narrowOneSided.length}`);
  const narrowWronglyResolved = narrowOneSided.filter((e) => e.status === 'take-left' || e.status === 'take-right');
  console.log(`[narrow] of those, treated as a confirmed deletion (take-left/take-right) instead of ambiguous-unchanged: ${narrowWronglyResolved.length}`);
  for (const e of narrowOneSided.slice(0, 5)) {
    console.log(`  ${e.path}: status=${e.status} left=${e.left ? 'present' : 'absent'} right=${e.right ? 'present' : 'absent'}`);
  }

  const wideOneSided = oneSidedEntries(wide.merged);
  const wideConfirmedResolved = wideOneSided.filter((e: any) => e.status === 'take-left' || e.status === 'take-right');
  console.log(`\n[wide] one-sided permission entries: ${wideOneSided.length}, of those confirmed take-left/take-right (real differences, ApexClass IS in coverage): ${wideConfirmedResolved.length}`);
  for (const e of wideConfirmedResolved.slice(0, 5)) {
    console.log(`  ${e.path}: status=${e.status} left=${e.left ? 'present' : 'absent'} right=${e.right ? 'present' : 'absent'}`);
  }

  if (narrowWronglyResolved.length > 0) {
    console.error(
      `\nFAIL: narrow run (no ApexClass coverage) still resolved ${narrowWronglyResolved.length} one-sided permission entr(y/ies) as a confirmed take-left/take-right — an unretrieved permission would be silently merged away!`,
    );
    process.exit(1);
  }

  if (narrowOneSided.length === 0) {
    console.log('\nNo one-sided permission entries observed in the narrow run for this profile — cannot demonstrate the ambiguity-suppression side of the fix this time. Try a different profile.');
  } else {
    console.log('\nPASS: with no paired-type coverage (narrow run), every one-sided permission entry was reported unchanged (ambiguous), never a confirmed deletion.');
  }
  if (wideConfirmedResolved.length > 0) {
    console.log('PASS: with real ApexClass coverage (wide run), the same kind of one-sided entries under COVERED refs WERE confirmed take-left/take-right — coverage is being read, not just defaulted to "always safe".');
  } else {
    console.log('(No covered one-sided ApexClass permission entries showed up in the wide run to contrast against — coverage plumbing is still proven correct by the narrow-run PASS above, just without a positive contrast case this run.)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
