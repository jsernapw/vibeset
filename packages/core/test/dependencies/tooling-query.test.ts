import { describe, expect, it } from 'vitest';
import {
  filterEdgesByNamespace,
  queryAllToolingRecords,
  queryOrgDependencyEdges,
  type MetadataComponentDependencyRecord,
  type ToolingQueryClient,
  type ToolingQueryPage,
} from '../../src/dependencies/tooling-query.js';

function record(overrides: Partial<MetadataComponentDependencyRecord> = {}): MetadataComponentDependencyRecord {
  return {
    MetadataComponentId: '01p000000000001',
    MetadataComponentType: 'ApexClass',
    MetadataComponentName: 'Foo',
    MetadataComponentNamespace: null,
    RefMetadataComponentId: '01p000000000002',
    RefMetadataComponentType: 'ApexClass',
    RefMetadataComponentName: 'Bar',
    RefMetadataComponentNamespace: null,
    ...overrides,
  };
}

/** A fake `ToolingQueryClient` that serves pre-baked pages, recording every `query`/`queryMore` call made against it — mirrors `org-source.test.ts`'s `fakeConnection` pattern. */
function fakeClient(pages: ToolingQueryPage<MetadataComponentDependencyRecord>[]): {
  client: ToolingQueryClient;
  queryCalls: string[];
  queryMoreCalls: string[];
} {
  const queryCalls: string[] = [];
  const queryMoreCalls: string[] = [];
  let nextPageIndex = 1;
  const client: ToolingQueryClient = {
    async query(soql: string) {
      queryCalls.push(soql);
      return pages[0] as any;
    },
    async queryMore(url: string) {
      queryMoreCalls.push(url);
      const page = pages[nextPageIndex];
      nextPageIndex += 1;
      return page as any;
    },
  };
  return { client, queryCalls, queryMoreCalls };
}

describe('queryOrgDependencyEdges', () => {
  it('converts a single-page result into org-provenance edges', async () => {
    const { client, queryCalls } = fakeClient([
      { records: [record()], done: true, totalSize: 1 },
    ]);

    const edges = await queryOrgDependencyEdges(client);

    expect(edges).toEqual([
      {
        fromType: 'ApexClass',
        fromFullName: 'Foo',
        toType: 'ApexClass',
        toFullName: 'Bar',
        provenance: 'org',
        fromNamespace: undefined,
        toNamespace: undefined,
      },
    ]);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toContain('FROM MetadataComponentDependency');
    expect(queryCalls[0]).not.toContain('WHERE');
  });

  it('pages through queryMore until done, accumulating every record across pages', async () => {
    const { client, queryMoreCalls } = fakeClient([
      { records: [record({ MetadataComponentName: 'Page1A' })], done: false, nextRecordsUrl: '/page2', totalSize: 3 },
      { records: [record({ MetadataComponentName: 'Page2A' })], done: false, nextRecordsUrl: '/page3', totalSize: 3 },
      { records: [record({ MetadataComponentName: 'Page3A' })], done: true, totalSize: 3 },
    ]);

    const edges = await queryOrgDependencyEdges(client);

    expect(edges.map((e) => e.fromFullName)).toEqual(['Page1A', 'Page2A', 'Page3A']);
    expect(queryMoreCalls).toEqual(['/page2', '/page3']);
  });

  it('scopes the SOQL with a WHERE clause when fromTypes is given, and escapes single quotes', async () => {
    const { client, queryCalls } = fakeClient([{ records: [], done: true, totalSize: 0 }]);

    await queryOrgDependencyEdges(client, { fromTypes: ["Bob's ApexClass", 'Layout'] });

    expect(queryCalls[0]).toContain("WHERE MetadataComponentType IN ('Bob\\'s ApexClass', 'Layout')");
  });

  it('reports each page via onPage with a running total', async () => {
    const { client } = fakeClient([
      { records: [record(), record()], done: false, nextRecordsUrl: '/page2', totalSize: 3 },
      { records: [record()], done: true, totalSize: 3 },
    ]);
    const pageReports: Array<[number, number | undefined]> = [];

    await queryOrgDependencyEdges(client, { onPage: (n, total) => pageReports.push([n, total]) });

    expect(pageReports).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });

  it('normalizes empty-string and null namespaces to undefined, preserving a real namespace', async () => {
    const { client } = fakeClient([
      {
        records: [
          record({ MetadataComponentNamespace: '', RefMetadataComponentNamespace: 'omnistudio' }),
        ],
        done: true,
      },
    ]);

    const [edge] = await queryOrgDependencyEdges(client);

    expect(edge!.fromNamespace).toBeUndefined();
    expect(edge!.toNamespace).toBe('omnistudio');
  });
});

describe('filterEdgesByNamespace', () => {
  const namespaced = {
    fromType: 'ApexClass',
    fromFullName: 'omnistudio__Foo',
    toType: 'ApexClass',
    toFullName: 'omnistudio__Bar',
    provenance: 'org' as const,
    fromNamespace: 'omnistudio',
    toNamespace: 'omnistudio',
  };
  const plain = {
    fromType: 'ApexClass',
    fromFullName: 'MyClass',
    toType: 'ApexClass',
    toFullName: 'OtherClass',
    provenance: 'org' as const,
  };
  const mixed = {
    fromType: 'ApexClass',
    fromFullName: 'MyClass',
    toType: 'ApexClass',
    toFullName: 'omnistudio__Bar',
    provenance: 'org' as const,
    toNamespace: 'omnistudio',
  };

  it('excludes any edge touching a managed-package namespace when excludeManagedPackages is set', () => {
    const result = filterEdgesByNamespace([namespaced, plain, mixed], { excludeManagedPackages: true });
    expect(result).toEqual([plain]);
  });

  it('excludes only edges touching an explicitly named namespace', () => {
    const result = filterEdgesByNamespace([namespaced, plain, mixed], { excludeNamespaces: ['omnistudio'] });
    expect(result).toEqual([plain]);
  });

  it('is a no-op when no exclusion options are given', () => {
    const result = filterEdgesByNamespace([namespaced, plain, mixed], {});
    expect(result).toEqual([namespaced, plain, mixed]);
  });
});

describe('queryAllToolingRecords', () => {
  it('returns every record from a single-page result', async () => {
    const client: ToolingQueryClient = {
      query: async () => ({ records: [{ Id: '1' }, { Id: '2' }], done: true }),
      queryMore: async () => {
        throw new Error('should not be called');
      },
    };

    const records = await queryAllToolingRecords<{ Id: string }>(client, 'SELECT Id FROM ApexClass');

    expect(records).toEqual([{ Id: '1' }, { Id: '2' }]);
  });

  it('pages via queryMore until done, accumulating records across every page (the same paging OrgSource.orgContext relies on for ApexClass/ApexTrigger/ApexCodeCoverageAggregate)', async () => {
    const pages: Record<string, ToolingQueryPage<{ Id: string }>> = {
      first: { records: [{ Id: '1' }], done: false, nextRecordsUrl: 'page2' },
      page2: { records: [{ Id: '2' }], done: false, nextRecordsUrl: 'page3' },
      page3: { records: [{ Id: '3' }], done: true },
    };
    const client: ToolingQueryClient = {
      query: async () => pages.first!,
      queryMore: async (url: string) => pages[url]!,
    };

    const records = await queryAllToolingRecords<{ Id: string }>(client, 'SELECT Id FROM ApexClass');

    expect(records.map((r) => r.Id)).toEqual(['1', '2', '3']);
  });

  it('returns an empty array for a zero-row result (a real, valid state — not an error)', async () => {
    const client: ToolingQueryClient = {
      query: async () => ({ records: [], done: true }),
      queryMore: async () => {
        throw new Error('should not be called');
      },
    };

    const records = await queryAllToolingRecords(client, 'SELECT PercentCovered FROM ApexOrgWideCoverage');

    expect(records).toEqual([]);
  });
});
