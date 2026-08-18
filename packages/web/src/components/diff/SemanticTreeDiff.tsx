import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DiffEntry } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';

function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function TreeNode({ entry, depth }: { entry: DiffEntry; depth: number }) {
  const hasChildren = !!entry.children && entry.children.length > 0;
  const [open, setOpen] = useState(depth < 1);

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900',
          entry.status === 'identical' && 'opacity-60',
        )}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Badge variant={entry.status} className="w-[74px] shrink-0 justify-center">
          {entry.status}
        </Badge>
        <span className="shrink-0 font-mono text-xs text-neutral-500 dark:text-neutral-400">{entry.key}</span>
        {!hasChildren && (
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate font-mono text-xs">
            {entry.status === 'changed' ? (
              <>
                <span className="truncate text-red-600 line-through dark:text-red-400">{formatValue(entry.before)}</span>
                <span className="text-neutral-400">→</span>
                <span className="truncate text-emerald-700 dark:text-emerald-400">{formatValue(entry.after)}</span>
              </>
            ) : entry.status === 'new' ? (
              <span className="truncate text-emerald-700 dark:text-emerald-400">{formatValue(entry.after)}</span>
            ) : entry.status === 'deleted' ? (
              <span className="truncate text-red-600 line-through dark:text-red-400">{formatValue(entry.before)}</span>
            ) : (
              <span className="truncate text-neutral-500 dark:text-neutral-400">{formatValue(entry.before ?? entry.after)}</span>
            )}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <div>
          {entry.children!.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a `DiffEntry[]` semantic tree diff — collapsible, keyed by natural
 * key (`entry.key`/`entry.path`), never array position. This is the whole
 * point of the diff engine over a raw XML line diff: a reordered `<fields>`
 * block shows as no change here.
 */
export function SemanticTreeDiff({ entries }: { entries?: DiffEntry[] }) {
  if (!entries || entries.length === 0) {
    return <EmptyState title="No structural changes" description="This component has no decomposable entries to compare." />;
  }
  return (
    <div className="flex flex-col rounded-md border border-neutral-200 py-1 dark:border-neutral-800">
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
