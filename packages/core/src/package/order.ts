import type { ComponentKey } from '../types/metadata-source.js';

/**
 * Type-precedence ordering for known Salesforce deploy-order constraints —
 * e.g. a `CustomObject` must exist before its `CustomField`s reference it,
 * an `ApexClass` before an `ApexTrigger` that references it. This is
 * deliberately a small, explicit, documented table (same spirit as
 * `diff/natural-keys.ts`) rather than a real dependency graph: computing
 * genuine cross-component dependencies (a trigger referencing a specific
 * class by name, a flow referencing a specific field) is Phase 3 scope
 * ("Query MetadataComponentDependency via the Tooling API" — see
 * ARCHITECTURE.md's roadmap). The Metadata API itself also resolves a good
 * deal of ordering internally; this pass exists for the well-known
 * type-level constraints that benefit from being explicit and reviewable in
 * a generated package.xml, not as a full dependency solver.
 *
 * Types not listed sort after every listed type (ties broken by fullName),
 * so adding a new Phase 2 type without updating this table degrades to "no
 * particular order" rather than failing.
 */
const TYPE_DEPLOY_ORDER: readonly string[] = [
  'CustomLabels',
  'CustomObject',
  'CustomField',
  'RecordType',
  'ApexClass',
  'ApexTrigger',
  'ApexPage',
  'ApexComponent',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'Layout',
  'ValidationRule',
  'Flow',
  'CustomTab',
  'CustomApplication',
  'PermissionSet',
  'Profile',
];

function orderIndex(type: string): number {
  const i = TYPE_DEPLOY_ORDER.indexOf(type);
  return i === -1 ? TYPE_DEPLOY_ORDER.length : i;
}

/**
 * Sorts components into deploy order per `TYPE_DEPLOY_ORDER`, stable within
 * a type (alphabetical by `fullName`) so output is deterministic and
 * reviewable/diffable across runs — important for a package manifest meant
 * to be git-committed (see `manifest.ts`).
 */
export function topologicalOrder(components: readonly ComponentKey[]): ComponentKey[] {
  return [...components].sort((a, b) => {
    const byType = orderIndex(a.type) - orderIndex(b.type);
    if (byType !== 0) return byType;
    return a.fullName.localeCompare(b.fullName);
  });
}
