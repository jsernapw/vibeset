import { RegistryAccess, type MetadataType } from '@salesforce/source-deploy-retrieve';
import type { TypeFilter } from '../types/metadata-source.js';

/**
 * Shared helpers for driving metadata-type behaviour from SDR's
 * `RegistryAccess` instead of a hand-rolled parallel type list. SDR already
 * knows every type's suffix, directory, folder semantics, decomposition
 * strategy, and child types — this module only adds the small amount of
 * glue `OrgSource` needs on top of it (batching, folder resolution, the
 * handful of types that don't behave like ordinary listable types).
 */

let sharedRegistry: RegistryAccess | undefined;

/** Lazily-created, process-wide `RegistryAccess`. Cheap to construct, but no reason to repeat it per call. */
export function getRegistryAccess(): RegistryAccess {
  sharedRegistry ??= new RegistryAccess();
  return sharedRegistry;
}

/**
 * The Phase 1 metadata scope named in the plan: enough breadth to hit every
 * hard integration problem once (folder types, decomposed children, the
 * Profile pairing gotcha, bundles) without the effort of covering all ~250
 * registered types. This is a list of *names* the plan itself specifies as
 * Phase 1's scope, not a parallel registry — every entry is validated
 * against `RegistryAccess` at call time (`resolveInventoryTypes` throws
 * loudly if SDR doesn't recognize one), so it can never silently drift from
 * what SDR actually knows how to handle. Callers should normally pass an
 * explicit `TypeFilter.types`; this is only the default when they don't.
 */
export const DEFAULT_INVENTORY_TYPES: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'CustomObject',
  'CustomField',
  'Layout',
  'ValidationRule',
  'Flow',
  'PermissionSet',
  'Profile',
  'LightningComponentBundle',
  'CustomLabels',
];

/**
 * Resolves a `TypeFilter` into concrete `MetadataType` registry entries.
 * Throws if a requested type name isn't recognized by SDR's registry —
 * failing loudly here is much better than silently inventorying nothing for
 * a typo'd or renamed type.
 */
export function resolveInventoryTypes(filter: TypeFilter, registry: RegistryAccess = getRegistryAccess()): MetadataType[] {
  const names = filter.types && filter.types.length > 0 ? filter.types : DEFAULT_INVENTORY_TYPES;
  return names.map((name) => registry.getTypeByName(name));
}

/** The Report/Dashboard/EmailTemplate/Document types are `inFolder` and require enumerating folders first — `listMetadata` on the bare type returns nothing. */
export function isFolderBasedType(type: MetadataType): boolean {
  return Boolean(type.folderType);
}

/** Resolves a folder-based type's own folder-container type, e.g. `Report` -> `ReportFolder`. */
export function getFolderContainerType(type: MetadataType, registry: RegistryAccess = getRegistryAccess()): MetadataType {
  if (!type.folderType) {
    throw new Error(`${type.name} is not a folder-based type (no folderType in the registry entry).`);
  }
  return registry.getTypeByName(type.folderType);
}

/**
 * Every org has an implicit default folder per folder-based type that never
 * appears in the `listMetadata` results for the folder container type
 * itself (e.g. `ReportFolder`) but does hold components — the "Unfiled
 * Public ..." folder shown in the Salesforce UI. Must always be queried in
 * addition to whatever real folders `listMetadata` returns.
 */
export const UNFILED_PUBLIC_FOLDER = 'unfiled$public';

/**
 * Types that the Metadata API's `listMetadata` call does not support at
 * all — not folder-based, just fundamentally not enumerable that way.
 * `StandardValueSet` requires reading each of a fixed, SF-defined set of
 * names directly; `Settings` is a container for ~40 org-wide settings
 * singletons with no per-item listing; `CustomLabels` is a single
 * non-decomposed container file (its `CustomLabel` children aren't
 * independently listable). Handled explicitly in `OrgSource.inventory()`
 * rather than silently returning zero results for them.
 */
export const NON_LISTABLE_SINGLETON_TYPES: ReadonlySet<string> = new Set(['Settings', 'CustomLabels']);
export const STANDARD_VALUE_SET_TYPE = 'StandardValueSet';

/** Splits an array into fixed-size batches, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once.
 * Deliberately tiny rather than pulling in a dependency (`p-limit` et al.)
 * for something this small; preserves input order in the returned results.
 */
export async function withConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * SDR ships the real, SF-maintained list of `StandardValueSet` fullNames
 * (`registry/stdValueSetRegistry.json`) but doesn't re-export it from its
 * public entry point. Reading it via a deep import avoids VibeSet
 * maintaining its own duplicate copy of that list (which is exactly the
 * "parallel metadata type list" the plan says to avoid) while not being a
 * documented, stable public API — if SDR ever moves the file, this falls
 * back to an empty list and callers get `lastModifiedDateUnknown: true`
 * entries instead of a hard crash. See `OrgSource.inventory()`.
 */
export async function loadStandardValueSetNames(): Promise<string[]> {
  try {
    // Deep import into SDR's compiled output — not part of its public `exports`, hence the catch below.
    const mod = (await import('@salesforce/source-deploy-retrieve/lib/src/registry/standardvalueset.js')) as {
      standardValueSet?: { fullnames?: string[] };
    };
    return mod.standardValueSet?.fullnames ?? [];
  } catch {
    return [];
  }
}
