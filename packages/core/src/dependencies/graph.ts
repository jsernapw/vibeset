import type { ComponentKey } from '../types/metadata-source.js';
import { componentKeyString } from '../util/component-key.js';
import {
  edgeFromKey,
  edgeToKey,
  type DependencyEdge,
  type DependencyGraphSource,
  type DependencyReferenceChecker,
  type ReferenceAnswer,
} from './types.js';

/** Default transitive-depth bound for impact analysis and reference checks — see `transitiveImpact`'s doc comment for why this needs a bound at all. */
export const DEFAULT_MAX_DEPTH = 5;

export interface ImpactNode {
  readonly key: ComponentKey;
  /** Hops from the nearest seed (1 = direct edge from/to a seed). */
  readonly depth: number;
  /** The edge that reached this node in the traversal (one of possibly several — BFS records the first). */
  readonly viaEdge: DependencyEdge;
}

/**
 * Transitive closure over a `DependencyGraphSource`, breadth-first, with a
 * mandatory depth bound — a real org's dependency graph can have long or
 * even cyclic chains (an Apex class calling another that calls back into a
 * Flow that invokes the first), so "expand until nothing new" is not a
 * safe default; `maxDepth` makes the bound explicit and visible to the
 * caller rather than silently capping some other way.
 *
 * `direction: 'forward'` answers "what does this depend on" (build a
 * complete deployment package: walk forward from what you're deploying to
 * find everything it needs). `direction: 'reverse'` answers "what depends
 * on this" (the higher-stakes delete-safety case: walk backward from what
 * you're about to delete to find everything that would break).
 *
 * Cycle-safe: a node already visited is never re-expanded, so a cyclic
 * graph terminates instead of looping — its `ImpactNode` records the
 * SHALLOWEST depth at which it was reached, consistent with BFS order.
 */
export async function transitiveImpact(
  source: DependencyGraphSource,
  seeds: readonly ComponentKey[],
  direction: 'forward' | 'reverse',
  opts: { readonly maxDepth?: number } = {},
): Promise<ImpactNode[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seedKeys = new Set(seeds.map(componentKeyString));
  const visited = new Set<string>(seedKeys);
  const result: ImpactNode[] = [];

  let frontier: ComponentKey[] = [...seeds];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    depth += 1;
    const nextFrontier: ComponentKey[] = [];

    const edgesPerNode = await Promise.all(
      frontier.map((key) => (direction === 'forward' ? source.forward(key) : source.reverse(key))),
    );

    for (const edges of edgesPerNode) {
      for (const e of edges) {
        const nextKey = direction === 'forward' ? edgeToKey(e) : edgeFromKey(e);
        const nextKeyString = componentKeyString(nextKey);
        if (visited.has(nextKeyString)) continue;
        visited.add(nextKeyString);
        result.push({ key: nextKey, depth, viaEdge: e });
        nextFrontier.push(nextKey);
      }
    }

    frontier = nextFrontier;
  }

  return result;
}

/**
 * The real, `DependencyGraphSource`-backed implementation of the
 * `DependencyReferenceChecker` seam (see `types.ts` for why the seam
 * exists and what its return type means). Direct edges are checked first
 * (the overwhelmingly common case and the cheapest); a `maxDepth` beyond 1
 * additionally walks forward from `from` looking for `to` — the same BFS
 * `transitiveImpact` uses, stopping as soon as `to` is found rather than
 * computing the whole closure.
 */
export class GraphDependencyReferenceChecker implements DependencyReferenceChecker {
  constructor(private readonly source: DependencyGraphSource) {}

  async references(
    from: ComponentKey,
    to: ComponentKey,
    opts: { readonly maxDepth?: number } = {},
  ): Promise<ReferenceAnswer> {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const targetKeyString = componentKeyString(to);
    const visited = new Set<string>([componentKeyString(from)]);
    let frontier: Array<{ key: ComponentKey; path: DependencyEdge[] }> = [{ key: from, path: [] }];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const nextFrontier: Array<{ key: ComponentKey; path: DependencyEdge[] }> = [];

      for (const node of frontier) {
        const edges = await this.source.forward(node.key);
        for (const e of edges) {
          const nextKey = edgeToKey(e);
          const nextKeyString = componentKeyString(nextKey);
          const path = [...node.path, e];
          if (nextKeyString === targetKeyString) {
            return { certainty: 'confirmed', path };
          }
          if (visited.has(nextKeyString)) continue;
          visited.add(nextKeyString);
          nextFrontier.push({ key: nextKey, path });
        }
      }

      frontier = nextFrontier;
    }

    return { certainty: 'no-recorded-edge' };
  }
}

/**
 * Dependency-free, in-memory `DependencyGraphSource` — for `core`-only
 * callers/tests that don't have (or don't need) `@vibeset/server`'s
 * SQLite-backed one. Mirrors `store/snapshot-store.ts`'s
 * `InMemorySnapshotStore` pattern: the real, persistent implementation
 * lives in `@vibeset/server`, this is the framework-free fallback +
 * test double.
 */
export class InMemoryDependencyGraph implements DependencyGraphSource {
  private readonly edges: DependencyEdge[];

  constructor(edges: readonly DependencyEdge[] = []) {
    this.edges = [...edges];
  }

  add(edge: DependencyEdge): void {
    this.edges.push(edge);
  }

  async forward(key: ComponentKey): Promise<DependencyEdge[]> {
    return this.edges.filter((e) => e.fromType === key.type && e.fromFullName === key.fullName);
  }

  async reverse(key: ComponentKey): Promise<DependencyEdge[]> {
    return this.edges.filter((e) => e.toType === key.type && e.toFullName === key.fullName);
  }
}
