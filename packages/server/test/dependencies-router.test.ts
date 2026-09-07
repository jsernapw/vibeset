import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DependencyEdge } from '@vibeset/core';
import type { StartedServer } from '../src/server.js';
import { getDb } from '../src/db/client.js';
import { dependencySyncRuns } from '../src/db/schema.js';
import { replaceDependencyEdges } from '../src/store/drizzle-dependency-graph.js';

let started: StartedServer;
let tmpHome: string;

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

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-dep-router-test-'));
  process.env.VIBESET_HOME = tmpHome;
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0 });
});

afterAll(async () => {
  await started.close();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

let connectionId: string;

beforeEach(async () => {
  const { id } = await trpcMutate('connections.add', { kind: 'org', label: 'Fake Org', username: `fake-${Math.random()}@example.com` });
  connectionId = id;
});

const A_TO_B: DependencyEdge = { fromType: 'ApexClass', fromFullName: 'A', toType: 'ApexClass', toFullName: 'B', provenance: 'org' };
const B_TO_C: DependencyEdge = { fromType: 'ApexClass', fromFullName: 'B', toType: 'ApexClass', toFullName: 'C', provenance: 'org' };
const PROFILE_GRANTS_A: DependencyEdge = {
  fromType: 'Profile',
  fromFullName: 'Admin',
  toType: 'ApexClass',
  toFullName: 'A',
  provenance: 'supplemented',
  supplementKind: 'profile-grant',
};

describe('dependencies router (over real HTTP against a started server)', () => {
  it('forward/reverse return direct edges scoped to the connection, in the shape a client actually receives (JSON round-trip)', async () => {
    replaceDependencyEdges(getDb(), connectionId, 'seed-run', [A_TO_B, B_TO_C, PROFILE_GRANTS_A]);

    const forward = await trpcQuery('dependencies.forward', { connectionId, key: { type: 'ApexClass', fullName: 'A' } });
    expect(forward).toEqual([A_TO_B]);

    const reverse = await trpcQuery('dependencies.reverse', { connectionId, key: { type: 'ApexClass', fullName: 'A' } });
    expect(reverse).toEqual([PROFILE_GRANTS_A]);
  });

  it('impact (reverse direction) finds everything transitively implicated by deleting a component, tagged with depth', async () => {
    replaceDependencyEdges(getDb(), connectionId, 'seed-run', [A_TO_B, B_TO_C]);

    const result = await trpcQuery('dependencies.impact', {
      connectionId,
      seeds: [{ type: 'ApexClass', fullName: 'C' }],
      direction: 'reverse',
    });

    expect(result.nodes.map((n: any) => [n.key.fullName, n.depth])).toEqual([
      ['B', 1],
      ['A', 2],
    ]);
    expect(result.knownCoverageGaps.length).toBeGreaterThan(0);
  });

  it('impact (forward direction) finds everything a deployment of the seed would also need', async () => {
    replaceDependencyEdges(getDb(), connectionId, 'seed-run', [A_TO_B, B_TO_C]);

    const result = await trpcQuery('dependencies.impact', {
      connectionId,
      seeds: [{ type: 'ApexClass', fullName: 'A' }],
      direction: 'forward',
    });

    expect(result.nodes.map((n: any) => n.key.fullName)).toEqual(['B', 'C']);
  });

  it('references answers "confirmed" for a real (possibly transitive) reference and "no-recorded-edge" otherwise — never a bare boolean', async () => {
    replaceDependencyEdges(getDb(), connectionId, 'seed-run', [A_TO_B, B_TO_C]);

    const confirmed = await trpcQuery('dependencies.references', {
      connectionId,
      from: { type: 'ApexClass', fullName: 'A' },
      to: { type: 'ApexClass', fullName: 'C' },
    });
    expect(confirmed.certainty).toBe('confirmed');

    const unknown = await trpcQuery('dependencies.references', {
      connectionId,
      from: { type: 'ApexClass', fullName: 'C' },
      to: { type: 'ApexClass', fullName: 'ZZZ_Nonexistent' },
    });
    expect(unknown).toEqual({ certainty: 'no-recorded-edge' });
  });

  it('a connection with no graph synced yet answers with empty results, not an error', async () => {
    const forward = await trpcQuery('dependencies.forward', { connectionId, key: { type: 'ApexClass', fullName: 'Anything' } });
    expect(forward).toEqual([]);
  });

  it('sync creates a running dependency_sync_runs row immediately, then marks it failed (with the real error) once the job cannot authenticate the fake org', async () => {
    const { syncRunId, jobId } = await trpcMutate('dependencies.sync', { connectionId });
    expect(syncRunId).toBeTruthy();
    expect(jobId).toBeTruthy();

    const runsRightAway = await trpcQuery('dependencies.syncRuns', { connectionId });
    expect(runsRightAway[0].id).toBe(syncRunId);
    expect(['running', 'failed']).toContain(runsRightAway[0].status);
    expect(runsRightAway[0].knownGaps.length).toBeGreaterThan(0);

    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed'); // the fake username has no real `sf` CLI auth entry

    const run = getDb().select().from(dependencySyncRuns).where(eq(dependencySyncRuns.id, syncRunId)).get();
    expect(run?.status).toBe('failed');
    expect(run?.errorsJson).toBeTruthy();
  });

  it('sync refuses a non-org connection outright', async () => {
    const { id: gitId } = await trpcMutate('connections.add', {
      kind: 'git-ref',
      label: 'Some ref',
      projectPath: tmpHome,
      gitRef: 'main',
    });
    const { jobId } = await trpcMutate('dependencies.sync', { connectionId: gitId });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain("only supports 'org' connections");
  });
});
