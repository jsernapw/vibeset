import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphEdgeModel, GraphNodeModel } from './dependency-graph';

/** Fixed node box size fed to ELK — must match the CSS box `DependencyNode` actually renders, or ELK's layout will under/overlap real DOM nodes. */
export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 60;

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

const elk = new ELK();

/**
 * Lays out the bounded graph model from `dependency-graph.ts` with ELK's
 * layered algorithm (left-to-right: reverse-discovered nodes read as
 * "upstream of focus", forward-discovered as "downstream" — matching the
 * plan's `@xyflow/react` + `elkjs` choice). Pure and async with no DOM
 * dependency, so it's usable from a plain unit test as well as the
 * `DependencyGraphView` component.
 *
 * Returns an empty map for an empty node list rather than calling ELK at
 * all — ELK errors on a graph with zero children.
 */
export async function layoutGraph(
  nodes: readonly GraphNodeModel[],
  edges: readonly GraphEdgeModel[],
): Promise<Map<string, GraphPosition>> {
  if (nodes.length === 0) return new Map();

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '36',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: nodes.map((n) => ({ id: n.id, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(elkGraph);
  const positions = new Map<string, GraphPosition>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}
