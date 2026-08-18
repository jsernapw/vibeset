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
