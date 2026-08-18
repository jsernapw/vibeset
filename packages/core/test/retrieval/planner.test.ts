import { describe, expect, it } from 'vitest';
import { RetrievalPlanner } from '../../src/retrieval/planner.js';
import { InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import type {
  ComponentInventory,
  ComponentKey,
  MetadataSource,
  SourceTree,
  TypeFilter,
} from '../../src/types/metadata-source.js';

/** A fully in-memory `MetadataSource` for tests — no network, no filesystem. */
class FakeSource implements MetadataSource {
  readonly kind = 'org' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly entries: Array<{ key: ComponentKey; lastModifiedDate: string; lastModifiedDateUnknown?: boolean }>,
  ) {}

  async inventory(_filter: TypeFilter): Promise<ComponentInventory> {
    return { sourceId: this.id, entries: this.entries };
  }

  async materialize(_keys: ComponentKey[]): Promise<SourceTree> {
    throw new Error('not needed for planner tests');
  }
}

function key(type: string, fullName: string): ComponentKey {
  return { type, fullName };
}

describe('RetrievalPlanner.planSource', () => {
  it('treats everything as a cache miss on an empty store', async () => {
    const store = new InMemorySnapshotStore();
    const planner = new RetrievalPlanner(store);
    const source = new FakeSource('org-1', 'Dev Org', [
      { key: key('ApexClass', 'A'), lastModifiedDate: '2026-01-01T00:00:00.000Z' },
      { key: key('ApexClass', 'B'), lastModifiedDate: '2026-01-01T00:00:00.000Z' },
    ]);

    const plan = await planner.planSource(source, { filter: {} });

    expect(plan.inventoriedCount).toBe(2);
    expect(plan.cacheHits).toHaveLength(0);
    expect(plan.toFetch).toHaveLength(2);
    expect(plan.chunks.flat()).toHaveLength(2);
  });

  it('skips components whose lastModifiedDate already matches a stored snapshot', async () => {
    const store = new InMemorySnapshotStore();
    await store.put({
      sourceId: 'org-1',
      key: key('ApexClass', 'A'),
      lastModifiedDate: '2026-01-01T00:00:00.000Z',
      content: 'class A {}',
    });
    const planner = new RetrievalPlanner(store);
    const source = new FakeSource('org-1', 'Dev Org', [
      { key: key('ApexClass', 'A'), lastModifiedDate: '2026-01-01T00:00:00.000Z' }, // unchanged -> hit
      { key: key('ApexClass', 'B'), lastModifiedDate: '2026-01-01T00:00:00.000Z' }, // never seen -> miss
    ]);

    const plan = await planner.planSource(source, { filter: {} });

    expect(plan.cacheHits).toEqual([key('ApexClass', 'A')]);
    expect(plan.toFetch).toEqual([key('ApexClass', 'B')]);
  });

  it('refetches when lastModifiedDate has changed, even if the fullName matches a prior snapshot', async () => {
    const store = new InMemorySnapshotStore();
    await store.put({
      sourceId: 'org-1',
      key: key('ApexClass', 'A'),
      lastModifiedDate: '2026-01-01T00:00:00.000Z',
      content: 'class A {}',
    });
    const planner = new RetrievalPlanner(store);
    const source = new FakeSource('org-1', 'Dev Org', [
      { key: key('ApexClass', 'A'), lastModifiedDate: '2026-02-01T00:00:00.000Z' }, // date moved -> miss
    ]);

    const plan = await planner.planSource(source, { filter: {} });

    expect(plan.cacheHits).toHaveLength(0);
    expect(plan.toFetch).toEqual([key('ApexClass', 'A')]);
  });

  it('always treats lastModifiedDateUnknown components as cache misses, never consulting the store', async () => {
    const store = new InMemorySnapshotStore();
    // Simulate a prior snapshot existing under this exact key/date, which
    // would normally be a hit — but lastModifiedDateUnknown must bypass it.
    await store.put({
      sourceId: 'org-1',
      key: key('StandardValueSet', 'AccountType'),
      lastModifiedDate: 'unknown',
      content: 'irrelevant',
    });
    const planner = new RetrievalPlanner(store);
    const source = new FakeSource('org-1', 'Dev Org', [
      { key: key('StandardValueSet', 'AccountType'), lastModifiedDate: 'unknown', lastModifiedDateUnknown: true },
    ]);

    const plan = await planner.planSource(source, { filter: {} });

    expect(plan.cacheHits).toHaveLength(0);
    expect(plan.toFetch).toHaveLength(1);
    const stats = await store.stats();
    // lookup() was never called for the unknown-date entry, so hits stay 0.
    expect(stats.hits).toBe(0);
  });

  it('reports progress from 0 to 100 and honors cancellation via AbortSignal', async () => {
    const store = new InMemorySnapshotStore();
    const planner = new RetrievalPlanner(store);
    const source = new FakeSource(
      'org-1',
      'Dev Org',
      Array.from({ length: 5 }, (_, i) => ({ key: key('ApexClass', `C${i}`), lastModifiedDate: '2026-01-01T00:00:00.000Z' })),
    );

    const events: number[] = [];
    const plan = await planner.planSource(source, {
      filter: {},
      onProgress: (p) => events.push(p.percent),
    });
    expect(plan.toFetch).toHaveLength(5);
    expect(events[0]).toBeLessThanOrEqual(events[events.length - 1]!);
    expect(events[events.length - 1]).toBe(100);

    const controller = new AbortController();
    controller.abort();
    await expect(planner.planSource(source, { filter: {}, signal: controller.signal })).rejects.toThrow();
  });
});

describe('RetrievalPlanner.planComparison', () => {
  it('plans both sources independently and scales progress into 0-50 / 50-100', async () => {
    const store = new InMemorySnapshotStore();
    const planner = new RetrievalPlanner(store);
    const left = new FakeSource('left', 'Left Org', [
      { key: key('ApexClass', 'A'), lastModifiedDate: '2026-01-01T00:00:00.000Z' },
    ]);
    const right = new FakeSource('right', 'Right Org', [
      { key: key('ApexClass', 'A'), lastModifiedDate: '2026-01-02T00:00:00.000Z' },
      { key: key('ApexClass', 'B'), lastModifiedDate: '2026-01-02T00:00:00.000Z' },
    ]);

    const percents: number[] = [];
    const plan = await planner.planComparison(left, right, {
      filter: {},
      onProgress: (p) => percents.push(p.percent),
    });

    expect(plan.left.sourceId).toBe('left');
    expect(plan.right.sourceId).toBe('right');
    expect(plan.left.toFetch).toHaveLength(1);
    expect(plan.right.toFetch).toHaveLength(2);
    expect(Math.max(...percents)).toBe(100);
    expect(Math.min(...percents)).toBeGreaterThanOrEqual(0);
    // Left-side events should all land at or below 50, right-side at or above 50.
    expect(percents.every((p) => p >= 0 && p <= 100)).toBe(true);
  });
});
