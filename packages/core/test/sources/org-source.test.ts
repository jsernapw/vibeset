import { rm, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@salesforce/core';
import { OrgSource, listAuthorizedOrgs, type FilePropertiesLike } from '../../src/sources/org-source.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

vi.mock('@salesforce/core', async () => {
  const actual = await vi.importActual<typeof import('@salesforce/core')>('@salesforce/core');
  return {
    ...actual,
    AuthInfo: {
      ...actual.AuthInfo,
      listAllAuthorizations: vi.fn(),
    },
  };
});

/** Builds a fake `Connection`-shaped object exposing only what `OrgSource` actually touches. */
function fakeConnection(
  listImpl: (queries: Array<{ type: string; folder?: string }>) => FilePropertiesLike[],
  overrides: Partial<{
    getApiVersion: () => string;
    identity: () => Promise<{ organization_id?: string; user_id?: string }>;
    limits: () => Promise<Record<string, { Max: number; Remaining: number }>>;
  }> = {},
): { connection: Connection; calls: Array<Array<{ type: string; folder?: string }>> } {
  const calls: Array<Array<{ type: string; folder?: string }>> = [];
  const connection = {
    getApiVersion: overrides.getApiVersion ?? (() => '62.0'),
    instanceUrl: 'https://example.my.salesforce.com',
    metadata: {
      list: async (queries: Array<{ type: string; folder?: string }>) => {
        calls.push(queries);
        return listImpl(queries);
      },
    },
    identity: overrides.identity ?? (async () => ({ organization_id: '00Dxx', user_id: '005xx' })),
    limits: overrides.limits ?? (async () => ({ DailyApiRequests: { Max: 15000, Remaining: 14000 } })),
  } as unknown as Connection;
  return { connection, calls };
}

describe('OrgSource.inventory', () => {
  it('batches listMetadata calls 3 queries per call for ordinary listable types', async () => {
    const { connection, calls } = fakeConnection((queries) =>
      queries.map((q) => ({ type: q.type, fullName: `${q.type}Foo`, lastModifiedDate: '2026-01-01T00:00:00.000Z' })),
    );
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const inventory = await source.inventory({
      types: ['ApexClass', 'ApexTrigger', 'CustomObject', 'ValidationRule', 'Flow'],
    });

    expect(calls.every((batch) => batch.length <= 3)).toBe(true);
    expect(calls.length).toBe(Math.ceil(5 / 3));
    expect(inventory.sourceId).toBe('org-1');
    expect(inventory.entries).toHaveLength(5);
    expect(inventory.entries[0]).toMatchObject({ lastModifiedDate: '2026-01-01T00:00:00.000Z' });
  });

  it('resolves folder-based types via the folder-container type, then per-folder, including unfiled$public', async () => {
    const { connection, calls } = fakeConnection((queries) =>
      queries.flatMap((q) => {
        if (q.type === 'ReportFolder') {
          return [{ type: 'ReportFolder', fullName: 'MyReportsFolder', lastModifiedDate: '2026-01-01T00:00:00.000Z' }];
        }
        if (q.type === 'Report' && q.folder === 'MyReportsFolder') {
          return [{ type: 'Report', fullName: 'MyReportsFolder/Report1', lastModifiedDate: '2026-01-02T00:00:00.000Z' }];
        }
        if (q.type === 'Report' && q.folder === 'unfiled$public') {
          return [{ type: 'Report', fullName: 'UnfiledReport', lastModifiedDate: '2026-01-03T00:00:00.000Z' }];
        }
        return [];
      }),
    );
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const inventory = await source.inventory({ types: ['Report'] });

    const folderQuery = calls.flat().find((q) => q.type === 'ReportFolder');
    expect(folderQuery).toBeDefined();
    const contentQueries = calls.flat().filter((q) => q.type === 'Report');
    expect(contentQueries.map((q) => q.folder).sort()).toEqual(['MyReportsFolder', 'unfiled$public']);

    const fullNames = inventory.entries.map((e) => e.key.fullName).sort();
    expect(fullNames).toEqual(['MyReportsFolder/Report1', 'UnfiledReport']);
    expect(inventory.folders).toEqual(expect.arrayContaining(['MyReportsFolder', 'unfiled$public']));
  });

  it('emits a single lastModifiedDateUnknown entry for non-listable singleton container types', async () => {
    const { connection, calls } = fakeConnection(() => []);
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const inventory = await source.inventory({ types: ['Settings'] });

    expect(calls).toHaveLength(0); // never called listMetadata for a non-listable type
    expect(inventory.entries).toEqual([
      { key: { type: 'Settings', fullName: 'Settings' }, lastModifiedDate: '', lastModifiedDateUnknown: true },
    ]);
  });

  it('enumerates StandardValueSet from SDR-shipped names, all flagged lastModifiedDateUnknown', async () => {
    const { connection } = fakeConnection(() => []);
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const inventory = await source.inventory({ types: ['StandardValueSet'] });

    expect(inventory.entries.length).toBeGreaterThan(50); // SDR ships ~140 names
    expect(inventory.entries.every((e) => e.lastModifiedDateUnknown)).toBe(true);
    expect(inventory.entries.some((e) => e.key.fullName === 'AccountContactRole')).toBe(true);
  });
});

describe('OrgSource.healthCheck', () => {
  it('reports ok with apiVersion, orgId, and normalized limits', async () => {
    const { connection } = fakeConnection(() => []);
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const result = await source.healthCheck();

    expect(result.ok).toBe(true);
    expect(result.apiVersion).toBe('62.0');
    expect(result.orgId).toBe('00Dxx');
    expect(result.limits?.DailyApiRequests).toEqual({ max: 15000, remaining: 14000 });
  });

  it('reports ok: false with the error message on failure, never throws', async () => {
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      {
        getConnection: async () => {
          throw new Error('invalid_grant: expired access/refresh token');
        },
      },
    );

    const result = await source.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired access/);
  });
});

describe('OrgSource.materialize', () => {
  it('returns an empty tree without touching the connection when keys is empty', async () => {
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      { getConnection: async () => { throw new Error('should not be called'); } },
    );
    const tree = await source.materialize([]);
    expect(tree.files.size).toBe(0);
  });

  it('runs one retrieveAndConvert per chunk and merges files/missing, respecting the concurrency cap', async () => {
    const { connection } = fakeConnection(() => []);
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: ComponentKey[][] = [];

    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      {
        getConnection: async () => connection,
        retrieveConcurrency: 2,
        chunking: { maxFiles: 1, maxBytes: Number.MAX_SAFE_INTEGER }, // force one component per chunk
        retrieveAndConvert: async (keys, destDir) => {
          calls.push(keys);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return {
            files: new Map([[`${keys[0]!.fullName}.cls`, `${destDir}/${keys[0]!.fullName}.cls`]]),
            missing: keys[0]!.fullName === 'Bad' ? [{ key: keys[0]!, reason: 'boom' }] : [],
          };
        },
      },
    );

    const keys: ComponentKey[] = [
      { type: 'ApexClass', fullName: 'A' },
      { type: 'ApexClass', fullName: 'B' },
      { type: 'ApexClass', fullName: 'Bad' },
    ];

    const tree = await source.materialize(keys);

    expect(calls).toHaveLength(3); // one chunk per component, forced by maxFiles: 1
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(tree.files.size).toBe(3);
    expect(tree.missing).toEqual([{ key: { type: 'ApexClass', fullName: 'Bad' }, reason: 'boom' }]);

    await rm(tree.rootDir, { recursive: true, force: true });
  });

  it('removes the temp root directory if a chunk fails', async () => {
    const { connection } = fakeConnection(() => []);
    let capturedRoot = '';
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      {
        getConnection: async () => connection,
        retrieveAndConvert: async (_keys, destDir) => {
          capturedRoot = destDir.split('/chunk-')[0]!;
          throw new Error('simulated retrieve failure');
        },
      },
    );

    await expect(source.materialize([{ type: 'ApexClass', fullName: 'A' }])).rejects.toThrow('simulated retrieve failure');
    expect(capturedRoot).not.toBe('');
    await expect(stat(capturedRoot)).rejects.toThrow();
  });
});

describe('listAuthorizedOrgs', () => {
  it('maps AuthInfo.listAllAuthorizations results, filtering out errored entries', async () => {
    const { AuthInfo } = await import('@salesforce/core');
    vi.mocked(AuthInfo.listAllAuthorizations).mockResolvedValue([
      {
        orgId: '00Dxx',
        username: 'dev@example.com',
        oauthMethod: 'web',
        aliases: ['dev'],
        configs: null,
        isSandbox: false,
        isScratchOrg: false,
        instanceUrl: 'https://example.my.salesforce.com',
        isExpired: false,
      },
      {
        orgId: '00Dyy',
        username: 'broken@example.com',
        oauthMethod: 'web',
        aliases: null,
        configs: null,
        error: 'no longer authenticated',
        isExpired: 'unknown',
      },
    ] as never);

    const orgs = await listAuthorizedOrgs();

    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ username: 'dev@example.com', orgId: '00Dxx', alias: 'dev' });
  });
});
