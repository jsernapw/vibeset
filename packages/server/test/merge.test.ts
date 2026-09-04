import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';
import { getDb } from '../src/db/client.js';
import { comparisons } from '../src/db/schema.js';

let started: StartedServer;
let tmpHome: string;
let leftProjectDir: string;
let rightProjectDir: string;
let gitRepoDir: string;

function authHeaders(): Record<string, string> {
  return { 'x-vibeset-token': started.token, origin: `http://127.0.0.1:${started.port}` };
}

async function trpcQuery(path: string, input: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: authHeaders(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.result.data;
}

async function trpcMutate(path: string, input: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.result.data;
}

async function waitForJob(jobId: string): Promise<any> {
  let job: any;
  for (let i = 0; i < 200; i += 1) {
    job = await trpcQuery('jobs.get', { jobId });
    if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled')) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state in time (last status: ${job?.status})`);
}

async function writeFileDeep(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

// Profile is deliberately the fixture type here, not CustomObject: Profile
// is never decomposed (a single .profile-meta.xml holding its whole
// permission grid inline), so the content this test's sfdx-project
// connections actually resolve and hand to mergeComponent is exactly what a
// human would read — and it is the one type where getting the coverage
// argument wrong (`requireMergeProfileCoverage`) silently strips real
// permissions on deploy, which is the specific hazard this route exists to
// prevent.
function profileXml(opts: { description?: string; classAccesses?: Array<{ name: string; enabled: boolean }> } = {}): string {
  const parts: string[] = [];
  if (opts.description !== undefined) parts.push(`\n  <description>${opts.description}</description>`);
  for (const c of opts.classAccesses ?? []) {
    parts.push(`\n  <classAccesses><apexClass>${c.name}</apexClass><enabled>${c.enabled}</enabled></classAccesses>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${parts.join('')}\n</Profile>\n`;
}

async function writeApexClass(dir: string, name: string, body: string): Promise<void> {
  await writeFileDeep(join(dir, `force-app/main/default/classes/${name}.cls`), body);
  await writeFileDeep(
    join(dir, `force-app/main/default/classes/${name}.cls-meta.xml`),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );
}

async function writeProject(dir: string, profile: string): Promise<void> {
  await writeFileDeep(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  await writeApexClass(dir, 'FooController', 'public class FooController {}');
  await writeFileDeep(join(dir, 'force-app/main/default/profiles/Admin.profile-meta.xml'), profile);
}

async function writeStaticResource(dir: string, bytes: Buffer): Promise<void> {
  await writeFileDeep(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  await mkdir(join(dir, 'force-app/main/default/staticresources'), { recursive: true });
  await writeFile(join(dir, 'force-app/main/default/staticresources/Widget.resource'), bytes);
  await writeFile(
    join(dir, 'force-app/main/default/staticresources/Widget.resource-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl><contentType>text/plain</contentType></StaticResource>\n',
  );
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-server-merge-test-'));
  process.env.VIBESET_HOME = tmpHome;
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0 });
});

afterAll(async () => {
  await started.close();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

beforeEach(async () => {
  leftProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-merge-left-'));
  rightProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-merge-right-'));
  gitRepoDir = await mkdtemp(join(tmpdir(), 'vibeset-merge-git-'));

  // Left changes FooController's access; right changes the description —
  // two non-overlapping edits, so a two-way merge should auto-resolve both
  // (take-left / take-right) with zero conflicts, and a three-way merge
  // against a base matching each side everywhere EXCEPT its own edit
  // should do the same (see the three-way test below for the base fixture
  // this is designed to pair with).
  await writeProject(leftProjectDir, profileXml({ description: 'Base profile', classAccesses: [{ name: 'FooController', enabled: false }] }));
  await writeProject(rightProjectDir, profileXml({ description: 'Right edited this', classAccesses: [{ name: 'FooController', enabled: true }] }));
});

afterEach(async () => {
  await rm(leftProjectDir, { recursive: true, force: true });
  await rm(rightProjectDir, { recursive: true, force: true });
  await rm(gitRepoDir, { recursive: true, force: true });
});

async function setupProfileComparison() {
  const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
  const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
  const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
    leftConnectionId: leftId,
    rightConnectionId: rightId,
    filter: { types: ['Profile', 'ApexClass'] },
  });
  const job = await waitForJob(jobId);
  expect(job.status).toBe('succeeded');
  return { leftId, rightId, comparisonId };
}

describe('merge router', () => {
  it('two-way merge (no baseConnectionId): resolves a changed Profile using the coverage captured by its own comparison, not an assumed default', async () => {
    const { comparisonId } = await setupProfileComparison();

    const results = await trpcQuery('comparisons.results', { comparisonId });
    const profileRow = results.find((r: any) => r.type === 'Profile' && r.fullName === 'Admin');
    expect(profileRow).toBeDefined();
    expect(profileRow.status).toBe('changed');

    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin' });

    expect(merged.comparisonId).toBe(comparisonId);
    expect(merged.diffStatus).toBe('changed');
    expect(merged.mode).toBe('two-way');
    expect(merged.key).toEqual({ type: 'Profile', fullName: 'Admin' });

    const description = merged.entries.find((e: any) => e.path === 'description');
    expect(description.status).toBe('conflict'); // both sides changed it differently, no base to prefer either

    const classAccess = merged.entries.find((e: any) => e.path === 'classAccesses.FooController');
    expect(classAccess.status).toBe('conflict'); // enabled:true vs enabled:false on the same entry
  });

  it('rejects a non-git-ref baseConnectionId with a hard error instead of silently downgrading to two-way', async () => {
    const { comparisonId, leftId } = await setupProfileComparison();

    await expect(
      trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin', baseConnectionId: leftId }),
    ).rejects.toThrow(/connection, not.*git-ref/);
  });

  it('three-way merge via a git-ref baseConnectionId: auto-resolves non-overlapping edits against the real common ancestor, echoing mode: "three-way"', async () => {
    // Base matches left everywhere except classAccesses, and matches right
    // everywhere except description — so each side's one edit is cleanly
    // attributable to that side alone relative to base, and the other
    // side's untouched field auto-resolves to the other side. No conflict.
    git(gitRepoDir, 'init', '-b', 'main');
    await writeProject(gitRepoDir, profileXml({ description: 'Base profile', classAccesses: [{ name: 'FooController', enabled: true }] }));
    git(gitRepoDir, 'add', '.');
    git(gitRepoDir, 'commit', '-m', 'base');

    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
    const { id: baseId } = await trpcMutate('connections.add', { kind: 'git-ref', label: 'Base', projectPath: gitRepoDir, gitRef: 'main' });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['Profile', 'ApexClass'] },
    });
    await waitForJob(jobId);

    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin', baseConnectionId: baseId });

    expect(merged.mode).toBe('three-way');
    expect(merged.summary.conflict).toBe(0);

    const description = merged.entries.find((e: any) => e.path === 'description');
    expect(description.status).toBe('take-right');
    expect(description.resolved).toBe('Right edited this');

    const classAccess = merged.entries.find((e: any) => e.path === 'classAccesses.FooController');
    expect(classAccess.status).toBe('take-left');
    expect(classAccess.resolved).toEqual({ apexClass: 'FooController', enabled: 'false' });
  });

  it('refuses to entry-merge a binary-bodied component (StaticResource) rather than attempting a meaningless byte-level merge', async () => {
    await writeStaticResource(leftProjectDir, Buffer.from('left bytes'));
    await writeStaticResource(rightProjectDir, Buffer.from('right bytes, different'));

    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['StaticResource'] },
    });
    await waitForJob(jobId);

    await expect(
      trpcQuery('merge.resolve', { comparisonId, type: 'StaticResource', fullName: 'Widget' }),
    ).rejects.toThrow(/binary-bodied/);
  });

  it('byte-identical content on both sides merges via the { mode: "full" } shortcut even with no stored coverage at all', async () => {
    // Same fixture on both sides this time — leftSha256 === rightSha256,
    // which the router special-cases (see merge.ts's doc comment): coverage
    // ambiguity cannot matter when both sides are literally the same bytes.
    await writeProject(leftProjectDir, profileXml({ description: 'Same everywhere', classAccesses: [{ name: 'FooController', enabled: true }] }));
    await writeProject(rightProjectDir, profileXml({ description: 'Same everywhere', classAccesses: [{ name: 'FooController', enabled: true }] }));

    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['Profile', 'ApexClass'] },
    });
    await waitForJob(jobId);

    const results = await trpcQuery('comparisons.results', { comparisonId });
    const profileRow = results.find((r: any) => r.type === 'Profile' && r.fullName === 'Admin');
    expect(profileRow.status).toBe('identical');

    // Prove the shortcut, not just its absence of a throw: wipe this
    // comparison's stored coverage entirely, then confirm the merge still
    // succeeds — it can only be reaching that outcome via the byte-identical
    // shortcut, since `requireMergeProfileCoverage` would otherwise throw.
    const db = getDb();
    db.update(comparisons).set({ profileCoverageJson: null }).where(eq(comparisons.id, comparisonId)).run();

    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin' });
    expect(merged.mode).toBe('two-way');
    expect(merged.summary.conflict).toBe(0);
    expect(merged.entries.every((e: any) => e.status === 'unchanged')).toBe(true);
  });

  it('reads hand-crafted "scoped" coverage (a real array-based retrievedComponents, as an org-sourced comparison would record) without crashing, and treats an unconfirmed one-sided permission as ambiguous, not a confirmed deletion', async () => {
    // Regression test for a bug caught while verifying this route against
    // real orgs: `comparisons.ts` stored `SideCoverage`'s `retrievedComponents`
    // (a `Set`) via a bare `JSON.stringify`, which silently serializes a
    // `Set` to `{}` (no own enumerable properties) — so every real
    // org-sourced "scoped" coverage entry landed in SQLite as `{}`, and
    // `merge.ts` read it back as a plain object with no `.has()` method,
    // which `diff/profiles.ts`'s `isCovered` calls unconditionally. Every
    // org-vs-org Profile/PermissionSet merge with anything less than full
    // coverage would have thrown a TypeError out of `merge.resolve`. Fixed
    // via `shared/profile-coverage-json.ts`'s array-based JSON codec; this
    // test writes the codec's OWN on-disk shape directly (bypassing
    // `ComparisonEngine`, since `sfdx-project` sources never produce
    // anything but `{ mode: 'full' }` coverage — this exact "scoped" shape
    // only occurs for a real `org` source) to prove `merge.resolve` reads
    // it correctly rather than merely not-crashing on a lucky input.
    await writeProject(
      leftProjectDir,
      profileXml({
        description: 'Base profile',
        classAccesses: [
          { name: 'FooController', enabled: false },
          { name: 'BarController', enabled: true }, // present on left only
        ],
      }),
    );
    // rightProjectDir keeps its beforeEach fixture: no BarController at all.

    const { comparisonId } = await setupProfileComparison();

    const db = getDb();
    db.update(comparisons)
      .set({
        // The codec's array-based on-disk shape (see
        // `shared/profile-coverage-json.ts`) — NOT a `Set`, which
        // `JSON.stringify` can't represent, and NOT `{}`, which is the bug
        // this regression test exists to catch. Neither ApexClass ref was
        // "co-retrieved" in this hand-crafted coverage, so BarController's
        // left-only presence must NOT resolve as a confirmed take-left.
        profileCoverageJson: JSON.stringify({
          'Profile#Admin': {
            left: { mode: 'scoped', retrievedComponents: [] },
            right: { mode: 'scoped', retrievedComponents: [] },
          },
        }),
      })
      .where(eq(comparisons.id, comparisonId))
      .run();

    const merged = await trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin' });

    const bar = merged.entries.find((e: any) => e.path === 'classAccesses.BarController');
    expect(bar).toBeDefined();
    expect(bar.left).toEqual({ apexClass: 'BarController', enabled: 'true' });
    expect(bar.right).toBeUndefined();
    // The whole point: NOT 'take-left' (that would mean "this is a
    // confirmed grant to deploy"), because coverage never confirmed
    // BarController's absence on the right was real rather than just
    // unretrieved.
    expect(bar.status).toBe('unchanged');
    expect(bar.resolved).toEqual({ apexClass: 'BarController', enabled: 'true' });
  });

  it('refuses to merge a changed Profile with no recorded coverage rather than silently assuming full coverage', async () => {
    const { comparisonId } = await setupProfileComparison();

    // Simulate a comparison that predates coverage capture (or whose
    // coverage was for some reason never recorded) by wiping the column
    // directly, bypassing the API entirely — this is the one situation
    // `requireMergeProfileCoverage` must refuse rather than guess through,
    // since guessing "full" here is exactly the failure mode (an
    // unretrieved permission silently treated as a deletion) the whole
    // coverage plumbing exists to prevent.
    const db = getDb();
    db.update(comparisons).set({ profileCoverageJson: null }).where(eq(comparisons.id, comparisonId)).run();

    await expect(
      trpcQuery('merge.resolve', { comparisonId, type: 'Profile', fullName: 'Admin' }),
    ).rejects.toThrow(/no recorded retrieve-pairing coverage/);
  });

  it('reports a clear not-found error for an unknown comparison/component rather than a generic crash', async () => {
    await expect(
      trpcQuery('merge.resolve', { comparisonId: 'does-not-exist', type: 'ApexClass', fullName: 'Nope' }),
    ).rejects.toThrow(/No diff result/);
  });
});
