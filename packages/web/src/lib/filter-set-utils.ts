import type { TypeFilter } from '@vibeset/core';

/**
 * The comparison wizard's "Select types" step edits a full `TypeFilter`,
 * not just `types` — `TypeFilterPanel` already owns the types half
 * (Selected/Available columns); this covers the rest of `TypeFilter`'s
 * dimensions (`namePatterns`, `modifiedSince`, `excludeNamespaces`,
 * `excludeManagedPackages`) as a small, independently testable piece of
 * client-side form state, kept free of React so the parsing/formatting/
 * merging rules can be unit tested without rendering anything.
 */
export interface ScopeFilterFields {
  readonly namePatterns: string[];
  readonly modifiedSince?: string;
  readonly excludeNamespaces: string[];
  /**
   * Mirrors `@vibeset/core`'s `withManagedPackageDefault` product default
   * (managed packages excluded unless the caller opts in) at the UI layer:
   * defaults to `true` here too, so a fresh wizard pass shows the exclusion
   * already ON — visible and overridable, never a silent server-side-only
   * default the user can't see or change. Always sent explicitly (never
   * `undefined`) once a form exists, per `buildTypeFilter` below.
   */
  readonly excludeManagedPackages: boolean;
}

export function defaultScopeFilterFields(): ScopeFilterFields {
  return { namePatterns: [], modifiedSince: undefined, excludeNamespaces: [], excludeManagedPackages: true };
}

/** Splits a comma-separated field (name patterns, namespaces) into a trimmed, non-empty list. Deliberately tolerant of trailing commas / extra whitespace — this backs a free-text `Input`, not a structured picker. */
export function parseCommaList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function formatCommaList(list: readonly string[]): string {
  return list.join(', ');
}

/**
 * Combines the types picker's selection with the rest of the scope fields
 * into one `TypeFilter` ready to send to `comparisons.start`/
 * `inventory.start`/`filters.save`. `excludeManagedPackages` is always
 * included explicitly (see `ScopeFilterFields`'s doc comment) — everything
 * else is omitted when empty so a filter with nothing set round-trips as
 * `{}` rather than `{ namePatterns: [], excludeNamespaces: [] }`, which
 * matters for `filters.save`'s upsert-by-filename semantics and for
 * `TypeFilter`'s own documented "omitted means no restriction" contract.
 */
export function buildTypeFilter(types: readonly string[], scope: ScopeFilterFields): TypeFilter {
  // `TypeFilter`'s fields are `readonly` (see `@vibeset/core`'s
  // `metadata-source.ts`) — build via object-literal spread rather than
  // assigning into a `{}` after the fact.
  return {
    ...(types.length > 0 ? { types: [...types] } : {}),
    ...(scope.namePatterns.length > 0 ? { namePatterns: [...scope.namePatterns] } : {}),
    ...(scope.modifiedSince ? { modifiedSince: scope.modifiedSince } : {}),
    ...(scope.excludeNamespaces.length > 0 ? { excludeNamespaces: [...scope.excludeNamespaces] } : {}),
    excludeManagedPackages: scope.excludeManagedPackages,
  };
}

/** The inverse of `buildTypeFilter`'s scope half — reconstructs form state from a loaded `TypeFilter` (a saved filter set, or a comparison's stored `filter`). `excludeManagedPackages` defaults to `true` when absent, matching the same product default rather than reading an omitted field as "off". */
export function scopeFieldsFromFilter(filter: TypeFilter | undefined): ScopeFilterFields {
  return {
    namePatterns: filter?.namePatterns ? [...filter.namePatterns] : [],
    modifiedSince: filter?.modifiedSince,
    excludeNamespaces: filter?.excludeNamespaces ? [...filter.excludeNamespaces] : [],
    excludeManagedPackages: filter?.excludeManagedPackages ?? true,
  };
}

/** A `TypeFilter` with the same types/namePatterns/modifiedSince but every namespace-related dimension turned off — the "if I didn't filter by namespace at all" baseline `useNamespaceImpactPreview` compares the effective filter against. */
export function withoutNamespaceFiltering(filter: TypeFilter): TypeFilter {
  const { excludeNamespaces: _excludeNamespaces, excludeManagedPackages: _excludeManagedPackages, ...rest } = filter;
  return { ...rest, excludeManagedPackages: false };
}

/** Short human-readable chips summarizing a `TypeFilter`, for a filter-set list/card — e.g. `["37 types", "2 name patterns", "Excludes omnistudio, gearset", "Managed packages excluded"]`. Always includes the managed-packages state (never silently omitted) per the "never silent" requirement on that control. */
export function summarizeTypeFilter(filter: TypeFilter): string[] {
  const chips: string[] = [];
  const typeCount = filter.types?.length ?? 0;
  chips.push(typeCount === 0 ? 'All types' : `${typeCount} type${typeCount === 1 ? '' : 's'}`);

  if (filter.namePatterns && filter.namePatterns.length > 0) {
    chips.push(`${filter.namePatterns.length} name pattern${filter.namePatterns.length === 1 ? '' : 's'}`);
  }
  if (filter.modifiedSince) chips.push(`Modified since ${filter.modifiedSince}`);
  if (filter.excludeNamespaces && filter.excludeNamespaces.length > 0) {
    chips.push(`Excludes ${filter.excludeNamespaces.join(', ')}`);
  }
  chips.push(filter.excludeManagedPackages === false ? 'Managed packages included' : 'Managed packages excluded');
  return chips;
}

export interface NamespaceImpact {
  readonly removed: number;
  readonly removedPercent: number;
}

/** `before`/`after` component counts -> how many were removed and what fraction that is, for the impact preview's "X of Y components excluded" line. Guards `before === 0` so an empty org never divides by zero. */
export function computeNamespaceImpact(before: number, after: number): NamespaceImpact {
  const removed = Math.max(0, before - after);
  const removedPercent = before > 0 ? Math.round((removed / before) * 1000) / 10 : 0;
  return { removed, removedPercent };
}
