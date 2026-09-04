#!/usr/bin/env -S node --import tsx
/**
 * Real-org proof for the binary-diff false-negative fix.
 *
 * Compares ARM DEV against ITSELF, restricted to StaticResource, allowing
 * omnistudio__ namespaced components through (ARM DEV has ~200
 * StaticResources, ~199 of them omnistudio__, and a known subset of those
 * throw SDR's BadZipFile during local conversion — see
 * sources/org-source.ts's convertWithIsolation doc comment).
 *
 * Comparing the org against itself means every component that DOES convert
 * cleanly is trivially identical (same bytes both sides) — the
 * interesting signal is entirely in the ones that fail to convert on BOTH
 * sides. Before the fix, those collapsed to `status: 'identical'`
 * (content unreadable on both sides, silently reported as a match). After
 * the fix, they must show up as `status: 'changed'` with
 * `unreadable: { left: true, right: true }`.
 *
 * Read-only: only calls inventory()/materialize() (listMetadata + retrieve).
 * Never deploy/validate.
 */
import { OrgSource, InMemorySnapshotStore, ComparisonEngine } from '@vibeset/core';

const USERNAME = process.env.VIBESET_PERF_RIGHT_USERNAME ?? 'jsarm2pw@pw.com'; // ARM DEV

async function main() {
  const store = new InMemorySnapshotStore();
  const left = new OrgSource('armdev-left', 'ARM DEV (left)', { username: USERNAME });
  const right = new OrgSource('armdev-right', 'ARM DEV (right)', { username: USERNAME });

  const engine = new ComparisonEngine(store);
  console.log(`Running StaticResource comparison against ${USERNAME} (self vs self)...`);
  const result = await engine.run(left, right, {
    comparisonId: 'real-org-binary-check',
    filter: { types: ['StaticResource'], excludeManagedPackages: false },
    onProgress: (p) => {
      if (p.percent % 10 === 0) console.log(`  [${p.percent}%] ${p.message}`);
    },
  });

  const total = result.results.length;
  const unreadable = result.results.filter((r) => r.unreadable);
  const identical = result.results.filter((r) => r.status === 'identical');
  const changed = result.results.filter((r) => r.status === 'changed');

  console.log(`\nTotal StaticResource results: ${total}`);
  console.log(`  identical: ${identical.length}`);
  console.log(`  changed:   ${changed.length}`);
  console.log(`  unreadable-flagged: ${unreadable.length}`);

  if (unreadable.length === 0) {
    console.log('\nNo unreadable (BadZipFile-style) components observed this run — cannot demonstrate the fix on this data. Try again, or check different StaticResources.');
    process.exit(0);
  }

  console.log('\nSample unreadable results (proves these are NOT reported as identical):');
  for (const r of unreadable.slice(0, 10)) {
    console.log(`  ${r.key.fullName}: status=${r.status} binary=${r.binary} unreadable=${JSON.stringify(r.unreadable)} leftSha=${r.leftSha256 ?? '(none)'} rightSha=${r.rightSha256 ?? '(none)'}`);
  }

  const wronglyIdentical = unreadable.filter((r) => r.status === 'identical');
  if (wronglyIdentical.length > 0) {
    console.error(`\nFAIL: ${wronglyIdentical.length} unreadable result(s) still reported as 'identical' — fix did not hold!`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${unreadable.length} unreadable-content component(s) reported status='changed' (never 'identical').`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
