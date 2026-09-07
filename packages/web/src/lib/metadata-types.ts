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
 * Types whose entry-level merge cannot see their child collections, and so
 * must be refused outright rather than shown as a merge that looks complete.
 *
 * EMPTY, deliberately — the mechanism is kept, the one entry is gone.
 *
 * `CustomObject` used to be listed here. SDR decomposes a CustomObject into
 * separate physical files per child collection (`fields/*.field-meta.xml`,
 * `listViews/*.listView-meta.xml`, ...), and `content-reader.ts` read back
 * only the object-level shell — so `merge.resolve` handed `mergeGeneric` a
 * document with no `<fields>` in it at all, producing a merge with only
 * scalar entries that read as "nothing to merge there" when the child
 * collections had never been looked at. Refusing was better than lying.
 *
 * `content-reader.ts` now recomposes decomposed children (its `compose`
 * option, registry-driven via `decomposedChildTypeNames`, so it covers any
 * decomposed type rather than CustomObject as a special case). Verified
 * against the live orgs before ungating: a real `merge.resolve` on `Account`
 * returned 109 entries including 43 `fields.*` and 5 `listViews.*`, where it
 * previously returned object-level scalars only.
 *
 * Kept rather than deleted because this is a real hazard class: if some
 * future type's content resolution is ever incomplete, refusing here is
 * still the right answer, and the reasoning above is the argument for why.
 */
export const MERGE_CHILD_COLLECTIONS_UNSUPPORTED_TYPES = new Set<string>();

export function isMergeChildCollectionsUnsupported(type: string): boolean {
  return MERGE_CHILD_COLLECTIONS_UNSUPPORTED_TYPES.has(type);
}
