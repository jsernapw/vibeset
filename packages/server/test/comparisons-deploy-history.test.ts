import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';

let started: StartedServer;
let tmpHome: string;
let leftProjectDir: string;
let rightProjectDir: string;

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

async function writeApexProject(dir: string, body: string): Promise<void> {
  await writeFile(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  await mkdir(join(dir, 'force-app/main/default/classes'), { recursive: true });
  await writeFile(join(dir, 'force-app/main/default/classes/Foo.cls'), body);
  await writeFile(
    join(dir, 'force-app/main/default/classes/Foo.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-server-cdh-test-'));
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
  leftProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-cdh-left-'));
  rightProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-cdh-right-'));
  // left = target/before (unchanged Foo), right = desired/after (Foo changed) —
  // see package/selection.ts's documented convention.
  await writeApexProject(leftProjectDir, 'public class Foo { Integer v = 1; }');
  await writeApexProject(rightProjectDir, 'public class Foo { Integer v = 2; }');
});

afterEach(async () => {
  await rm(leftProjectDir, { recursive: true, force: true });
  await rm(rightProjectDir, { recursive: true, force: true });
});

describe('comparisons router', () => {
  it('runs a full comparison job between two sfdx-project connections and persists diff_results', async () => {
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['ApexClass'] },
    });
    expect(comparisonId).toBeTruthy();
    expect(jobId).toBeTruthy();

    const job = await waitForJob(jobId);
    expect(job.status).toBe('succeeded');

    const summary = await trpcQuery('comparisons.get', { comparisonId });
    expect(summary.status).toBe('completed');
    expect(summary.summary.changed).toBe(1);

    const results = await trpcQuery('comparisons.results', { comparisonId });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('ApexClass');
    expect(results[0].fullName).toBe('Foo');
    expect(results[0].status).toBe('changed');

    const filteredByStatus = await trpcQuery('comparisons.results', { comparisonId, status: 'new' });
    expect(filteredByStatus).toHaveLength(0);

    const list = await trpcQuery('comparisons.list', undefined);
    expect(list.some((c: any) => c.id === comparisonId)).toBe(true);

    // Already terminal — cancel is a graceful no-op, not an error.
    const cancelResult = await trpcMutate('comparisons.cancel', { comparisonId });
    expect(cancelResult.canceled).toBe(false);

    return { leftId, rightId, comparisonId };
  });

  it('rejects an unknown connectionId immediately (the comparisons.leftConnectionId/rightConnectionId FK constraint) rather than queuing a doomed job', async () => {
    await expect(
      trpcMutate('comparisons.start', {
        leftConnectionId: 'does-not-exist-left',
        rightConnectionId: 'does-not-exist-right',
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('store router', () => {
  it('exposes SnapshotStore.stats()', async () => {
    const stats = await trpcQuery('store.stats', undefined);
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('bytesSaved');
    expect(stats).toHaveProperty('blobCount');
    expect(stats).toHaveProperty('totalBytes');
    expect(typeof stats.blobCount).toBe('number');
  });
});

describe('deploy router', () => {
  async function setupComparison() {
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['ApexClass'] },
    });
    await waitForJob(jobId);
    return { leftId, rightId, comparisonId };
  }

  it('buildPackage generates package.xml via SDR from selected diff-result keys', async () => {
    const { comparisonId } = await setupComparison();

    const built = await trpcMutate('deploy.buildPackage', {
      comparisonId,
      name: 'Test Package',
      selectedKeys: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    expect(built.packageId).toBeTruthy();
    expect(built.components).toEqual([{ type: 'ApexClass', fullName: 'Foo' }]);
    expect(built.destructiveComponents).toEqual([]);
    expect(built.packageXml).toContain('<members>Foo</members>');
    expect(built.packageXml).toContain('<name>ApexClass</name>');
    expect(built.destructiveChangesXml).toBeUndefined();
    expect(built.manifestPath).toBeTruthy();

    const fetched = await trpcQuery('deploy.get', { packageId: built.packageId });
    expect(fetched.name).toBe('Test Package');
    expect(fetched.components).toEqual([{ type: 'ApexClass', fullName: 'Foo' }]);
  });

  it('deploy.deploy fails cleanly (job failure, not a server crash) when the target connection is not an org', async () => {
    const { comparisonId } = await setupComparison();
    const { id: nonOrgConnectionId } = await trpcMutate('connections.add', {
      kind: 'sfdx-project',
      label: 'Not an org',
      projectPath: leftProjectDir,
    });
    const built = await trpcMutate('deploy.buildPackage', {
      comparisonId,
      name: 'Bad Target Package',
      selectedKeys: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    const { deploymentId, jobId } = await trpcMutate('deploy.deploy', {
      packageId: built.packageId,
      targetConnectionId: nonOrgConnectionId,
      sourceConnectionId: nonOrgConnectionId,
      testLevel: 'NoTestRun',
    });
    expect(deploymentId).toBeTruthy();

    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/must be an org connection/);

    const status = await trpcQuery('deploy.status', { deploymentId });
    expect(status.status).toBe('failed');

    const cancelResult = await trpcMutate('deploy.cancel', { deploymentId });
    expect(cancelResult.canceled).toBe(false); // job already terminal
  });

  it('deploy.deploy rejects a non-rollback package with no sourceConnectionId before ever touching the network', async () => {
    const { comparisonId } = await setupComparison();
    const built = await trpcMutate('deploy.buildPackage', {
      comparisonId,
      name: 'No Source Package',
      selectedKeys: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    await expect(
      trpcMutate('deploy.deploy', {
        packageId: built.packageId,
        targetConnectionId: 'irrelevant',
        testLevel: 'NoTestRun',
      }),
    ).rejects.toThrow();
  });
});

describe('history router', () => {
  it('list/get reflect a failed deployment, and generateRollback refuses a checkOnly (validation-only) deployment', async () => {
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
    const { comparisonId, jobId: compareJobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['ApexClass'] },
    });
    await waitForJob(compareJobId);

    const built = await trpcMutate('deploy.buildPackage', {
      comparisonId,
      name: 'History Test Package',
      selectedKeys: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    // Target is a non-org connection, so the job fails before ever
    // attempting a network call — but a `deployments` row (checkOnly:
    // true, status: 'failed') is still created, which is exactly what
    // history.list/get and the generateRollback guard need to exercise.
    const { deploymentId, jobId } = await trpcMutate('deploy.validate', {
      packageId: built.packageId,
      targetConnectionId: leftId, // sfdx-project, not org
      sourceConnectionId: rightId,
      testLevel: 'NoTestRun',
    });
    await waitForJob(jobId);

    const list = await trpcQuery('history.list', undefined);
    const row = list.find((d: any) => d.id === deploymentId);
    expect(row).toBeDefined();
    expect(row.checkOnly).toBe(true);
    expect(row.status).toBe('failed');
    expect(row.quickDeployable).toBe(false); // failed, not succeeded

    const detail = await trpcQuery('history.get', { deploymentId });
    expect(detail.package.name).toBe('History Test Package');

    await expect(trpcMutate('history.generateRollback', { deploymentId })).rejects.toThrow(/checkOnly/);
  });

  it('generateRollback refuses a deployment with no associated package', async () => {
    // No package/deploy flow exercised here — just confirm the guard
    // rejects an id that plainly doesn't exist rather than crashing.
    await expect(trpcMutate('history.generateRollback', { deploymentId: 'does-not-exist' })).rejects.toThrow(/No deployment with id/);
  });
});
