/**
 * Phase 2 replaced this file's old hardcoded `PHASE1_METADATA_TYPES` (11
 * entries) with the real `inventory.availableTypes` tRPC endpoint — see
 * `lib/adapters/comparisons.ts`'s `useAvailableTypes()` — so the metadata
 * type picker (`components/comparisons/TypeFilterPanel.tsx`) now reflects
 * SDR's actual `RegistryAccess` coverage (~418 selectable, curated to a
 * ~33-type sensible default) instead of a UI-side list that could silently
 * drift from what the diff/retrieval engines actually support. What
 * remains here is UI-only *rendering* classification — which diff
 * renderer a given type gets — which is deliberately still a small,
 * explicit, hand-maintained set: it encodes a rendering decision, not
 * metadata coverage, so it doesn't grow just because the registry does.
 */

/** Types whose diff should render as Monaco text diff (opaque code bodies) rather than a tree. */
export const TEXT_DIFF_TYPES = new Set<string>([
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
]);

/** Types that get the dedicated filterable permission grid instead of a generic tree. */
export const PERMISSION_GRID_TYPES = new Set<string>(['Profile', 'PermissionSet']);

/**
 * Types that are compared by content hash, not structurally — see
 * `DiffResult.binary` (`@vibeset/core`'s `types/diff.ts`). This is a
 * fallback name-based check only: the authoritative signal is always
 * `result.binary === true` on the actual diff result (checked FIRST in
 * `DiffViewer`, before `isPermissionGridType`/`isTextDiffType`), since
 * that's what the diff engine actually did for that specific component.
 * This set exists only so a binary type can still be recognized somewhere
 * that only has the type name, not a full `DiffResult` (e.g. an icon
 * choice in a future type-picker row).
 */
export const BINARY_DIFF_TYPES = new Set<string>(['StaticResource', 'Document']);

export function isTextDiffType(type: string): boolean {
  return TEXT_DIFF_TYPES.has(type);
}

export function isPermissionGridType(type: string): boolean {
  return PERMISSION_GRID_TYPES.has(type);
}

export function isBinaryDiffType(type: string): boolean {
  return BINARY_DIFF_TYPES.has(type);
}

/**
 * Types for which entry-level merge (`components/merge/**`) is a coherent
 * operation at all. Mirrors `merge/decompose.ts`'s (`@vibeset/core`) own
 * scope: it parses each side as XML and decomposes top-level tags, which
 * makes no sense for the opaque code bodies `TEXT_DIFF_TYPES` renders via
 * Monaco (Apex/LWC/Aura/VF have no natural-keyed collections to merge
 * per-entry) or for `BINARY_DIFF_TYPES`' opaque bytes (`merge.resolve`
 * hard-errors on those — see its doc comment in
 * `packages/server/src/trpc/routers/merge.ts`). Everything else —
 * Profile/PermissionSet via the dedicated grid, CustomObject, Layout, and
 * every other decomposable XML type via the generic path — is mergeable in
 * principle, though see `MERGE_CHILD_COLLECTIONS_UNSUPPORTED_TYPES` below
 * for the one known gap.
 */
export function isMergeableType(type: string): boolean {
  return !isTextDiffType(type) && !isBinaryDiffType(type);
}

/**
 * CustomObject specifically: SDR's source-format conversion decomposes a
 * CustomObject into separate physical files per child collection
 * (`fields/*.field-meta.xml`, `listViews/*.listView-meta.xml`, ...), but
 * `@vibeset/core`'s `compare/content-reader.ts` currently reads only the
 * object-level shell file back for content resolution — so the string
 * `merge.resolve` hands to `mergeGeneric` for a real, retrieved CustomObject
 * has no `<fields>`/`<listViews>` in it at all. `decomposeGeneric` would
 * then silently produce a merge with only object-level scalar entries
 * (`label`, `sharingModel`, ...) and NO field/list-view entries — which
 * reads as "nothing to merge there" when in fact the child collections were
 * never even looked at. That is a worse UI outcome than an explicit
 * unsupported state, so `components/merge/MergeResolutionPanel.tsx` gates
 * on this set and refuses to call `merge.resolve` for CustomObject at all,
 * rather than rendering a merge that looks complete but silently drops
 * every field-level conflict. This is a backend limitation, not a UI
 * choice — Maximus is fixing `content-reader.ts` to reassemble the
 * decomposed files in parallel with this UI; remove CustomObject from this
 * set once that lands (and a real-org CustomObject merge has been verified
 * to actually carry field/listView entries).
 */
export const MERGE_CHILD_COLLECTIONS_UNSUPPORTED_TYPES = new Set<string>(['CustomObject']);

export function isMergeChildCollectionsUnsupported(type: string): boolean {
  return MERGE_CHILD_COLLECTIONS_UNSUPPORTED_TYPES.has(type);
}
