import type { DiffResult, DiffStatus } from '@vibeset/core';
import { componentKeyToString } from './selection-store';

export type SelectedSortKey = 'type' | 'name' | 'status';

export interface SelectedComponentsOptions {
  readonly search?: string;
  readonly sortKey?: SelectedSortKey;
  /** Grouped-by-type (default) vs. a single flat sorted list. */
  readonly flatten?: boolean;
  readonly collapsedTypes?: ReadonlySet<string>;
}

export type SelectedRow =
  | { readonly kind: 'group'; readonly type: string; readonly results: readonly DiffResult[] }
  | { readonly kind: 'leaf'; readonly result: DiffResult };

/** Narrows `allResults` down to whatever's currently selected — the "what am I about to deploy?" set. */
export function pickSelected(allResults: readonly DiffResult[], selected: ReadonlySet<string>): DiffResult[] {
  return allResults.filter((r) => selected.has(componentKeyToString(r.key)));
}

function compareByKey(sortKey: SelectedSortKey) {
  return (a: DiffResult, b: DiffResult): number => {
    if (sortKey === 'name') return a.key.fullName.localeCompare(b.key.fullName) || a.key.type.localeCompare(b.key.type);
    if (sortKey === 'status') return a.status.localeCompare(b.status) || a.key.fullName.localeCompare(b.key.fullName);
    return a.key.type.localeCompare(b.key.type) || a.key.fullName.localeCompare(b.key.fullName);
  };
}

/** Filters (by name/type substring) and sorts the selected set — the shared logic behind `SelectedComponentsView`'s search + sort controls. */
export function filterAndSortSelected(selectedResults: readonly DiffResult[], opts: SelectedComponentsOptions = {}): DiffResult[] {
  const query = opts.search?.trim().toLowerCase();
  const filtered = query
    ? selectedResults.filter((r) => r.key.fullName.toLowerCase().includes(query) || r.key.type.toLowerCase().includes(query))
    : [...selectedResults];
  return filtered.sort(compareByKey(opts.sortKey ?? 'type'));
}

/**
 * Builds the flat row list the virtualizer scrolls: either a single sorted
 * list ("flatten") or type-grouped headers with collapsible member rows.
 * Grouping always orders groups and members alphabetically regardless of
 * `sortKey`'s tie-break, since a mixed-sort grouped view would be
 * incoherent (see the "sortKey only applies to the flat view" note in
 * `SelectedComponentsView`).
 */
export function buildSelectedRows(sorted: readonly DiffResult[], opts: SelectedComponentsOptions = {}): SelectedRow[] {
  if (opts.flatten) {
    return sorted.map((result) => ({ kind: 'leaf', result }));
  }

  const byType = new Map<string, DiffResult[]>();
  for (const r of sorted) {
    const list = byType.get(r.key.type);
    if (list) list.push(r);
    else byType.set(r.key.type, [r]);
  }

  const rows: SelectedRow[] = [];
  for (const [type, results] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push({ kind: 'group', type, results });
    if (!opts.collapsedTypes?.has(type)) {
      for (const result of results) rows.push({ kind: 'leaf', result });
    }
  }
  return rows;
}

export function countByStatus(results: readonly DiffResult[]): Record<DiffStatus, number> {
  const counts: Record<DiffStatus, number> = { new: 0, changed: 0, deleted: 0, identical: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}
