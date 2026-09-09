import { describe, expect, it } from 'vitest';
import type { ComponentKey, DependencyEdge } from '@vibeset/core';
import { buildGraphModel, type ImpactNodeLike } from '../src/lib/dependency-graph';

function edge(overrides: Partial<DependencyEdge> = {}): DependencyEdge {
  return {
    fromType: 'ApexClass',
    fromFullName: 'FooService',
    toType: 'ApexClass',
    toFullName: 'BarHelper',
    provenance: 'org',
    ...overrides,
  };
}

function node(key: ComponentKey, depth: number, viaEdge: DependencyEdge): ImpactNodeLike {
  return { key, depth, viaEdge };
}

const FOCUS: ComponentKey = { type: 'ApexClass', fullName: 'FooService' };

describe('buildGraphModel', () => {
  it('always includes the focus node even with no impact at all', () => {
    const model = buildGraphModel(FOCUS, [], []);
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]).toMatchObject({ role: 'focus', depth: 0, key: FOCUS });
    expect(model.edges).toHaveLength(0);
  });

  it('adds one node + one edge per forward-discovered component, with edges pointing the real dependency direction (focus -> dependency)', () => {
    const forward = [
      node(
        { type: 'ApexClass', fullName: 'BarHelper' },
        1,
        edge({ fromType: 'ApexClass', fromFullName: 'FooService', toType: 'ApexClass', toFullName: 'BarHelper', provenance: 'org' }),
      ),
    ];
    const model = buildGraphModel(FOCUS, forward, []);

    expect(model.nodes).toHaveLength(2);
    const helper = model.nodes.find((n) => n.key.fullName === 'BarHelper');
    expect(helper).toMatchObject({ role: 'forward', depth: 1 });

    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({
      source: 'ApexClass#FooService',
      target: 'ApexClass#BarHelper',
      provenance: 'org',
      discoveredVia: 'forward',
    });
  });

  it('for reverse-discovered nodes, the edge direction is still the real "A depends on B" direction, not the traversal direction', () => {
    // Reverse traversal found `Caller` because Caller -> FooService (Caller depends on Focus).
    const reverse = [
      node(
        { type: 'ApexClass', fullName: 'Caller' },
        1,
        edge({ fromType: 'ApexClass', fromFullName: 'Caller', toType: 'ApexClass', toFullName: 'FooService', provenance: 'org' }),
      ),
    ];
    const model = buildGraphModel(FOCUS, [], reverse);

    expect(model.edges[0]).toMatchObject({
      source: 'ApexClass#Caller',
      target: 'ApexClass#FooService',
      discoveredVia: 'reverse',
    });
  });

  it('preserves provenance and supplementKind on the built edge — never collapses org vs supplemented', () => {
    const forward = [
      node(
        { type: 'Layout', fullName: 'Account-Layout' },
        1,
        edge({
          fromType: 'ApexClass',
          fromFullName: 'FooService',
          toType: 'Layout',
          toFullName: 'Account-Layout',
          provenance: 'supplemented',
          supplementKind: 'layout-field-reference',
        }),
      ),
    ];
    const model = buildGraphModel(FOCUS, forward, []);
    expect(model.edges[0]).toMatchObject({ provenance: 'supplemented', supplementKind: 'layout-field-reference' });
  });

  it('caps nodes per direction and reports the truncated count without producing dangling edges', () => {
    // 5 depth-1 forward nodes, cap to 2 — the 3 dropped nodes' edges must
    // never appear (both node AND its edge disappear together).
    const forward = Array.from({ length: 5 }, (_, i) =>
      node(
        { type: 'ApexClass', fullName: `Dep${i}` },
        1,
        edge({ fromType: 'ApexClass', fromFullName: 'FooService', toType: 'ApexClass', toFullName: `Dep${i}`, provenance: 'org' }),
      ),
    );
    const model = buildGraphModel(FOCUS, forward, [], { maxNodesPerDirection: 2 });

    expect(model.nodes).toHaveLength(3); // focus + 2 kept
    expect(model.edges).toHaveLength(2);
    expect(model.truncatedForward).toBe(3);
    expect(model.totalDiscoveredForward).toBe(5);
    for (const e of model.edges) {
      expect(model.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(model.nodes.some((n) => n.id === e.target)).toBe(true);
    }
  });

  it('a multi-hop chain keeps every edge resolvable because ancestors are ingested before their descendants (BFS depth-ascending order)', () => {
    const forward = [
      node(
        { type: 'ApexClass', fullName: 'Mid' },
        1,
        edge({ fromType: 'ApexClass', fromFullName: 'FooService', toType: 'ApexClass', toFullName: 'Mid', provenance: 'org' }),
      ),
      node(
        { type: 'ApexClass', fullName: 'Leaf' },
        2,
        edge({ fromType: 'ApexClass', fromFullName: 'Mid', toType: 'ApexClass', toFullName: 'Leaf', provenance: 'org' }),
      ),
    ];
    const model = buildGraphModel(FOCUS, forward, []);

    expect(model.nodes.map((n) => n.key.fullName).sort()).toEqual(['FooService', 'Leaf', 'Mid']);
    expect(model.edges).toHaveLength(2);
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const e of model.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('the same component reached by both forward and reverse traversal is deduplicated to a single node (first-seen role wins)', () => {
    const target = { type: 'ApexClass', fullName: 'Shared' };
    const forward = [node(target, 1, edge({ toFullName: 'Shared', provenance: 'org' }))];
    const reverse = [node(target, 1, edge({ fromFullName: 'Shared', toFullName: 'FooService', provenance: 'org' }))];
    const model = buildGraphModel(FOCUS, forward, reverse);

    const sharedNodes = model.nodes.filter((n) => n.key.fullName === 'Shared');
    expect(sharedNodes).toHaveLength(1);
  });
});
