import { rm, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@salesforce/core';
import { OrgSource, convertWithIsolation, listAuthorizedOrgs, type FilePropertiesLike } from '../../src/sources/org-source.js';
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

  it('isolates a type unsupported by the org (INVALID_TYPE) instead of losing the whole batched listMetadata call', async () => {
    // Regression test for a real-org finding (RCA DEV/ARM DEV): SOAP's
    // metadata.list batches up to 3 queries per call, but the call is
    // all-or-nothing — one type the org's edition/feature set doesn't
    // support (e.g. `Translations` without Translation Workbench enabled)
    // throws `INVALID_TYPE` for the ENTIRE batch, silently losing the other
    // 1-2 types that would have succeeded in the same call unless the
    // source retries them individually.
    const warnings: string[] = [];
    const connection = {
      getApiVersion: () => '62.0',
      instanceUrl: 'https://example.my.salesforce.com',
      metadata: {
        list: async (queries: Array<{ type: string; folder?: string }>) => {
          if (queries.some((q) => q.type === 'Translations')) {
            throw new Error('INVALID_TYPE: Cannot use: Translations in this organization');
          }
          return queries.map((q) => ({ type: q.type, fullName: `${q.type}Foo`, lastModifiedDate: '2026-01-01T00:00:00.000Z' }));
        },
      },
      identity: async () => ({ organization_id: '00Dxx', user_id: '005xx' }),
      limits: async () => ({}),
    } as unknown as Connection;

    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      { getConnection: async () => connection, onWarning: (w) => warnings.push(w) },
    );

    // Same batch of 3 the real failure came from: two ordinary types plus
    // the unsupported one, so the fix must isolate a single bad query
    // without dropping its batch-mates.
    const inventory = await source.inventory({ types: ['ApexClass', 'Translations', 'CustomLabels'] });

    const fullNames = inventory.entries.map((e) => e.key.fullName);
    expect(fullNames).toContain('ApexClassFoo');
    // CustomLabels is a non-listable singleton (handled separately, never
    // goes through listMetadata) so it always appears regardless.
    expect(fullNames).toContain('CustomLabels');
    expect(fullNames).not.toContain('TranslationsFoo');
    expect(warnings.some((w) => w.includes('Translations') && w.includes('zero components'))).toBe(true);
  });

  // Regression coverage for the confirmed Workstream C bug: `OrgSource.inventory()`
  // resolved `filter.types` (via `resolveInventoryTypes`) but never consulted
  // `namePatterns`/`modifiedSince`/`modifiedBy`/`excludeNamespaces`/
  // `excludeManagedPackages` at all, so an excluded component still became an
  // inventory entry and still reached a retrieve chunk — the actual reason a
  // corrupt `omnistudio__` StaticResource could break a whole comparison even
  // with `excludeNamespaces: ['omnistudio']` set. Every test below asserts the
  // excluded component never appears in `inventory().entries` in the first
  // place (not just "gets filtered out later"), which is what keeps it out of
  // `RetrievalPlanner`'s `toFetch`/chunks — see `retrieval/planner.ts`, which
  // builds its plan entirely from `source.inventory(filter)`'s return value.
  describe('pre-retrieve filtering (namePatterns / modifiedSince / modifiedBy / excludeNamespaces / excludeManagedPackages)', () => {
    it('applies namePatterns before an entry is ever added to the inventory', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({ type: q.type, fullName: q.type === 'ApexClass' ? 'FooController' : 'BarController', lastModifiedDate: '2026-01-01T00:00:00.000Z' })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['ApexClass'], namePatterns: ['Bar*'] });

      expect(inventory.entries).toHaveLength(0);
    });

    it('applies modifiedSince before an entry is ever added to the inventory', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({ type: q.type, fullName: `${q.type}Foo`, lastModifiedDate: '2020-01-01T00:00:00.000Z' })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['ApexClass'], modifiedSince: '2026-01-01T00:00:00.000Z' });

      expect(inventory.entries).toHaveLength(0);
    });

    it('applies modifiedBy against lastModifiedByName before an entry is ever added to the inventory', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({
          type: q.type,
          fullName: `${q.type}Foo`,
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
          lastModifiedByName: 'alice@example.com',
        })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const excluded = await source.inventory({ types: ['ApexClass'], modifiedBy: ['bob@example.com'] });
      expect(excluded.entries).toHaveLength(0);

      const included = await source.inventory({ types: ['ApexClass'], modifiedBy: ['alice@example.com'] });
      expect(included.entries).toHaveLength(1);
    });

    it('THE CONFIRMED BUG: excludeNamespaces keeps a namespaced component out of the inventory entirely, using listMetadata\'s own namespacePrefix — not fullName parsing', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({
          type: q.type,
          fullName: 'CorruptResource', // deliberately does NOT look namespaced by fullName alone
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
          namespacePrefix: 'omnistudio',
          manageableState: 'installed',
        })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['StaticResource'], excludeNamespaces: ['omnistudio'] });

      // Never even reaches `entries` — this is what keeps a retrieve chunk
      // (and, in the real bug, a BadZipFile-throwing convert) from ever
      // being built for this component.
      expect(inventory.entries).toHaveLength(0);
    });

    it('excludeManagedPackages excludes an installed managed-package component but keeps an unmanaged one', async () => {
      // A single `listMetadata` query for one type can return MANY
      // components — simulate ARM DEV's real shape (a mix of `omnistudio__`
      // managed classes and plain unmanaged ones in the SAME response).
      const { connection } = fakeConnection((queries) =>
        queries.flatMap((q) => [
          {
            type: q.type,
            fullName: 'omnistudio__Managed',
            lastModifiedDate: '2026-01-01T00:00:00.000Z',
            namespacePrefix: 'omnistudio',
            manageableState: 'installed',
          },
          {
            type: q.type,
            fullName: 'PlainClass',
            lastModifiedDate: '2026-01-01T00:00:00.000Z',
            namespacePrefix: '',
            manageableState: 'unmanaged',
          },
        ]),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['ApexClass'], excludeManagedPackages: true });

      expect(inventory.entries).toHaveLength(1);
      expect(inventory.entries[0]?.key.fullName).toBe('PlainClass');
    });

    it('excludeManagedPackages does NOT exclude the org\'s own namespaced-but-unmanaged metadata (a packaging/dev org)', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({
          type: q.type,
          fullName: 'myns__DevClass',
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
          namespacePrefix: 'myns',
          manageableState: 'unmanaged',
        })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['ApexClass'], excludeManagedPackages: true });

      expect(inventory.entries).toHaveLength(1);
      expect(inventory.entries[0]?.key.fullName).toBe('myns__DevClass');
    });

    it('records namespacePrefix on entries that are NOT excluded, for UI labeling', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.map((q) => ({
          type: q.type,
          fullName: 'omnistudio__Kept',
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
          namespacePrefix: 'omnistudio',
          manageableState: 'installed',
        })),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      // Explicitly opted IN to managed packages — no exclusion.
      const inventory = await source.inventory({ types: ['ApexClass'] });

      expect(inventory.entries).toHaveLength(1);
      expect(inventory.entries[0]?.namespacePrefix).toBe('omnistudio');
    });

    it('applies excludeNamespaces to folder-based type content (Report/Dashboard/EmailTemplate/Document), not just ordinary listable types', async () => {
      const { connection } = fakeConnection((queries) =>
        queries.flatMap((q) => {
          if (q.type === 'ReportFolder') {
            return [{ type: 'ReportFolder', fullName: 'MyReportsFolder', lastModifiedDate: '2026-01-01T00:00:00.000Z' }];
          }
          if (q.type === 'Report' && q.folder === 'MyReportsFolder') {
            return [
              {
                type: 'Report',
                fullName: 'MyReportsFolder/OmniReport',
                lastModifiedDate: '2026-01-02T00:00:00.000Z',
                namespacePrefix: 'omnistudio',
                manageableState: 'installed',
              },
            ];
          }
          return [];
        }),
      );
      const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

      const inventory = await source.inventory({ types: ['Report'], excludeManagedPackages: true });

      expect(inventory.entries.map((e) => e.key.fullName)).not.toContain('MyReportsFolder/OmniReport');
    });
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

  it('isolates a single bad component in a multi-key chunk (BadZipFile-style conversion failure) instead of losing the whole chunk', async () => {
    // Regression test for a real-org finding (ARM DEV): a StaticResource
    // whose real bytes weren't a valid zip made SDR's conversion throw for
    // the ENTIRE retrieve chunk, not just that component. Same "isolate
    // and retry" shape as `listMetadataBatch`'s test, but via bisection
    // since a materialize chunk can be much larger than 3.
    const warnings: string[] = [];
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      {
        getConnection: async () => fakeConnection(() => []).connection,
        chunking: { maxFiles: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }, // force everything into one chunk
        onWarning: (w) => warnings.push(w),
        retrieveAndConvert: async (keys, destDir) => {
          if (keys.some((k) => k.fullName === 'Bad')) {
            throw new Error('BadZipFile: Unable to open zip file');
          }
          return {
            files: new Map(keys.map((k) => [`${k.fullName}.resource`, `${destDir}/${k.fullName}.resource`])),
            missing: [],
          };
        },
      },
    );

    const keys: ComponentKey[] = [
      { type: 'StaticResource', fullName: 'A' },
      { type: 'StaticResource', fullName: 'B' },
      { type: 'StaticResource', fullName: 'Bad' },
      { type: 'StaticResource', fullName: 'C' },
      { type: 'StaticResource', fullName: 'D' },
    ];

    const tree = await source.materialize(keys);

    // The 4 good components still materialize despite Bad's conversion failure.
    expect(tree.files.size).toBe(4);
    expect(tree.missing).toEqual([{ key: { type: 'StaticResource', fullName: 'Bad' }, reason: 'BadZipFile: Unable to open zip file' }]);
    expect(warnings.some((w) => w.includes('Bad') && w.includes('missing'))).toBe(true);

    await rm(tree.rootDir, { recursive: true, force: true });
  });

  it('still fails the whole materialize call when a chunk failure is systemic (every component fails, not just one)', async () => {
    // Safety-valve test: a naive "isolate every failure as missing" design
    // would silently report the ENTIRE chunk as missing during a real
    // outage (expired session, network down) instead of surfacing it as
    // the connection failure it is — exactly the "fabricated/misleading
    // data" failure mode this project treats as unacceptable. The
    // MAX_ISOLATED_FAILURES_PER_CHUNK budget bounds how much can be
    // silently swallowed before this rethrows instead.
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      {
        getConnection: async () => fakeConnection(() => []).connection,
        chunking: { maxFiles: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER },
        retrieveAndConvert: async () => {
          throw new Error('INVALID_SESSION_ID: Session expired or invalid');
        },
      },
    );

    const keys: ComponentKey[] = Array.from({ length: 20 }, (_, i) => ({ type: 'StaticResource', fullName: `R${i}` }));

    await expect(source.materialize(keys)).rejects.toThrow('INVALID_SESSION_ID');
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

describe('convertWithIsolation', () => {
  // Phase 2 Workstream D: this is the extracted, directly-testable body of
  // OrgSource's local conversion-failure isolation — the fix for the
  // confirmed root cause of the 33-type default's >13-minute real-org run
  // (bisecting at the retrieveAndConvert/network level instead of the
  // local convert level; see org-source.ts's doc comments). These tests
  // never touch SDR, a ComponentSet, or a Connection — `convertFn` is a
  // plain fake, same style as `materialize()`'s injected `retrieveAndConvert`
  // tests above.

  function key(fullName: string): ComponentKey {
    return { type: 'StaticResource', fullName };
  }

  it('converts everything in one call when nothing fails', async () => {
    const items = ['A', 'B', 'C'];
    const calls: string[][] = [];
    const convertFn = async (batch: readonly string[]) => {
      calls.push([...batch]);
    };

    const missing = await convertWithIsolation(items, convertFn, key, 'Test Org', undefined);

    expect(missing).toEqual([]);
    expect(calls).toEqual([['A', 'B', 'C']]); // exactly one call — the common case is unaffected
  });

  it('isolates a single bad item via bisection without losing the good ones, and never calls back with more than the failing subset', async () => {
    const items = ['A', 'Bad', 'C', 'D'];
    const convertCalls: string[][] = [];
    const convertFn = async (batch: readonly string[]) => {
      convertCalls.push([...batch]);
      if (batch.includes('Bad')) throw new Error('BadZipFile: Unable to open zip file');
    };
    const warnings: string[] = [];

    const missing = await convertWithIsolation(items, convertFn, key, 'Test Org', (m) => warnings.push(m));

    expect(missing).toEqual([{ key: key('Bad'), reason: 'BadZipFile: Unable to open zip file' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bad');
    expect(warnings[0]).toContain('isolated locally');
    // Bisection, not linear retry: never re-attempts the full failing set
    // beyond what's needed to narrow down to the single bad item.
    expect(convertCalls.length).toBeLessThan(items.length * 2);
  });

  it('stays cheap under DENSE failures — the real-org shape (~20-30% of 200 StaticResources) that made retrieve-level bisection catastrophic', async () => {
    // Mirrors the confirmed ARM DEV finding (60-70 BadZipFile failures out
    // of 200 StaticResources): convertFn NEVER simulates a network call, so
    // even at ~20% failure density (kept under this budget so the test
    // asserts the "resolves, doesn't throw" case; the budget-exhaustion
    // case is its own test below) this must resolve in a bounded number of
    // calls, not "materialize() hangs for minutes."
    const n = 200;
    const failRate = 0.2;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const items = Array.from({ length: n }, (_, i) => `C${i}`);
    const failing = new Set(items.filter(() => rand() < failRate));

    let convertCalls = 0;
    const convertFn = async (batch: readonly string[]) => {
      convertCalls += 1;
      if (batch.some((b) => failing.has(b))) throw new Error('BadZipFile');
    };

    const missing = await convertWithIsolation(items, convertFn, key, 'ARM DEV', undefined);

    // Every item reported missing really was one of the failing ones (no
    // good component ever gets dropped), and the count never exceeds what
    // actually failed.
    for (const m of missing) expect(failing.has(m.key.fullName)).toBe(true);
    expect(missing.length).toBeLessThanOrEqual(failing.size);
    // The whole point of the fix: this used to mean ~250+ REAL Salesforce
    // Retrieve+poll round trips (minutes); here, with zero network
    // involved, it's just an assertion that call count stays bounded and
    // the test itself completes near-instantly (no `sleep`, no real I/O).
    expect(convertCalls).toBeGreaterThan(1);
    expect(convertCalls).toBeLessThan(n * 2);
  });

  it('still throws (fails loudly) once the proportional failure budget is exhausted by a systemic failure — same safety net as before, not silently swallowed', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const convertFn = async () => {
      throw new Error('simulated systemic outage'); // every item fails, always
    };

    await expect(convertWithIsolation(items, convertFn, key, 'Test Org', undefined)).rejects.toThrow('simulated systemic outage');
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

/**
 * `orgContext()` builds `OrgContext` from four independent, read-only
 * queries — see the method's own doc comment for why each is fetched
 * independently and left `undefined` (never guessed) on its own failure.
 * This fake `Connection` exposes exactly `query` (plain SOQL, for
 * `Organization`), `tooling.query`/`tooling.queryMore` (paged Tooling API
 * SOQL, for the other three), and `getApiVersion` — nothing else `OrgSource`
 * touches for this method.
 */
function fakeOrgContextConnection(overrides: {
  query?: (soql: string) => Promise<{ records: unknown[] }>;
  toolingQuery?: Record<string, { records: unknown[]; done?: boolean; nextRecordsUrl?: string }>;
  getApiVersion?: () => string;
} = {}): Connection {
  const toolingQuery = overrides.toolingQuery ?? {};
  return {
    getApiVersion: overrides.getApiVersion ?? (() => '62.0'),
    query: overrides.query ?? (async () => ({ records: [] })),
    tooling: {
      query: async (soql: string) => {
        const page = toolingQuery[soql];
        if (!page) return { records: [], done: true };
        return { records: page.records, done: page.done ?? true, nextRecordsUrl: page.nextRecordsUrl };
      },
      queryMore: async (url: string) => {
        const page = Object.values(toolingQuery).find((p) => p.nextRecordsUrl === url);
        if (!page) return { records: [], done: true };
        return { records: page.records, done: true };
      },
    },
  } as unknown as Connection;
}

describe('OrgSource.orgContext', () => {
  it('builds a full OrgContext from Organization + ApexOrgWideCoverage + ApexClass/ApexTrigger + ApexCodeCoverageAggregate', async () => {
    const connection = fakeOrgContextConnection({
      query: async (soql) => {
        expect(soql).toContain('FROM Organization');
        return { records: [{ Id: '00Dxx0000012345', IsSandbox: false, OrganizationType: 'Developer Edition' }] };
      },
      toolingQuery: {
        'SELECT PercentCovered FROM ApexOrgWideCoverage': { records: [{ PercentCovered: 42 }] },
        'SELECT Id, Name FROM ApexClass': { records: [{ Id: '01p001', Name: 'MyClass' }] },
        'SELECT Id, Name FROM ApexTrigger': { records: [{ Id: '01q001', Name: 'MyTrigger' }] },
        'SELECT ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate': {
          records: [{ ApexClassOrTriggerId: '01p001', NumLinesCovered: 8, NumLinesUncovered: 2 }],
        },
      },
    });
    const source = new OrgSource('org-1', 'ARM DEV', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const context = await source.orgContext();

    expect(context).toMatchObject({
      orgId: '00Dxx0000012345',
      label: 'ARM DEV',
      organizationType: 'Developer Edition',
      isSandbox: false,
      orgWideCoveragePercent: 42,
      totalApexClassCount: 1,
      totalApexTriggerCount: 1,
      currentApiVersion: '62.0',
    });
    expect(context.apexCoverage?.get('MyClass')).toEqual({ percentCovered: 80, linesCovered: 8, linesUncovered: 2 });
  });

  it('an org that has never computed ApexOrgWideCoverage (zero rows) leaves orgWideCoveragePercent undefined, never 0', async () => {
    const connection = fakeOrgContextConnection({
      query: async () => ({ records: [{ Id: '00Dxx', IsSandbox: true, OrganizationType: 'Developer Edition' }] }),
      toolingQuery: {}, // every Tooling query returns zero rows
    });
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const context = await source.orgContext();

    expect(context.orgWideCoveragePercent).toBeUndefined();
    expect(context.totalApexClassCount).toBe(0);
  });

  it('a failing Organization query leaves orgId/isSandbox/organizationType undefined but does not fail the whole call — other fields still populate', async () => {
    const connection = fakeOrgContextConnection({
      query: async () => {
        throw new Error('simulated INVALID_TYPE fault');
      },
      toolingQuery: {
        'SELECT PercentCovered FROM ApexOrgWideCoverage': { records: [{ PercentCovered: 90 }] },
      },
    });
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const context = await source.orgContext();

    expect(context.orgId).toBeUndefined();
    expect(context.isSandbox).toBeUndefined();
    expect(context.organizationType).toBeUndefined();
    expect(context.orgWideCoveragePercent).toBe(90); // independent query, unaffected by the Organization failure
    expect(context.currentApiVersion).toBe('62.0'); // never touches a query at all
  });

  it('a failing Tooling query (ApexClass/ApexTrigger/ApexCodeCoverageAggregate) leaves those fields undefined without throwing', async () => {
    const connection = fakeOrgContextConnection({
      query: async () => ({ records: [{ Id: '00Dxx', IsSandbox: false, OrganizationType: 'Production' }] }),
    });
    // Override tooling.query to throw for the ApexClass query specifically.
    (connection as unknown as { tooling: { query: unknown } }).tooling.query = async (soql: string) => {
      if (soql.includes('ApexClass')) throw new Error('simulated permission error');
      return { records: [], done: true };
    };
    const source = new OrgSource('org-1', 'Dev Org', { username: 'dev@example.com' }, { getConnection: async () => connection });

    const context = await source.orgContext();

    expect(context.totalApexClassCount).toBeUndefined();
    expect(context.totalApexTriggerCount).toBeUndefined();
    expect(context.apexCoverage).toBeUndefined();
    expect(context.isSandbox).toBe(false); // independent query, unaffected
  });

  it('reports failures via deps.onWarning rather than swallowing them silently', async () => {
    const connection = fakeOrgContextConnection({
      query: async () => {
        throw new Error('simulated fault');
      },
    });
    const warnings: string[] = [];
    const source = new OrgSource(
      'org-1',
      'Dev Org',
      { username: 'dev@example.com' },
      { getConnection: async () => connection, onWarning: (msg) => warnings.push(msg) },
    );

    await source.orgContext();

    expect(warnings.some((w) => w.includes('Organization'))).toBe(true);
  });
});
