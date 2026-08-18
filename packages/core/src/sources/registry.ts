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
 * Phase 2A-b default inventory scope: the metadata types a release manager
 * actually deploys, not "everything SDR's registry knows about."
 *
 * SDR's `RegistryAccess` recognizes ~418 independently-addressable type
 * names (382 top-level + 36 decomposed children like `CustomField` under
 * `CustomObject`). Naively inventorying all of them by default would be a
 * disaster for the product: a cold 406-component *single-type* ApexClass
 * comparison against a real org already takes >10 minutes (see
 * `ARCHITECTURE.md` / the Phase 2 plan's known debt), and the overwhelming
 * majority of the ~418 types are either org-wide configuration singletons
 * (Territory2*, Wave*, AI*, ...) that are almost never part of a change-set
 * deploy, or managed-package internals a release manager never touches
 * directly. Multiplying the default type count by ~13x would turn "open a
 * comparison" into a multi-hour operation and make the product feel broken
 * rather than thorough — exactly the failure mode the task brief warns
 * against.
 *
 * So this list is a curated *default*, not the ceiling: every one of the
 * ~418 registry-known type names remains selectable via an explicit
 * `TypeFilter.types` (see `listAllInventoryTypeNames` below, which is what
 * a future "choose your types" UI would enumerate from) — this only
 * controls what gets inventoried when a caller doesn't specify a filter.
 *
 * Selection criteria, in order of how each entry earned its place:
 *   1. Proven by Cassia's Phase 2 differ expansion (PR #2, 28 root types,
 *      62 golden fixtures) — the differ is known-correct for these.
 *   2. Carried over from Phase 1's original 11-type default, proven against
 *      real orgs (RCA DEV / ARM DEV) even though not part of Cassia's
 *      fixture corpus (ApexTrigger, CustomField, ValidationRule).
 *   3. `RecordType` and `Document` are the two genuinely new additions not
 *      covered by either of the above. Both are safe on inspection rather
 *      than proof: `RecordType` diffs through the generic XML differ using
 *      natural-key rules already present in `diff/natural-keys.ts`
 *      (`picklistValues`, the `*` bucket) and — importantly — is already
 *      named in `retrieval/chunking.ts`'s `PROFILE_PAIRED_TYPES`, so
 *      *adding* it here is what makes `recordTypeVisibilities` and
 *      `layoutAssignments` (which needs the `(layout, recordType)`
 *      composite key) actually populate in a default comparison instead of
 *      silently retrieving empty; `Document` shares `StaticResource`'s
 *      `mixedContent`/binary-body shape and is covered by the same
 *      binary-content fix in `compare/content-reader.ts`.
 *
 * Deliberately excluded from the default (but selectable): high-volume or
 * rarely-deployed `CustomObject`/`Workflow` children (`ListView`,
 * `FieldSet`, `CompactLayout`, `BusinessProcess`, `WebLink`,
 * `SharingReason`, `WorkflowTask`, `WorkflowOutboundMessage`, ...),
 * `Settings` (an org-config singleton container with ~40 sub-shapes and no
 * golden-fixture coverage — see `NON_LISTABLE_SINGLETON_TYPES`), and the
 * hundreds of Wave/AI/Territory2/Industries-cloud types that are almost
 * always managed-package internals rather than something a release
 * manager hand-deploys.
 *
 * Every entry is validated against `RegistryAccess` at call time
 * (`resolveInventoryTypes` throws loudly if SDR doesn't recognize one), so
 * this can never silently drift from what SDR actually knows how to
 * handle.
 */
export const DEFAULT_INVENTORY_TYPES: readonly string[] = [
  // Apex / code
  'ApexClass',
  'ApexTrigger',
  'ApexPage',
  'ApexComponent',

  // Lightning / Aura bundles
  'LightningComponentBundle',
  'AuraDefinitionBundle',

  // Data model
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'RecordType',
  'CustomMetadata',
  'Layout',

  // Automation
  'Flow',
  'WorkflowRule',
  'WorkflowAlert',
  'WorkflowFieldUpdate',

  // Security & access
  'PermissionSet',
  'Profile',

  // Apps & tabs
  'CustomApplication',
  'CustomTab',

  // Communication templates
  'EmailTemplate',

  // Static content, value sets, translations
  'StaticResource',
  'GlobalValueSet',
  'StandardValueSet',
  'CustomLabels',
  'Translations',

  // Integration
  'ConnectedApp',
  'NamedCredential',
  'RemoteSiteSetting',

  // Analytics
  'Report',
  'Dashboard',

  // Content & actions
  'Document',
  'QuickAction',
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

/** Minimal shape of one `metadataRegistry.json` type entry this module reads — declared locally rather than importing SDR's internal `types.d.ts`, which isn't part of its public API surface. */
interface RegistryTypeEntryLike {
  readonly name: string;
  readonly children?: { readonly types: Record<string, { readonly name: string }> };
}

/**
 * Enumerates every metadata type name SDR's `RegistryAccess` can resolve —
 * both the ~382 top-level types and the ~36 decomposed children
 * (`CustomField`, `ValidationRule`, `WorkflowRule`, ...) that
 * `RegistryAccess.getTypeByName` also happily resolves even though they
 * don't appear as top-level keys in the registry. This is the *available*
 * half of "make the full set available and selectable" — `TypeFilter.types`
 * already accepts any of these (validated by `resolveInventoryTypes`); this
 * function is what a "choose your types" caller (a future filter-picker UI,
 * the CLI, a saved-filter feature) would enumerate options from, so nobody
 * has to hand-maintain a second parallel list of "all the types" either.
 *
 * Same deep-import posture as `loadStandardValueSetNames`: not a documented
 * public export of SDR, so wrapped in a try/catch that falls back to
 * `DEFAULT_INVENTORY_TYPES` (never an empty list — a picker with zero
 * options is a worse failure mode than one limited to the curated default)
 * if SDR ever relocates the file.
 */
export async function listAllInventoryTypeNames(): Promise<string[]> {
  try {
    // Deep import into SDR's compiled output — not part of its public `exports`, hence the catch below.
    const mod = (await import('@salesforce/source-deploy-retrieve/lib/src/registry/registry.js')) as {
      registry?: { types?: Record<string, RegistryTypeEntryLike> };
    };
    const types = mod.registry?.types;
    if (!types) return [...DEFAULT_INVENTORY_TYPES];

    const names = new Set<string>();
    for (const t of Object.values(types)) {
      names.add(t.name);
      if (t.children) {
        for (const child of Object.values(t.children.types)) names.add(child.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  } catch {
    return [...DEFAULT_INVENTORY_TYPES];
  }
}
