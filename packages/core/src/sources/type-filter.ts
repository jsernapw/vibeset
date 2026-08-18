import type { TypeFilter } from '../types/metadata-source.js';

/**
 * Shared `TypeFilter` matching logic for the two filesystem-backed sources
 * (`SfdxProjectSource`, `GitRefSource`) — both resolve everything cheaply
 * off local/git-object-database state, so (unlike `OrgSource`, which limits
 * its default type set to avoid unbounded `listMetadata` calls) they can
 * honor the `TypeFilter` contract literally: an omitted/empty array means
 * "no restriction", not "use some narrower default".
 */
export function matchesTypeFilter(
  params: { readonly type: string; readonly fullName: string; readonly lastModifiedDate?: string },
  filter: TypeFilter,
): boolean {
  if (filter.types && filter.types.length > 0 && !filter.types.includes(params.type)) return false;
  if (filter.namePatterns && filter.namePatterns.length > 0) {
    if (!filter.namePatterns.some((pattern) => globMatch(pattern, params.fullName))) return false;
  }
  if (filter.modifiedSince && params.lastModifiedDate && params.lastModifiedDate < filter.modifiedSince) return false;
  if (filter.excludeNamespaces && filter.excludeNamespaces.length > 0) {
    const ns = extractNamespace(params.fullName);
    if (ns && filter.excludeNamespaces.includes(ns)) return false;
  }
  return true;
}

/**
 * A namespaced component's `fullName` looks like `ns__Name__c` (two `__`
 * separators); an unmanaged custom component looks like `Name__c` (one).
 * Requiring at least two segments avoids misreading every custom field as
 * "in the `Name` namespace".
 */
function extractNamespace(fullName: string): string | undefined {
  const parts = fullName.split('__');
  if (parts.length < 3) return undefined;
  return parts[0];
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}
