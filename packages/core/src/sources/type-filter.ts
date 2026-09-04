import type { TypeFilter } from '../types/metadata-source.js';

/**
 * Shared `TypeFilter` matching logic for all three `MetadataSource`
 * implementations. `SfdxProjectSource`/`GitRefSource` resolve everything
 * cheaply off local/git-object-database state and can honor the
 * `TypeFilter` contract literally: an omitted/empty array means "no
 * restriction". `OrgSource` uses this same predicate — see its
 * `inventory()` — so all three sources filter BEFORE a component ever
 * becomes an inventory entry, which is what keeps an excluded component
 * out of a retrieve chunk entirely (the actual point of this module: a
 * `TypeFilter.excludeNamespaces` that only trimmed post-retrieve results
 * would still pay for, and still be broken by, fetching the excluded
 * component).
 */
export interface MatchParams {
  readonly type: string;
  readonly fullName: string;
  readonly lastModifiedDate?: string;
  /**
   * Authoritative namespace signal, when the source has one — for
   * `OrgSource` this is `listMetadata`'s own `FileProperties.namespacePrefix`
   * (`''`/`undefined` both mean "confirmed no namespace"; PASS THIS
   * EXPLICITLY, even as `''`, whenever the source actually queried it —
   * see `resolveNamespace` below for why omitting it entirely means
   * something different: "no signal available, fall back to guessing").
   * Sources with no such signal (`SfdxProjectSource`, `GitRefSource`)
   * should leave this `undefined` so the `fullName` heuristic runs.
   */
  readonly namespacePrefix?: string;
  /**
   * `FileProperties.manageableState`, when available (`OrgSource` only).
   * Refines `excludeManagedPackages` only: a non-empty `namespacePrefix`
   * with `manageableState: 'unmanaged'` means the ORG ITSELF has this
   * namespace (a packaging/dev org) rather than the component belonging to
   * some installed managed package — that must not be excluded by the
   * "hide managed packages" default. Any other value (`'installed'`,
   * `'released'`, `'deprecated'`, `'deprecatedEditable'`,
   * `'installedEditable'`, `'beta'`, `'deleted'`, ...) means it genuinely
   * belongs to another package.
   */
  readonly manageableState?: string;
  /**
   * The identity that last modified this component, when the source can
   * supply one (`OrgSource`: `lastModifiedByName`/`lastModifiedById`;
   * `GitRefSource`: the last commit's author name/email for the
   * component's files). Leave `undefined` when the source has no
   * authorship concept (`SfdxProjectSource`) — `TypeFilter.modifiedBy`
   * then never matches, which is the documented no-op behavior for that
   * source, not a bug.
   */
  readonly modifiedBy?: string;
}

export function matchesTypeFilter(params: MatchParams, filter: TypeFilter): boolean {
  if (filter.types && filter.types.length > 0 && !filter.types.includes(params.type)) return false;

  if (filter.namePatterns && filter.namePatterns.length > 0) {
    if (!filter.namePatterns.some((pattern) => globMatch(pattern, params.fullName))) return false;
  }

  if (filter.modifiedSince && params.lastModifiedDate && params.lastModifiedDate < filter.modifiedSince) return false;

  if (filter.modifiedBy && filter.modifiedBy.length > 0) {
    if (!params.modifiedBy || !filter.modifiedBy.includes(params.modifiedBy)) return false;
  }

  const namespace = resolveNamespace(params);

  if (filter.excludeNamespaces && filter.excludeNamespaces.length > 0) {
    if (namespace && filter.excludeNamespaces.includes(namespace)) return false;
  }

  if (filter.excludeManagedPackages && namespace) {
    // See `manageableState`'s doc comment above: only exclude when we
    // either have no manageableState signal at all (filesystem-heuristic
    // path — any detected namespace is treated as "someone else's
    // package", the best we can do without the API's own signal) or the
    // signal explicitly says this isn't the org's own namespace.
    const isForeignPackage = params.manageableState === undefined || params.manageableState !== 'unmanaged';
    if (isForeignPackage) return false;
  }

  return true;
}

/**
 * Resolves the namespace to use for `excludeNamespaces`/
 * `excludeManagedPackages` matching. Prefers the source's own authoritative
 * `namespacePrefix` signal (passed by `OrgSource`, including as `''` to
 * mean "confirmed no namespace" — that is NOT the same as "no signal", so
 * it is checked with `!== undefined`, not truthiness) over the `fullName`
 * heuristic, which is only ever a fallback for sources that have no such
 * API to ask (`SfdxProjectSource`, `GitRefSource`).
 */
function resolveNamespace(params: { readonly fullName: string; readonly namespacePrefix?: string }): string | undefined {
  if (params.namespacePrefix !== undefined) {
    return params.namespacePrefix === '' ? undefined : params.namespacePrefix;
  }
  return extractNamespace(params.fullName);
}

/**
 * Heuristic namespace extraction from `fullName` alone — used exclusively
 * where no source-native namespace signal exists (see `resolveNamespace`;
 * `OrgSource` never reaches this, it always has `listMetadata`'s own
 * `namespacePrefix`).
 *
 * A namespace prefix always sits at the START of a `fullName` (`ns__Name`),
 * which is a SEPARATE convention from the custom-field/custom-object
 * suffix `__c`, which always sits at the END (`Name__c`) and is not itself
 * a namespace marker — an ordinary custom field/object in an unnamespaced
 * org is `Name__c` (one `__`, not a namespace) while a namespaced one is
 * `ns__Name__c` (two). Getting this wrong in either direction is a real
 * failure mode: too loose and every custom field reads as "in the `Name`
 * namespace"; too strict (requiring two separators unconditionally) and a
 * namespaced type with NO such suffix — `ApexClass`, `StaticResource`,
 * `ApexTrigger`, `Flow`, ... — is never detected at all, since those are
 * namespaced by a SINGLE `__` (`omnistudio__Foo`, the exact shape named in
 * the confirmed Workstream C bug report). The fix: strip a trailing `__c`
 * before counting separators, so both shapes resolve correctly by the same
 * rule — a namespace prefix is whatever comes before the first remaining
 * `__`, if any.
 */
function extractNamespace(fullName: string): string | undefined {
  const withoutCustomSuffix = fullName.endsWith('__c') ? fullName.slice(0, -3) : fullName;
  const separatorIndex = withoutCustomSuffix.indexOf('__');
  if (separatorIndex <= 0) return undefined;
  return withoutCustomSuffix.slice(0, separatorIndex);
}

/**
 * The PRODUCT default (not a mechanical `TypeFilter` default — see
 * `TypeFilter.excludeManagedPackages`'s doc comment): a filter built for a
 * real, user-facing comparison excludes managed-package components unless
 * the caller explicitly opted in (`excludeManagedPackages: false`).
 * Managed-package components are almost never deployable by hand and, on
 * orgs like ARM DEV, dominate the default inventory (~408 ApexClasses,
 * largely `omnistudio__`) — retrieving them is both wasted time (retrieve
 * is 87.8% of cold wall-clock) and a correctness risk (a single corrupt
 * managed `StaticResource` can otherwise abort a whole comparison, the
 * confirmed bug this module exists to fix).
 *
 * Deliberately a named, exported function — not baked into
 * `matchesTypeFilter` or any `MetadataSource.inventory()` — so this
 * default is visible and overridable at exactly the boundary where a
 * `TypeFilter` is constructed for a real comparison (the tRPC routers),
 * never silent.
 */
export function withManagedPackageDefault(filter: TypeFilter): TypeFilter {
  return { ...filter, excludeManagedPackages: filter.excludeManagedPackages ?? true };
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}
