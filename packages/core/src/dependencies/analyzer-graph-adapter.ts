import type { ComponentKey, MetadataSource } from '../types/metadata-source.js';
import type { DependencyGraph } from '../types/analyzer.js';
import { componentKeyString } from '../util/component-key.js';
import { PERMISSION_COLLECTIONS } from '../diff/profiles.js';
import { getRegistryAccess } from '../sources/registry.js';
import { edgeFromKey, edgeToKey, type DependencyGraphSource } from './types.js';

/**
 * THE SEAM: Cassia's analyzers (`types/analyzer.ts`'s `DependencyGraph`)
 * are written against a small, SYNCHRONOUS query interface —
 * `dependenciesOf`/`dependentsOf`/`existsInTarget` — because `analyze()`
 * itself is synchronous and cannot `await` this workstream's
 * `DependencyGraphSource` (`forward`/`reverse`, both `Promise`-based) or
 * `MetadataSource.inventory()`. This module is the adapter: it PRE-
 * MATERIALIZES both async sources into an in-memory index for a bounded
 * scope, then hands back a plain object satisfying `DependencyGraph`
 * synchronously. Nothing here mutates or wraps Cassia's rules — every
 * rule in `analyzers/**` keeps calling the exact same three methods it
 * always has; only what answers them changes from `FakeDependencyGraph`
 * to this.
 *
 * TWO THINGS THIS ADAPTER MUST GET RIGHT (see the task brief):
 *
 * 1. UNKNOWN MUST STAY UNKNOWN. `existsInTarget` returns `boolean |
 *    undefined`; this adapter's job is to map `DependencyReferenceChecker`/
 *    `DependencyGraphSource`'s `'no-recorded-edge'`/"not indexed" cases to
 *    `undefined`, NEVER to `false`. See `existsInTarget` below: a key
 *    whose TYPE was never queried against the target's inventory answers
 *    `undefined` unconditionally, regardless of whether the key happens to
 *    be absent from whatever inventory rows WERE fetched.
 *
 * 2. `existsInTarget` NEEDS A REAL ANSWER, not a permanently-`undefined`
 *    stub. It asks "does the TARGET org already have this component",
 *    independent of the current deployment package — that's exactly what
 *    `MetadataSource.inventory()` already answers for a `TypeFilter.types`
 *    scoped query: `listMetadata` for one type returns the COMPLETE list
 *    of every component of that type in the org, so a name absent from a
 *    complete listing is a CONFIRMED absence (`false`), not silence. This
 *    is the trick that makes a `boolean | undefined` result honest: for
 *    any type actually included in `existenceCheckTypes`, "not in the
 *    fetched set" really does mean "confirmed not in the org" — for any
 *    type NOT included, it means nothing at all, so it must answer
 *    `undefined` instead of quietly reusing the "false" case.
 */

/**
 * Metadata types Cassia's shipped analyzers resolve `existsInTarget`
 * against as of this writing. `PERMISSION_COLLECTIONS`'s `refType` column
 * (imported, never re-typed by hand — `permission-rules.ts` already
 * builds on this exact table, so a new grant tag Cassia adds there is
 * picked up automatically here too) covers every `permissions/*` rule's
 * possible target type.
 *
 * `dependency-rules.ts`'s six missing-reference rules are NOT similarly
 * data-driven — they only ever build `CustomField`/`RecordType` (via
 * `fieldKey`/`recordTypeKey`) or a bare `ApexClass` key
 * (`flowMissingApexActionAnalyzer`), and that file exports no list of its
 * own target types to import instead. So this array is a genuine, disclosed
 * duplicate for that half: a FUTURE missing-dependency rule that resolves
 * against a new target type will silently get `undefined` (fail closed —
 * never a false hazard, per this module's whole point) until this list is
 * updated to match. Flagged here and in the PR body, the same way
 * `dependencies/types.ts`'s `KNOWN_COVERAGE_GAPS` discloses graph coverage
 * gaps rather than leaving them as a silent assumption.
 */
const DEPENDENCY_RULE_TARGET_TYPES: readonly string[] = ['CustomField', 'RecordType', 'ApexClass'];

/**
 * Filters `types` down to names SDR's `RegistryAccess` actually recognizes
 * as independently-addressable metadata types — cheap, synchronous,
 * no network. `MetadataSource.inventory({ types })` (specifically
 * `OrgSource`'s `resolveInventoryTypes`) throws loudly for ANY unrecognized
 * type name in the batch, which would otherwise take down existence-
 * checking for every OTHER type in the same call over one bad name — this
 * is exactly what happened, confirmed against a real org during this
 * workstream's own end-to-end verification, with `UserPermission`: a real
 * `PERMISSION_COLLECTIONS` `refType` that names a Profile/PermissionSet XML
 * SECTION (`<userPermissions>`), not a retrievable component type, so
 * `RegistryAccess.getTypeByName('UserPermission')` throws. A type dropped
 * here simply never enters `coveredTypes`, so `existsInTarget` answers
 * `undefined` for it — correct, since VibeSet genuinely cannot check
 * existence for a type SDR doesn't know how to retrieve/list.
 */
export function filterRegistryKnownTypes(types: readonly string[]): string[] {
  const registry = getRegistryAccess();
  return types.filter((t) => {
    try {
      registry.getTypeByName(t);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Union of every metadata type `existsInTarget` can currently be asked
 * about, honestly answered — pre-filtered through `filterRegistryKnownTypes`
 * so the returned list is always safe to hand `MetadataSource.inventory()`
 * directly. See the module doc comment and `DEPENDENCY_RULE_TARGET_TYPES`
 * above for what feeds this list and its one known (disclosed) gap.
 */
export function defaultExistenceCheckTypes(): string[] {
  return filterRegistryKnownTypes([...new Set([...PERMISSION_COLLECTIONS.map((c) => c.refType), ...DEPENDENCY_RULE_TARGET_TYPES])]);
}

export interface AnalyzerDependencyGraphScope {
  /**
   * Every key `dependenciesOf`/`dependentsOf` must be able to answer for —
   * today that's exactly `AnalysisContext.packageComponents` plus
   * `destructiveComponents` (the only two places any shipped analyzer
   * calls either method: `destructive-rules.ts`'s `dependentsOf` walk over
   * `destructiveComponents`; nothing yet calls `dependenciesOf`, but it's
   * pre-materialized symmetrically so a future rule can). A key OUTSIDE
   * this scope returns `[]` from both methods — NOT because it's confirmed
   * to have no edges (per `DependencyGraph`'s own doc comment, empty here
   * normally means exactly that), but because this adapter was never asked
   * to pre-fetch it. Widen this scope if a future rule queries edges for
   * keys beyond the package/destructive set.
   */
  readonly edgeScopeKeys: readonly ComponentKey[];
  /**
   * Metadata types `existsInTarget` will resolve against real target-org
   * inventory. Defaults to `defaultExistenceCheckTypes()`. Pass `[]`
   * explicitly to disable existence-checking entirely (every call answers
   * `undefined`) — a deliberate opt-out, e.g. to skip the inventory round
   * trip entirely when the caller already knows no dependency/permission
   * rule is in scope for this run.
   */
  readonly existenceCheckTypes?: readonly string[];
}

/**
 * Builds a synchronous `DependencyGraph` (see `types/analyzer.ts`) by
 * pre-fetching `edgeSource.forward`/`reverse` for every key in
 * `scope.edgeScopeKeys` and `targetInventorySource.inventory()` for every
 * type in `scope.existenceCheckTypes`, then indexing both into plain
 * `Map`/`Set`s. Both pre-fetches run concurrently since they're
 * independent.
 *
 * `edgeSource` is typically a `DrizzleDependencyGraph` bound to the
 * TARGET connection (`@vibeset/server`) or an `InMemoryDependencyGraph`
 * (tests/`core`-only callers); `targetInventorySource` is typically the
 * target's `OrgSource` (or any other `MetadataSource` — the existence
 * check works identically for a git-ref/sfdx-project target, it just
 * answers from a local listing instead of a live org).
 */
export async function buildAnalyzerDependencyGraph(
  edgeSource: DependencyGraphSource,
  targetInventorySource: Pick<MetadataSource, 'inventory'>,
  scope: AnalyzerDependencyGraphScope,
): Promise<DependencyGraph> {
  const existenceTypes = filterRegistryKnownTypes(scope.existenceCheckTypes ?? defaultExistenceCheckTypes());

  const [edgeRows, inventory] = await Promise.all([
    Promise.all(
      scope.edgeScopeKeys.map(async (key) => ({
        keyString: componentKeyString(key),
        forward: await edgeSource.forward(key),
        reverse: await edgeSource.reverse(key),
      })),
    ),
    existenceTypes.length > 0
      ? targetInventorySource.inventory({ types: [...existenceTypes] })
      : Promise.resolve({ sourceId: '', entries: [] }),
  ]);

  const forwardIndex = new Map<string, ComponentKey[]>();
  const reverseIndex = new Map<string, ComponentKey[]>();
  for (const row of edgeRows) {
    forwardIndex.set(row.keyString, row.forward.map(edgeToKey));
    reverseIndex.set(row.keyString, row.reverse.map(edgeFromKey));
  }

  const existingKeys = new Set(inventory.entries.map((e) => componentKeyString(e.key)));
  const coveredTypes = new Set(existenceTypes);

  return {
    dependenciesOf(from: ComponentKey): readonly ComponentKey[] {
      return forwardIndex.get(componentKeyString(from)) ?? [];
    },
    dependentsOf(to: ComponentKey): readonly ComponentKey[] {
      return reverseIndex.get(componentKeyString(to)) ?? [];
    },
    existsInTarget(key: ComponentKey): boolean | undefined {
      if (!coveredTypes.has(key.type)) return undefined; // type never queried — genuinely unknown, never "false"
      return existingKeys.has(componentKeyString(key));
    },
  };
}
