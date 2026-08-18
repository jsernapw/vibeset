import type { DiffResult, DiffStatus } from '@vibeset/core';

export interface TypeGroup {
  readonly type: string;
  readonly results: DiffResult[];
  readonly counts: Record<DiffStatus, number>;
}

/** Groups (already filtered) results by metadata type, sorted by type name. */
export function groupByType(results: readonly DiffResult[]): TypeGroup[] {
  const byType = new Map<string, DiffResult[]>();
  for (const r of results) {
    const list = byType.get(r.key.type);
    if (list) list.push(r);
    else byType.set(r.key.type, [r]);
  }
  const groups: TypeGroup[] = [];
  for (const [type, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const counts: Record<DiffStatus, number> = { new: 0, changed: 0, deleted: 0, identical: 0 };
    for (const r of list) counts[r.status] = (counts[r.status] ?? 0) + 1;
    groups.push({ type, results: list, counts });
  }
  return groups;
}

export function filterResults(
  results: readonly DiffResult[],
  opts: { statuses?: ReadonlySet<DiffStatus>; search?: string },
): DiffResult[] {
  const search = opts.search?.trim().toLowerCase();
  return results.filter((r) => {
    if (opts.statuses && opts.statuses.size > 0 && !opts.statuses.has(r.status)) return false;
    if (search && !r.key.fullName.toLowerCase().includes(search)) return false;
    return true;
  });
}

export type FlatRow =
  | { kind: 'group'; type: string; group: TypeGroup }
  | { kind: 'leaf'; type: string; result: DiffResult };

/** Flattens grouped results into the single list the virtualizer scrolls, honoring which type groups are expanded. */
export function flattenGroups(groups: readonly TypeGroup[], expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const group of groups) {
    rows.push({ kind: 'group', type: group.type, group });
    if (expanded.has(group.type)) {
      for (const result of group.results) rows.push({ kind: 'leaf', type: group.type, result });
    }
  }
  return rows;
}
