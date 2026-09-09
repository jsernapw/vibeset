import { describe, expect, it } from 'vitest';
import {
  buildAnalyzerDependencyGraph,
  defaultExistenceCheckTypes,
} from '../../src/dependencies/analyzer-graph-adapter.js';
import { InMemoryDependencyGraph } from '../../src/dependencies/graph.js';
import type { DependencyEdge } from '../../src/dependencies/types.js';
import type { ComponentInventory, ComponentKey, MetadataSource, TypeFilter } from '../../src/types/metadata-source.js';

function edge(fromType: string, fromFullName: string, toType: string, toFullName: string): DependencyEdge {
  return { fromType, fromFullName, toType, toFullName, provenance: 'org' };
}

/** Minimal fake `MetadataSource.inventory()` — a fixed, per-type roster of "what the target org actually has", exactly what a real `listMetadata` call for one type returns (a COMPLETE listing for that type). */
function fakeInventorySource(byType: Record<string, string[]>): { source: Pick<MetadataSource, 'inventory'>; calls: TypeFilter[] } {
  const calls: TypeFilter[] = [];
  return {
    calls,
    source: {
      async inventory(filter: TypeFilter): Promise<ComponentInventory> {
        calls.push(filter);
        const entries = (filter.types ?? []).flatMap((type) =>
          (byType[type] ?? []).map((fullName) => ({ key: { type, fullName }, lastModifiedDate: '2026-01-01T00:00:00.000Z' })),
        );
        return { sourceId: 'target-org', entries };
      },
    },
  };
}

describe('defaultExistenceCheckTypes', () => {
  it('includes both PERMISSION_COLLECTIONS-derived types and the hand-maintained dependency-rules target types, deduplicated', () => {
    const types = defaultExistenceCheckTypes();
    expect(types).toEqual([...new Set(types)]); // no duplicates
    expect(types).toContain('CustomField');
    expect(types).toContain('RecordType');
    expect(types).toContain('ApexClass');
    // PERMISSION_COLLECTIONS-derived (permission-rules.ts's RELEVANT_TAGS refTypes)
    expect(types).toContain('CustomObject');
    expect(types).toContain('CustomTab');
    expect(types).toContain('CustomApplication');
    expect(types).toContain('Flow');
  });
});

describe('buildAnalyzerDependencyGraph — existsInTarget', () => {
  it('confirms presence for a type it queried, where the name IS in the target inventory', async () => {
    const edgeSource = new InMemoryDependencyGraph([]);
    const { source } = fakeInventorySource({ CustomField: ['Account.Existing__c'] });

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, {
      edgeScopeKeys: [],
      existenceCheckTypes: ['CustomField'],
    });

    expect(graph.existsInTarget({ type: 'CustomField', fullName: 'Account.Existing__c' })).toBe(true);
  });

  it('confirms ABSENCE (false, not undefined) for a type it queried, where the name is NOT in the target inventory — this is the "confirmed absent" case a missing-dependency rule needs', async () => {
    const edgeSource = new InMemoryDependencyGraph([]);
    const { source } = fakeInventorySource({ CustomField: ['Account.Existing__c'] });

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, {
      edgeScopeKeys: [],
      existenceCheckTypes: ['CustomField'],
    });

    expect(graph.existsInTarget({ type: 'CustomField', fullName: 'Account.Missing__c' })).toBe(false);
  });

  it('answers undefined ("unknown") — NEVER false — for a type that was never queried, regardless of the target inventory contents', async () => {
    const edgeSource = new InMemoryDependencyGraph([]);
    const { source } = fakeInventorySource({ CustomField: ['Account.Existing__c'] });

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, {
      edgeScopeKeys: [],
      existenceCheckTypes: ['CustomField'], // ApexClass never included
    });

    expect(graph.existsInTarget({ type: 'ApexClass', fullName: 'AnythingAtAll' })).toBeUndefined();
  });

  it('an empty existenceCheckTypes[] disables existence checking entirely: every answer is undefined and no inventory call is made', async () => {
    const edgeSource = new InMemoryDependencyGraph([]);
    const { source, calls } = fakeInventorySource({ CustomField: ['Account.Existing__c'] });

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, {
      edgeScopeKeys: [],
      existenceCheckTypes: [],
    });

    expect(graph.existsInTarget({ type: 'CustomField', fullName: 'Account.Existing__c' })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('defaults to defaultExistenceCheckTypes() when existenceCheckTypes is omitted', async () => {
    const edgeSource = new InMemoryDependencyGraph([]);
    const { source, calls } = fakeInventorySource({ ApexClass: ['MyAction'] });

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, { edgeScopeKeys: [] });

    expect(graph.existsInTarget({ type: 'ApexClass', fullName: 'MyAction' })).toBe(true);
    expect(calls[0]?.types).toEqual(expect.arrayContaining(defaultExistenceCheckTypes()));
  });
});

describe('buildAnalyzerDependencyGraph — dependenciesOf/dependentsOf', () => {
  const layout: ComponentKey = { type: 'Layout', fullName: 'Account-Account Layout' };
  const apexClass: ComponentKey = { type: 'ApexClass', fullName: 'Referenced' };
  const unrelated: ComponentKey = { type: 'ApexClass', fullName: 'NeverInScope' };

  it('pre-materializes forward edges for every key in edgeScopeKeys', async () => {
    const edgeSource = new InMemoryDependencyGraph([edge('Layout', 'Account-Account Layout', 'ApexClass', 'Referenced')]);
    const { source } = fakeInventorySource({});

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, { edgeScopeKeys: [layout] });

    expect(graph.dependenciesOf(layout)).toEqual([apexClass]);
  });

  it('pre-materializes reverse edges for every key in edgeScopeKeys (the destructive-change delete-safety direction)', async () => {
    const edgeSource = new InMemoryDependencyGraph([edge('Layout', 'Account-Account Layout', 'ApexClass', 'Referenced')]);
    const { source } = fakeInventorySource({});

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, { edgeScopeKeys: [apexClass] });

    expect(graph.dependentsOf(apexClass)).toEqual([layout]);
  });

  it('returns [] for a key that was never included in edgeScopeKeys, rather than throwing or fetching lazily', async () => {
    const edgeSource = new InMemoryDependencyGraph([edge('Layout', 'Account-Account Layout', 'ApexClass', 'Referenced')]);
    const { source } = fakeInventorySource({});

    const graph = await buildAnalyzerDependencyGraph(edgeSource, source, { edgeScopeKeys: [layout] });

    expect(graph.dependenciesOf(unrelated)).toEqual([]);
    expect(graph.dependentsOf(unrelated)).toEqual([]);
  });
});
