import type { ComponentKey, DependencyGraph } from '../../src/types/analyzer.js';
import { componentKeyString } from '../../src/util/component-key.js';

/**
 * In-memory `DependencyGraph` for tests — exactly the kind of adapter the
 * real thing (an implementation backed by Maximus's `dependency_edges`
 * table, once it exists) will also be: everything routes through the
 * `DependencyGraph` interface, so swapping this fake for the real
 * implementation later requires no change to any rule under test here.
 *
 * Absence discipline: a key not explicitly registered in `existsInTarget`
 * resolves to `undefined` ("not indexed"), never `false` — tests that want
 * to assert the "confirmed absent" case must register it explicitly via
 * `setExists(key, false)`.
 */
export class FakeDependencyGraph implements DependencyGraph {
  private readonly deps = new Map<string, ComponentKey[]>();
  private readonly rdeps = new Map<string, ComponentKey[]>();
  private readonly existence = new Map<string, boolean>();

  addEdge(from: ComponentKey, to: ComponentKey): void {
    const fromKey = componentKeyString(from);
    const toKey = componentKeyString(to);
    const forward = this.deps.get(fromKey) ?? [];
    forward.push(to);
    this.deps.set(fromKey, forward);
    const backward = this.rdeps.get(toKey) ?? [];
    backward.push(from);
    this.rdeps.set(toKey, backward);
  }

  setExists(key: ComponentKey, exists: boolean): void {
    this.existence.set(componentKeyString(key), exists);
  }

  dependenciesOf(from: ComponentKey): readonly ComponentKey[] {
    return this.deps.get(componentKeyString(from)) ?? [];
  }

  dependentsOf(to: ComponentKey): readonly ComponentKey[] {
    return this.rdeps.get(componentKeyString(to)) ?? [];
  }

  existsInTarget(key: ComponentKey): boolean | undefined {
    return this.existence.get(componentKeyString(key));
  }
}
