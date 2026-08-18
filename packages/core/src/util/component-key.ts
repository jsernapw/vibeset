import type { ComponentKey } from '../types/metadata-source.js';

/**
 * Stable string identity for a `ComponentKey`, used as a map/set key
 * throughout `compare/`, `package/`, and `deploy/` wherever components need
 * to be deduplicated or cross-referenced by identity rather than by object
 * reference. Deliberately `type#fullName` only (not `parentFullName`) —
 * `fullName` is already globally unique for every Phase 1 type (e.g. a
 * `CustomField`'s fullName is `Object__c.Field__c`, not just `Field__c`),
 * matching the same convention `SfdxProjectSource`/`GitRefSource` already
 * use internally for their own materialize() lookups.
 */
export function componentKeyString(key: ComponentKey): string {
  return `${key.type}#${key.fullName}`;
}
