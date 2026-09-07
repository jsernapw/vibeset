import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Undo2 } from 'lucide-react';
import type { MergeEntry, MergeEntryStatus, MergeMode } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  categoryLabel,
  filterMergeEntries,
  formatMergeValue,
  groupMergeEntriesByCategory,
  type MergeStatusFilter,
  type UserResolution,
} from '@/lib/merge-resolution';

const ROW_HEIGHT = 40;

const STATUS_BADGE_VARIANT: Record<MergeEntryStatus, 'neutral' | 'info' | 'success' | 'error'> = {
  unchanged: 'neutral',
  'take-left': 'info',
  'take-right': 'success',
  conflict: 'error',
};

/**
 * Per-entry conflict-resolution surface: one row per decomposed merge
 * entry, grouped into tabs by category exactly like `PermissionGrid.tsx`
 * groups diff entries, but virtualized (TanStack Virtual, the same pattern
 * `SelectedComponentsView.tsx` uses) because a Profile can carry thousands
 * of entries and this table additionally has to stay responsive while the
 * user is actively clicking through conflicts — see the Workstream E brief
 * ("verify DOM node count stays bounded").
 *
 * Deliberately does NOT surface `unchanged`/auto-resolved rows any louder
 * than a quiet badge: the entire point of entry-level merge over Gearset's
 * whole-file "stop at every conflict" is that genuine conflicts should be
 * rare and easy to find, so this table's search/status filter defaults
 * make it trivial to look at conflicts only.
 */
export function MergeEntryTable({
  entries,
  mode,
  resolutions,
  onResolve,
  onClear,
}: {
  entries: readonly MergeEntry[];
  mode: MergeMode;
  resolutions: ReadonlyMap<string, UserResolution>;
  onResolve: (path: string, choice: UserResolution) => void;
  onClear: (path: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<MergeStatusFilter>('all');

  const categories = useMemo(() => groupMergeEntriesByCategory(entries), [entries]);
  const [activeTab, setActiveTab] = useState<string | undefined>(categories[0]?.[0]);
  const effectiveTab = activeTab && categories.some(([c]) => c === activeTab) ? activeTab : categories[0]?.[0];

  const activeEntries = categories.find(([c]) => c === effectiveTab)?.[1] ?? [];
  const filtered = useMemo(
    () => filterMergeEntries(activeEntries, { search, statusFilter }),
    [activeEntries, search, statusFilter],
  );

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  if (categories.length === 0) {
    return <EmptyState title="No merge entries" description="This component has no decomposed entries to merge." />;
  }

  const showBase = mode === 'three-way';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Tabs value={effectiveTab} onValueChange={setActiveTab}>
        <TabsList>
          {categories.map(([cat, list]) => {
            const conflicts = list.filter((e) => e.status === 'conflict').length;
            return (
              <TabsTrigger key={cat} value={cat}>
                {categoryLabel(cat)}
                <span className="ml-1.5 text-neutral-400">{list.length}</span>
                {conflicts > 0 && (
                  <Badge variant="error" className="ml-1.5">
                    {conflicts}
                  </Badge>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {categories.map(([cat]) => (
          <TabsContent key={cat} value={cat} />
        ))}
      </Tabs>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex gap-1">
          {(['all', 'conflict', 'take-left', 'take-right', 'unchanged'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium capitalize',
                statusFilter === s
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900',
              )}
            >
              {s === 'all' ? 'all' : s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
          {filtered.length.toLocaleString()} of {activeEntries.length.toLocaleString()}
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-neutral-200 px-2 pb-1.5 text-xs font-medium uppercase text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <span className="w-[26%] min-w-0">Entry</span>
        <span className="w-20 shrink-0">Status</span>
        <span className="min-w-0 flex-1">Left</span>
        <span className="min-w-0 flex-1">Right</span>
        {showBase && <span className="min-w-0 flex-1">Base</span>}
        <span className="w-44 shrink-0 text-right">Resolution</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No entries match" description="Nothing in this category matches the current search/filter." className="flex-1" />
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800" data-testid="merge-entry-scroll">
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = filtered[virtualRow.index];
              if (!entry) return null;
              const resolution = resolutions.get(entry.path);
              return (
                <div
                  key={entry.path}
                  data-index={virtualRow.index}
                  data-testid="merge-entry-row"
                  className={cn(
                    'absolute left-0 top-0 flex w-full items-center gap-2 border-b border-neutral-100 px-2 text-xs dark:border-neutral-900',
                    entry.status === 'conflict' && !resolution && 'bg-red-50/60 dark:bg-red-950/30',
                  )}
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <span className="w-[26%] min-w-0 truncate font-mono" title={entry.key}>
                    {entry.key}
                  </span>
                  <span className="w-20 shrink-0">
                    <Badge variant={STATUS_BADGE_VARIANT[entry.status]}>{entry.status}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-400" title={formatMergeValue(entry.left)}>
                    {formatMergeValue(entry.left)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-400" title={formatMergeValue(entry.right)}>
                    {formatMergeValue(entry.right)}
                  </span>
                  {showBase && (
                    <span className="min-w-0 flex-1 truncate text-neutral-400" title={formatMergeValue(entry.base)}>
                      {formatMergeValue(entry.base)}
                    </span>
                  )}
                  <span className="flex w-44 shrink-0 items-center justify-end gap-1">
                    {entry.status !== 'conflict' ? (
                      <span className="text-neutral-400">
                        {entry.status === 'unchanged' ? 'no change' : `auto → ${entry.status === 'take-left' ? 'left' : 'right'}`}
                      </span>
                    ) : resolution ? (
                      <>
                        <Badge variant={resolution === 'left' ? 'info' : 'success'}>
                          <Check className="h-3 w-3" /> {resolution}
                        </Badge>
                        <button
                          type="button"
                          onClick={() => onClear(entry.path)}
                          aria-label={`Clear resolution for ${entry.key}`}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onResolve(entry.path, 'left')}
                          className="rounded border border-neutral-200 px-1.5 py-0.5 font-medium text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                        >
                          Accept left
                        </button>
                        <button
                          type="button"
                          onClick={() => onResolve(entry.path, 'right')}
                          className="rounded border border-neutral-200 px-1.5 py-0.5 font-medium text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                        >
                          Accept right
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
