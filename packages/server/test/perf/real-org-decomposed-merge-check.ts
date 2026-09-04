#!/usr/bin/env -S node --import tsx
/**
 * Real-org proof for the decomposed-CustomObject merge fix
 * (`compare/content-reader.ts`'s `compose` option +
 * `trpc/routers/merge.ts`'s `materializeOneComponent`/`resolveSideContent`).
 *
 * THE BUG THIS PROVES FIXED: `resolveComponentContents` used to read a
 * decomposed `CustomObject`'s content as just its on-disk shell file
 * (`<Name>.object-meta.xml`), which for a REAL retrieve does NOT contain
 * `<fields>`/`<listViews>`/... — those are separate `SourceComponent`s on
 * disk (`fields/*.field-meta.xml`, `listViews/*.listView-meta.xml`, ...).
 * `merge/generic-merge.ts`'s `decomposeGeneric` parses that single string
 * and explodes its top-level tags into merge entries — with the shell-only
 * content, it silently produced ZERO `fields.*`/`listViews.*` entries,
 * no matter how many fields the object actually has. Cassia's own merge
 * fixtures never caught this because they're hand-written COMPLETE
 * `.object` files (mdapi shape), not a real retrieved source-format tree.
 *
 * This script is read-only throughout (`listMetadata`/`retrieve` via
 * `ComparisonEngine` and the merge route's own `inventory`/`materialize`
 * calls) against RCA DEV and ARM DEV. Never `deploy.deploy` or
 * `deploy.validate`.
 *
 * Run manually: tsx test/perf/real-org-decomposed-merge-check.ts
 *
 * Env overrides:
 *   VIBESET_PERF_LEFT_USERNAME   default: jsarm@pw.com      (RCA DEV)
 *   VIBESET_PERF_RIGHT_USERNAME  default: jsarm2pw@pw.com   (ARM DEV)
 *   VIBESET_MERGE_OBJECT         default: Account
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.js';

const LEFT_USERNAME = process.env.VIBESET_PERF_LEFT_USERNAME ?? 'jsarm@pw.com'; // RCA DEV
const RIGHT_USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV
const OBJECT_NAME = process.env.VIBESET_MERGE_OBJECT ?? 'Account';

async function main() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-decomposed-merge-check-'));
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
    console.log(`Comparing CustomObject "${OBJECT_NAME}" between ${LEFT_USERNAME} (RCA DEV) and ${RIGHT_USERNAME} (ARM DEV)...`);
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'org', label: 'RCA DEV', username: LEFT_USERNAME });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'org', label: 'ARM DEV', username: RIGHT_USERNAME });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['CustomObject'], namePatterns: [OBJECT_NAME] },
    });
    console.log(`comparisonId=${comparisonId} jobId=${jobId} — running...`);
    const job = await waitForJob(jobId);
    if (job.status !== 'succeeded') throw new Error(`job did not succeed: ${JSON.stringify(job)}`);

    const results = await trpcQuery('comparisons.results', { comparisonId });
    const objectRow = results.find((r: any) => r.type === 'CustomObject' && r.fullName === OBJECT_NAME);
    if (!objectRow) throw new Error(`No CustomObject "${OBJECT_NAME}" in results.`);
    console.log(`CustomObject "${OBJECT_NAME}" diff status: ${objectRow.status}`);

    // === THE PROOF ===
    // Before the fix, `merge.resolve` would read the shell-only content
    // (no `<fields>` tag at all — verified directly against this same
    // retrieve earlier: `Account.object-meta.xml` has zero field entries),
    // so `merged.entries` would contain ZERO `fields.*`/`listViews.*`
    // entries regardless of how many fields/list views the object
    // actually has. After the fix, `materializeOneComponent` recomposes
    // the object with its children before merge sees it.
    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'CustomObject', fullName: OBJECT_NAME });
    console.log(`\nmerge.resolve mode=${merged.mode} summary=${JSON.stringify(merged.summary)}`);
    console.log(`total entries: ${merged.entries.length}`);

    const byGroup = new Map<string, number>();
    for (const e of merged.entries as any[]) {
      const group = e.path.includes('.') ? e.path.slice(0, e.path.indexOf('.')) : e.path;
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }
    console.log('\nentries by top-level group (fields/listViews/recordTypes/... proves composition worked; a scalar-only\nlist like {label:1, sharingModel:1} would mean the bug is still there):');
    for (const [group, count] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${group}: ${count}`);
    }

    const fieldEntries = (merged.entries as any[]).filter((e) => e.path.startsWith('fields.'));
    console.log(`\nfields.* entries: ${fieldEntries.length}`);
    console.log('sample field entries:', fieldEntries.slice(0, 5).map((e) => e.path));

    if (fieldEntries.length === 0) {
      console.error('\nFAILURE: zero fields.* entries — composition did not work (the bug this script exists to catch is still present).');
      process.exitCode = 1;
    } else {
      console.log(`\nSUCCESS: merge.resolve for a real, live-retrieved decomposed CustomObject sees its fields (${fieldEntries.length} field entries).`);
    }
  } finally {
    await started.close();
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
