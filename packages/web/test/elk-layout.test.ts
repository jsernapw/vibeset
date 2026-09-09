import { describe, expect, it } from 'vitest';
import type { GraphEdgeModel, GraphNodeModel } from '../src/lib/dependency-graph';
import { layoutGraph } from '../src/lib/elk-layout';

const nodes: GraphNodeModel[] = [
  { id: 'a', key: { type: 'ApexClass', fullName: 'A' }, role: 'focus', depth: 0 },
  { id: 'b', key: { type: 'ApexClass', fullName: 'B' }, role: 'forward', depth: 1 },
  { id: 'c', key: { type: 'ApexClass', fullName: 'C' }, role: 'reverse', depth: 1 },
];
const edges: GraphEdgeModel[] = [
  { id: 'a=>b', source: 'a', target: 'b', provenance: 'org', discoveredVia: 'forward' },
  { id: 'c=>a', source: 'c', target: 'a', provenance: 'org', discoveredVia: 'reverse' },
];

describe('layoutGraph', () => {
  it('returns an empty map for an empty graph without calling ELK', async () => {
    const positions = await layoutGraph([], []);
    expect(positions.size).toBe(0);
  });

  it('positions every node, each with finite numeric coordinates', async () => {
    const positions = await layoutGraph(nodes, edges);
    expect(positions.size).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      const pos = positions.get(id);
      expect(pos).toBeDefined();
      expect(Number.isFinite(pos!.x)).toBe(true);
      expect(Number.isFinite(pos!.y)).toBe(true);
    }
  });

  it('lays a forward-only edge left-to-right (source strictly left of target given RIGHT direction)', async () => {
    const positions = await layoutGraph(
      [
        { id: 'x', key: { type: 'ApexClass', fullName: 'X' }, role: 'focus', depth: 0 },
        { id: 'y', key: { type: 'ApexClass', fullName: 'Y' }, role: 'forward', depth: 1 },
      ],
      [{ id: 'x=>y', source: 'x', target: 'y', provenance: 'org', discoveredVia: 'forward' }],
    );
    expect(positions.get('y')!.x).toBeGreaterThan(positions.get('x')!.x);
  });
});
