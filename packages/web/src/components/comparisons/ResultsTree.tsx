import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, SearchX } from 'lucide-react';
import type { DiffResult } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { componentKeyToString, computeGroupTriState, useSelectionStore } from '@/lib/selection-store';
import { flattenGroups, type TypeGroup } from '@/lib/comparison-tree';

const ROW_HEIGHT = 32;

/**
 * The comparison results tree: grouped by metadata type, virtualized with
 * TanStack Virtual so a 50k+-row comparison never renders more than the
 * visible window into the DOM. Tri-state selection propagates parent
 * (type header) <-> child (component row) both ways.
 */
export function ResultsTree({
  groups,
  expanded,
  onToggleExpand,
  selectedResultKey,
  onSelectResult,
}: {
  groups: TypeGroup[];
  expanded: ReadonlySet<string>;
  onToggleExpand: (type: string) => void;
  selectedResultKey?: string;
  onSelectResult: (result: DiffResult) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const selected = useSelectionStore((s) => s.selected);
  const setLeaf = useSelectionStore((s) => s.setLeaf);
  const setGroup = useSelectionStore((s) => s.setGroup);

  const rows = useMemo(() => flattenGroups(groups, expanded), [groups, expanded]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={SearchX}
          title="No matching components"
          description="Nothing matches the current name filter and status filters. Try a different search term or clear a filter."
        />
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto" data-testid="results-tree-scroll">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;

          if (row.kind === 'group') {
            const keyStrs = row.group.results.map((r) => componentKeyToString(r.key));
            const triState = computeGroupTriState(selected, keyStrs);
            const isOpen = expanded.has(row.type);
            return (
              <div
                key={`group-${row.type}`}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-neutral-100 bg-neutral-50 px-2 text-sm font-medium dark:border-neutral-900 dark:bg-neutral-900/60"
                style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
              >
                <Checkbox
                  checked={triState === 'checked' ? true : triState === 'indeterminate' ? 'indeterminate' : false}
                  onCheckedChange={(c) => setGroup(keyStrs, c === true)}
                  aria-label={`Select all ${row.type}`}
                />
                <button
                  type="button"
                  onClick={() => onToggleExpand(row.type)}
                  className="flex flex-1 items-center gap-1.5 text-left"
                >
                  <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform', isOpen && 'rotate-90')} />
                  <span>{row.type}</span>
                  <span className="text-neutral-400">({row.group.results.length})</span>
                </button>
                <div className="flex shrink-0 gap-1">
                  {row.group.counts.new > 0 && <Badge variant="new">{row.group.counts.new} new</Badge>}
                  {row.group.counts.changed > 0 && <Badge variant="changed">{row.group.counts.changed} changed</Badge>}
                  {row.group.counts.deleted > 0 && <Badge variant="deleted">{row.group.counts.deleted} deleted</Badge>}
                </div>
              </div>
            );
          }

          const keyStr = componentKeyToString(row.result.key);
          const isChecked = selected.has(keyStr);
          const isActive = keyStr === selectedResultKey;
          return (
            <div
              key={keyStr}
              data-index={virtualRow.index}
              onClick={() => onSelectResult(row.result)}
              className={cn(
                'absolute left-0 top-0 flex w-full cursor-pointer items-center gap-2 border-b border-neutral-50 px-2 pl-8 text-sm hover:bg-neutral-50 dark:border-neutral-900/50 dark:hover:bg-neutral-900',
                isActive && 'bg-neutral-100 dark:bg-neutral-800',
              )}
              style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
            >
              <Checkbox
                checked={isChecked}
                onCheckedChange={(c) => setLeaf(keyStr, c === true)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${row.result.key.fullName}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.result.key.fullName}</span>
              <Badge variant={row.result.status} className="shrink-0">
                {row.result.status}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}
