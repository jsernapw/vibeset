/**
 * Phase 1's deliberately narrow metadata scope (see the plan's Phase 1
 * intro). This is a UI-facing convenience list for filter pickers and mock
 * data generation — it is NOT the source of truth for what SDR's
 * `RegistryAccess` supports; Phase 2 widens real coverage without touching
 * this list's shape.
 */
export const PHASE1_METADATA_TYPES = [
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
  'CustomLabel',
] as const;

export type Phase1MetadataType = (typeof PHASE1_METADATA_TYPES)[number];

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

export function isTextDiffType(type: string): boolean {
  return TEXT_DIFF_TYPES.has(type);
}

export function isPermissionGridType(type: string): boolean {
  return PERMISSION_GRID_TYPES.has(type);
}
