import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';

let started: StartedServer;
let tmpHome: string;
let projectDir: string;

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
  for (let i = 0; i < 100; i += 1) {
    job = await trpcQuery('jobs.get', { jobId });
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state in time (last status: ${job?.status})`);
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-server-conn-test-'));
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
  projectDir = await mkdtemp(join(tmpdir(), 'vibeset-conn-project-'));
  await writeFile(
    join(projectDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }),
  );
  await mkdir(join(projectDir, 'force-app/main/default/classes'), { recursive: true });
  await writeFile(join(projectDir, 'force-app/main/default/classes/Foo.cls'), 'public class Foo {}');
  await writeFile(
    join(projectDir, 'force-app/main/default/classes/Foo.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('connections router', () => {
  it('adds, lists, and removes an sfdx-project connection', async () => {
    const { id } = await trpcMutate('connections.add', {
      kind: 'sfdx-project',
      label: 'Test Project',
      projectPath: projectDir,
    });
    expect(id).toBeTruthy();

    const list = await trpcQuery('connections.list', undefined);
    expect(list.some((c: any) => c.id === id && c.kind === 'sfdx-project')).toBe(true);

    await trpcMutate('connections.remove', { connectionId: id });
    const listAfter = await trpcQuery('connections.list', undefined);
    expect(listAfter.some((c: any) => c.id === id)).toBe(false);
  });

  it('rejects healthCheck for a non-org connection', async () => {
    const { id } = await trpcMutate('connections.add', {
      kind: 'sfdx-project',
      label: 'Test Project',
      projectPath: projectDir,
    });
    await expect(trpcQuery('connections.healthCheck', { connectionId: id })).rejects.toThrow();
  });
});

describe('inventory router', () => {
  it('starts an inventory job for a registered sfdx-project connection and completes with a cache-aware plan', async () => {
    const { id } = await trpcMutate('connections.add', {
      kind: 'sfdx-project',
      label: 'Test Project',
      projectPath: projectDir,
    });

    const { jobId } = await trpcMutate('inventory.start', { connectionId: id, filter: { types: ['ApexClass'] } });
    expect(jobId).toBeTruthy();

    const job = await waitForJob(jobId);
    expect(job.status).toBe('succeeded');
    const result = JSON.parse(job.resultJson);
    expect(result.sourceId).toBe(id);
    expect(result.inventoriedCount).toBe(1);
    expect(result.toFetchCount).toBe(1); // nothing cached yet
    expect(result.cacheHitCount).toBe(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('fails the job cleanly for an unknown connectionId', async () => {
    const { jobId } = await trpcMutate('inventory.start', { connectionId: 'does-not-exist' });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/No connection with id/);
  });

  it('availableTypes returns the curated default as a subset of the full registry-driven type list, with no connection required', async () => {
    const { all, default: curated } = await trpcQuery('inventory.availableTypes', {});
    expect(Array.isArray(all)).toBe(true);
    expect(Array.isArray(curated)).toBe(true);
    expect(all.length).toBeGreaterThan(curated.length);
    for (const t of curated) expect(all).toContain(t);
    expect(curated).toContain('ApexClass');
    expect(curated).toContain('StaticResource'); // the binary-content fix's type
  });
});
