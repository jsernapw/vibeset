import { parseXml } from '../diff/normalize.js';
import type { DependencyEdge } from './types.js';

/**
 * Backfills the two `MetadataComponentDependency` coverage gaps this
 * workstream specifically targeted (see `KNOWN_COVERAGE_GAPS` in
 * `types.ts`): Profile/PermissionSet grants and Layout field placements.
 * Both are cheap because VibeSet already retrieves and parses this exact
 * XML for comparisons — no extra API surface, just reading structure the
 * codebase already knows how to read (`parseXml`, `@vibeset/core`'s
 * `diff/normalize.ts` — imported read-only; this module does not modify
 * anything under `diff/`).
 *
 * Every edge produced here carries `provenance: 'supplemented'` and a
 * `supplementKind` — see `DependencyEdge`'s doc comment for why that
 * distinction is load-bearing rather than cosmetic.
 */

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads a leaf text value out of fast-xml-parser's parsed shape — handles the plain-string case and the `{__cdata: string}` case (see `normalize.ts`'s `CDATA_PROP_NAME`). */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '__cdata' in (value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>).__cdata;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function extractNamespaceHeuristic(fullName: string): string | undefined {
  const withoutCustomSuffix = fullName.endsWith('__c') ? fullName.slice(0, -3) : fullName;
  const separatorIndex = withoutCustomSuffix.indexOf('__');
  if (separatorIndex <= 0) return undefined;
  return withoutCustomSuffix.slice(0, separatorIndex);
}

function edge(
  fromType: string,
  fromFullName: string,
  toType: string,
  toFullName: string,
  supplementKind: NonNullable<DependencyEdge['supplementKind']>,
): DependencyEdge {
  return {
    fromType,
    fromFullName,
    toType,
    toFullName,
    provenance: 'supplemented',
    supplementKind,
    fromNamespace: extractNamespaceHeuristic(fromFullName),
    toNamespace: extractNamespaceHeuristic(toFullName),
  };
}

/**
 * Extracts dependency edges from one Profile or PermissionSet's raw XML.
 * `rootType` must be `'Profile'` or `'PermissionSet'` (both share the same
 * grant-shaped schema for the sections this reads). Grants read:
 *
 *  - `classAccesses.apexClass`        -> ApexClass
 *  - `pageAccesses.apexPage`          -> ApexPage
 *  - `fieldPermissions.field`         -> CustomField (already `Object.Field`
 *    dotted form, matching CustomField's own `fullName` convention)
 *  - `objectPermissions.object`       -> CustomObject
 *  - `recordTypeVisibilities.recordType` -> RecordType (already
 *    `Object.RecordType` dotted form)
 *  - `layoutAssignments.layout`       -> Layout (already `Object-LayoutName`
 *    dotted form)
 *  - `tabVisibilities.tab`            -> CustomTab
 *
 * Deliberately NOT read: `userPermissions` (a fixed system-permission name,
 * not a metadata component reference) and `loginIpRanges`/session settings
 * (no component reference at all).
 */
export function extractProfileLikeEdges(
  rootType: 'Profile' | 'PermissionSet',
  fullName: string,
  xml: string,
): DependencyEdge[] {
  const parsed = parseXml(xml);
  const root = (parsed[rootType] ?? parsed[Object.keys(parsed)[0] ?? '']) as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') return [];

  const edges: DependencyEdge[] = [];
  const kind: NonNullable<DependencyEdge['supplementKind']> =
    rootType === 'Profile' ? 'profile-grant' : 'permission-set-grant';

  for (const entry of asArray(root.classAccesses)) {
    const name = textOf((entry as Record<string, unknown>)?.apexClass);
    if (name) edges.push(edge(rootType, fullName, 'ApexClass', name, kind));
  }
  for (const entry of asArray(root.pageAccesses)) {
    const name = textOf((entry as Record<string, unknown>)?.apexPage);
    if (name) edges.push(edge(rootType, fullName, 'ApexPage', name, kind));
  }
  for (const entry of asArray(root.fieldPermissions)) {
    const name = textOf((entry as Record<string, unknown>)?.field);
    if (name) edges.push(edge(rootType, fullName, 'CustomField', name, kind));
  }
  for (const entry of asArray(root.objectPermissions)) {
    const name = textOf((entry as Record<string, unknown>)?.object);
    if (name) edges.push(edge(rootType, fullName, 'CustomObject', name, kind));
  }
  for (const entry of asArray(root.recordTypeVisibilities)) {
    const name = textOf((entry as Record<string, unknown>)?.recordType);
    if (name) edges.push(edge(rootType, fullName, 'RecordType', name, kind));
  }
  for (const entry of asArray(root.layoutAssignments)) {
    const name = textOf((entry as Record<string, unknown>)?.layout);
    if (name) edges.push(edge(rootType, fullName, 'Layout', name, kind));
  }
  for (const entry of asArray(root.tabVisibilities)) {
    const name = textOf((entry as Record<string, unknown>)?.tab);
    if (name) edges.push(edge(rootType, fullName, 'CustomTab', name, kind));
  }

  return edges;
}

/**
 * Extracts field-placement edges from one Layout's raw XML —
 * `layoutSections.layoutColumns.layoutItems.field` -> CustomField, the
 * other gap named explicitly in the task brief ("Layouts name their
 * fields"). Also reads `relatedLists.fields` (fields shown in a related
 * list, same reference shape) since it's the identical pattern at
 * negligible extra cost.
 */
export function extractLayoutFieldEdges(fullName: string, xml: string): DependencyEdge[] {
  const parsed = parseXml(xml);
  const root = (parsed['Layout'] ?? parsed[Object.keys(parsed)[0] ?? '']) as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') return [];

  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  const pushField = (name: string | undefined): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    edges.push(edge('Layout', fullName, 'CustomField', name, 'layout-field-reference'));
  };

  for (const section of asArray(root.layoutSections)) {
    for (const column of asArray((section as Record<string, unknown>)?.layoutColumns)) {
      for (const item of asArray((column as Record<string, unknown>)?.layoutItems)) {
        pushField(textOf((item as Record<string, unknown>)?.field));
      }
    }
  }
  for (const relatedList of asArray(root.relatedLists)) {
    for (const field of asArray((relatedList as Record<string, unknown>)?.fields)) {
      pushField(textOf(field));
    }
  }

  return edges;
}
