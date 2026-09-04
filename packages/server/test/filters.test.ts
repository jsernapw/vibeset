import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';

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

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-server-filters-test-'));
  process.env.VIBESET_HOME = tmpHome;
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0 });
});

afterAll(async () => {
  await started.close();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

describe('filters router — saveable named filter sets under .vibeset/filter-sets/', () => {
  it('list returns an empty array before anything has been saved', async () => {
    expect(await trpcQuery('filters.list', undefined)).toEqual([]);
  });

  it('save creates a new filter set with a generated id, then get/list find it', async () => {
    const { filterSet, filePath } = await trpcMutate('filters.save', {
      name: 'Exclude OmniStudio',
      description: 'Hide the omnistudio managed package.',
      filter: { excludeManagedPackages: true, excludeNamespaces: ['omnistudio'] },
    });

    expect(filterSet.id).toBeTruthy();
    expect(filterSet.name).toBe('Exclude OmniStudio');
    expect(filterSet.filter).toEqual({ excludeManagedPackages: true, excludeNamespaces: ['omnistudio'] });
    expect(filePath).toContain(join('filter-sets', `${filterSet.id}.yml`));

    const fetched = await trpcQuery('filters.get', { id: filterSet.id });
    expect(fetched).toEqual(filterSet);

    const list = await trpcQuery('filters.list', undefined);
    expect(list.some((f: any) => f.id === filterSet.id)).toBe(true);
  });

  it('save with an existing id updates in place, preserving createdAt and bumping updatedAt', async () => {
    const created = await trpcMutate('filters.save', { name: 'Original name', filter: { types: ['ApexClass'] } });

    // Ensure a real clock tick so updatedAt is provably different, not just
    // possibly-equal on a very fast machine.
    await new Promise((r) => setTimeout(r, 5));

    const updated = await trpcMutate('filters.save', {
      id: created.filterSet.id,
      name: 'Renamed',
      filter: { types: ['ApexClass', 'ApexTrigger'] },
    });

    expect(updated.filterSet.id).toBe(created.filterSet.id);
    expect(updated.filterSet.name).toBe('Renamed');
    expect(updated.filterSet.filter).toEqual({ types: ['ApexClass', 'ApexTrigger'] });
    expect(updated.filterSet.createdAt).toBe(created.filterSet.createdAt);
    expect(updated.filterSet.updatedAt >= created.filterSet.updatedAt).toBe(true);
  });

  it('delete removes a saved filter set', async () => {
    const { filterSet } = await trpcMutate('filters.save', { name: 'To delete', filter: {} });
    await trpcMutate('filters.delete', { id: filterSet.id });

    const list = await trpcQuery('filters.list', undefined);
    expect(list.some((f: any) => f.id === filterSet.id)).toBe(false);
    await expect(trpcQuery('filters.get', { id: filterSet.id })).rejects.toThrow();
  });

  it('a saved filter set round-trips through comparisons.start via its filter field', async () => {
    const { filterSet } = await trpcMutate('filters.save', {
      name: 'ApexClass only, no managed packages',
      filter: { types: ['ApexClass'], excludeManagedPackages: true },
    });

    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'left', projectPath: tmpHome });
    // Reuse the same empty dir for both sides — this test only exercises
    // that a saved filter's `filter` value can be handed straight to
    // `comparisons.start`, not comparison semantics.
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'right', projectPath: tmpHome });

    const { comparisonId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: filterSet.filter,
    });
    expect(comparisonId).toBeTruthy();

    const row = await trpcQuery('comparisons.get', { comparisonId });
    const storedFilter = JSON.parse(row.filterJson);
    expect(storedFilter.types).toEqual(['ApexClass']);
    expect(storedFilter.excludeManagedPackages).toBe(true);
  });
});
