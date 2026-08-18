import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, ListX, SearchX } from 'lucide-react';
import type { DiffResult } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { componentKeyToString, useSelectionStore } from '@/lib/selection-store';
import { buildSelectedRows, filterAndSortSelected, pickSelected, type SelectedSortKey } from '@/lib/selected-components';

const ROW_HEIGHT = 32;

const SORT_LABEL: Record<SelectedSortKey, string> = {
  type: 'Type',
  name: 'Name',
  status: 'Status',
};

/**
 * The cross-type "what am I about to deploy?" view: every currently
 * selected component across ALL metadata types in one searchable, sortable
 * list, groupable by type or flattenable, with per-row and per-group
 * deselect. First-class screen (not a modal) so it's reachable as its own
 * tab from Review differences and reused as-is on the Review & deploy step.
 * Virtualized with TanStack Virtual for the same reason the results tree
 * is — a selection can itself run into the tens of thousands of rows.
 */
export function SelectedComponentsView({ results, className }: { results: readonly DiffResult[]; className?: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const selected = useSelectionStore((s) => s.selected);
  const setLeaf = useSelectionStore((s) => s.setLeaf);
  const setGroup = useSelectionStore((s) => s.setGroup);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SelectedSortKey>('type');
  const [flatten, setFlatten] = useState(false);
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());

  const selectedResults = useMemo(() => pickSelected(results, selected), [results, selected]);
  const sorted = useMemo(
    () => filterAndSortSelected(selectedResults, { search, sortKey: flatten ? sortKey : 'type' }),
    [selectedResults, search, sortKey, flatten],
  );
  const rows = useMemo(
    () => buildSelectedRows(sorted, { flatten, collapsedTypes }),
    [sorted, flatten, collapsedTypes],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const toggleCollapsed = (type: string) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className={cn('flex h-full flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search selected components..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex gap-1 rounded-md border border-neutral-200 p-0.5 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setFlatten(false)}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium',
              !flatten
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900',
            )}
          >
            Grouped by type
          </button>
          <button
            type="button"
            onClick={() => setFlatten(true)}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium',
              flatten
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900',
            )}
          >
            Flat list
          </button>
        </div>
        {flatten && (
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SelectedSortKey)}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABEL) as SelectedSortKey[]).map((key) => (
                <SelectItem key={key} value={key}>
                  Sort by {SORT_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="ml-auto text-xs text-neutral-400">
          {selectedResults.length.toLocaleString()} selected
          {search && ` · ${sorted.length.toLocaleString()} matching`}
        </span>
      </div>

      {selectedResults.length === 0 ? (
        <EmptyState
          icon={ListX}
          title="Nothing selected"
          description="Check components in the results tree to build your deployment package. They'll show up here across every metadata type."
          className="flex-1"
        />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={SearchX} title="No matches" description="Nothing selected matches that search." />
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800" data-testid="selected-components-scroll">
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              if (row.kind === 'group') {
                const isOpen = !collapsedTypes.has(row.type);
                const keyStrs = row.results.map((r) => componentKeyToString(r.key));
                return (
                  <div
                    key={`group-${row.type}`}
                    data-index={virtualRow.index}
                    className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-neutral-100 bg-neutral-50 px-2 text-sm font-medium dark:border-neutral-900 dark:bg-neutral-900/60"
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <button type="button" onClick={() => toggleCollapsed(row.type)} className="flex flex-1 items-center gap-1.5 text-left">
                      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform', isOpen && 'rotate-90')} />
                      <span>{row.type}</span>
                      <span className="text-neutral-400">({row.results.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGroup(keyStrs, false)}
                      className="shrink-0 text-xs font-medium text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                    >
                      Remove all
                    </button>
                  </div>
                );
              }

              const keyStr = componentKeyToString(row.result.key);
              return (
                <div
                  key={keyStr}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-neutral-50 px-2 pl-8 text-sm dark:border-neutral-900/50"
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {row.result.key.type}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.result.key.fullName}</span>
                  <Badge variant={row.result.status} className="shrink-0">
                    {row.result.status}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setLeaf(keyStr, false)}
                    aria-label={`Deselect ${row.result.key.fullName}`}
                    className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-900 dark:hover:text-red-400"
                  >
                    <ListX className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
