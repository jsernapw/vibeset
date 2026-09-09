import type { ComponentKey, DependencyEdge } from '@vibeset/core';
import { componentKeyString } from '@vibeset/core';

/**
 * The shape `dependencies.impact` (packages/server/src/trpc/routers/
 * dependencies.ts) actually returns per node — mirrors `@vibeset/core`'s
 * `ImpactNode` structurally rather than importing it, since this file only
 * needs to describe the tRPC wire shape (plain JSON after serialization),
 * not depend on `core`'s runtime.
 */
export interface ImpactNodeLike {
  readonly key: ComponentKey;
  readonly depth: number;
  readonly viaEdge: DependencyEdge;
}

export type GraphRole = 'focus' | 'forward' | 'reverse';

export interface GraphNodeModel {
  readonly id: string;
  readonly key: ComponentKey;
  /** 'focus' is the selected component; 'forward' = what it depends on; 'reverse' = what depends on it. */
  readonly role: GraphRole;
  /** Hops from the focus node (0 for the focus itself). */
  readonly depth: number;
}

export interface GraphEdgeModel {
  readonly id: string;
  /** Node id of the dependency's FROM side — always the true "A depends on B" direction, independent of which traversal (forward/reverse) discovered it. */
  readonly source: string;
  readonly target: string;
  readonly provenance: DependencyEdge['provenance'];
  readonly supplementKind?: DependencyEdge['supplementKind'];
  /** Which traversal discovered this edge — for styling/legend purposes only; the arrow direction above is always the real dependency direction. */
  readonly discoveredVia: 'forward' | 'reverse';
}

export interface GraphModel {
  readonly nodes: readonly GraphNodeModel[];
  readonly edges: readonly GraphEdgeModel[];
  /** How many forward-reachable nodes were discovered but dropped to stay under the cap. */
  readonly truncatedForward: number;
  readonly truncatedReverse: number;
  readonly totalDiscoveredForward: number;
  readonly totalDiscoveredReverse: number;
}

/**
 * Default cap on how many nodes from EACH direction (forward/reverse) get
 * rendered. ARM DEV's synced graph has 70,215 edges and ~45.8%
 * managed-package involvement — a single focus node a few hops into a
 * densely-connected managed package can trivially discover thousands of
 * "impact" nodes. Rendering that would hang the browser (the whole reason
 * this module exists rather than handing raw `ImpactNode[]` straight to
 * React Flow). Kept modest — a graph of a few hundred nodes is already
 * hard for a human to read, let alone browsers to lay out with a force/
 * layered algorithm at interactive speed.
 */
export const DEFAULT_MAX_NODES_PER_DIRECTION = 60;

function supplementKindFor(edge: DependencyEdge): DependencyEdge['supplementKind'] {
  return edge.provenance === 'supplemented' ? edge.supplementKind : undefined;
}

/**
 * Builds a small, renderable graph model centered on `focus`, from the raw
 * transitive-impact node lists `dependencies.impact` returns for the
 * `'forward'` and `'reverse'` directions. This is the ONE place scale is
 * bounded for the UI: everything downstream (ELK layout, React Flow
 * rendering) only ever sees at most `2 * maxNodesPerDirection + 1` nodes.
 *
 * Nodes are kept in the server's BFS (depth-ascending) order before
 * slicing, so capping never orphans an edge: `transitiveImpact` (core)
 * pushes every depth-1 node before any depth-2 node, and a depth-N node's
 * `viaEdge` always references a depth-(N-1) node that appears earlier in
 * that same list — so a same-direction prefix always contains its own
 * ancestors. `discoveredVia` is attached (never inferred later) precisely
 * so provenance AND traversal direction survive as real data, not derived
 * from node position — see this module's `GraphEdgeModel` doc comment.
 */
export function buildGraphModel(
  focus: ComponentKey,
  forwardNodes: readonly ImpactNodeLike[],
  reverseNodes: readonly ImpactNodeLike[],
  opts: { readonly maxNodesPerDirection?: number } = {},
): GraphModel {
  const cap = opts.maxNodesPerDirection ?? DEFAULT_MAX_NODES_PER_DIRECTION;
  const focusId = componentKeyString(focus);

  const nodes = new Map<string, GraphNodeModel>();
  nodes.set(focusId, { id: focusId, key: focus, role: 'focus', depth: 0 });

  const edges: GraphEdgeModel[] = [];
  const seenEdgeIds = new Set<string>();

  function ingest(role: 'forward' | 'reverse', list: readonly ImpactNodeLike[]): number {
    const kept = list.slice(0, cap);
    for (const n of kept) {
      const id = componentKeyString(n.key);
      if (!nodes.has(id)) {
        nodes.set(id, { id, key: n.key, role, depth: n.depth });
      }

      const edge = n.viaEdge;
      const fromId = componentKeyString({ type: edge.fromType, fullName: edge.fromFullName });
      const toId = componentKeyString({ type: edge.toType, fullName: edge.toFullName });
      // Both endpoints are guaranteed present: `toId`/`fromId` is either the
      // just-inserted node above or an ancestor already ingested earlier in
      // this same depth-ascending prefix (see doc comment). Guarded anyway
      // rather than assumed, so a future change to traversal order fails
      // closed (drops the edge) instead of handing React Flow a dangling ref.
      if (!nodes.has(fromId) || !nodes.has(toId)) continue;

      const edgeId = `${fromId}=>${toId}:${edge.provenance}:${edge.supplementKind ?? ''}`;
      if (seenEdgeIds.has(edgeId)) continue;
      seenEdgeIds.add(edgeId);

      edges.push({
        id: edgeId,
        source: fromId,
        target: toId,
        provenance: edge.provenance,
        supplementKind: supplementKindFor(edge),
        discoveredVia: role,
      });
    }
    return list.length - kept.length;
  }

  const truncatedForward = ingest('forward', forwardNodes);
  const truncatedReverse = ingest('reverse', reverseNodes);

  return {
    nodes: [...nodes.values()],
    edges,
    truncatedForward: Math.max(0, truncatedForward),
    truncatedReverse: Math.max(0, truncatedReverse),
    totalDiscoveredForward: forwardNodes.length,
    totalDiscoveredReverse: reverseNodes.length,
  };
}
