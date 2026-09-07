import { describe, expect, it } from 'vitest';
import { GraphDependencyReferenceChecker, InMemoryDependencyGraph, transitiveImpact } from '../../src/dependencies/graph.js';
import type { DependencyEdge } from '../../src/dependencies/types.js';

function edge(fromType: string, fromFullName: string, toType: string, toFullName: string): DependencyEdge {
  return { fromType, fromFullName, toType, toFullName, provenance: 'org' };
}

describe('transitiveImpact', () => {
  it('walks forward: A -> B -> C finds both B and C from seed A, with correct depths', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'C'),
    ]);

    const result = await transitiveImpact(graph, [{ type: 'ApexClass', fullName: 'A' }], 'forward');

    expect(result.map((n) => [n.key.fullName, n.depth])).toEqual([
      ['B', 1],
      ['C', 2],
    ]);
  });

  it('walks reverse: what depends on C, given A -> B -> C, finds B and A from seed C', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'C'),
    ]);

    const result = await transitiveImpact(graph, [{ type: 'ApexClass', fullName: 'C' }], 'reverse');

    expect(result.map((n) => [n.key.fullName, n.depth])).toEqual([
      ['B', 1],
      ['A', 2],
    ]);
  });

  it('terminates on a cycle instead of looping forever, visiting each node once', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'A'), // cycle back to the seed
    ]);

    const result = await transitiveImpact(graph, [{ type: 'ApexClass', fullName: 'A' }], 'forward', { maxDepth: 10 });

    expect(result.map((n) => n.key.fullName)).toEqual(['B']);
  });

  it('respects maxDepth, not expanding beyond the bound', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'C'),
      edge('ApexClass', 'C', 'ApexClass', 'D'),
    ]);

    const result = await transitiveImpact(graph, [{ type: 'ApexClass', fullName: 'A' }], 'forward', { maxDepth: 2 });

    expect(result.map((n) => n.key.fullName)).toEqual(['B', 'C']);
  });

  it('supports multiple seeds, deduplicating a node reachable from more than one', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'Shared'),
      edge('ApexClass', 'B', 'ApexClass', 'Shared'),
    ]);

    const result = await transitiveImpact(
      graph,
      [{ type: 'ApexClass', fullName: 'A' }, { type: 'ApexClass', fullName: 'B' }],
      'forward',
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.key.fullName).toBe('Shared');
  });
});

describe('GraphDependencyReferenceChecker', () => {
  it('confirms a direct edge with certainty "confirmed" and a one-hop path', async () => {
    const graph = new InMemoryDependencyGraph([edge('ApexClass', 'A', 'ApexClass', 'B')]);
    const checker = new GraphDependencyReferenceChecker(graph);

    const answer = await checker.references({ type: 'ApexClass', fullName: 'A' }, { type: 'ApexClass', fullName: 'B' });

    expect(answer.certainty).toBe('confirmed');
    if (answer.certainty === 'confirmed') expect(answer.path).toHaveLength(1);
  });

  it('confirms a transitive reference within maxDepth, returning the full path', async () => {
    const graph = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'C'),
    ]);
    const checker = new GraphDependencyReferenceChecker(graph);

    const answer = await checker.references({ type: 'ApexClass', fullName: 'A' }, { type: 'ApexClass', fullName: 'C' });

    expect(answer.certainty).toBe('confirmed');
    if (answer.certainty === 'confirmed') {
      expect(answer.path.map((e) => e.toFullName)).toEqual(['B', 'C']);
    }
  });

  it('returns "no-recorded-edge" — NOT a false/negative — when nothing is found, including beyond maxDepth', async () => {
    const graph = new InMemoryDependencyGraph([edge('ApexClass', 'A', 'ApexClass', 'B')]);
    const checker = new GraphDependencyReferenceChecker(graph);

    const unrelated = await checker.references({ type: 'ApexClass', fullName: 'A' }, { type: 'ApexClass', fullName: 'Z' });
    expect(unrelated).toEqual({ certainty: 'no-recorded-edge' });

    const graph2 = new InMemoryDependencyGraph([
      edge('ApexClass', 'A', 'ApexClass', 'B'),
      edge('ApexClass', 'B', 'ApexClass', 'C'),
    ]);
    const shallow = await new GraphDependencyReferenceChecker(graph2).references(
      { type: 'ApexClass', fullName: 'A' },
      { type: 'ApexClass', fullName: 'C' },
      { maxDepth: 1 },
    );
    expect(shallow).toEqual({ certainty: 'no-recorded-edge' });
  });
});
