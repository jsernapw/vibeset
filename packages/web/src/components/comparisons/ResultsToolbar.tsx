import type { DiffStatus } from '@vibeset/core';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatPercent } from '@/lib/format';
import type { CacheStats } from '@/lib/types/comparison';

const STATUS_ORDER: DiffStatus[] = ['new', 'changed', 'deleted', 'identical'];

export function ResultsToolbar({
  summary,
  statuses,
  onToggleStatus,
  search,
  onSearchChange,
  cacheStats,
}: {
  summary: Record<DiffStatus, number>;
  statuses: ReadonlySet<DiffStatus>;
  onToggleStatus: (status: DiffStatus) => void;
  search: string;
  onSearchChange: (value: string) => void;
  cacheStats: CacheStats;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
      <Input
        placeholder="Filter by name..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs"
      />
      <div className="flex gap-1">
        {STATUS_ORDER.map((status) => {
          const active = statuses.size === 0 || statuses.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => onToggleStatus(status)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium capitalize transition-colors',
                active
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-200 text-neutral-400 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900',
              )}
            >
              {status} <span className="opacity-70">{summary[status]}</span>
            </button>
          );
        })}
      </div>
      <div className="ml-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400">
              <span>{formatPercent(cacheStats.hitRatePercent, 1)} cache hit</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            Retrieved {cacheStats.retrievedComponents.toLocaleString()} of {cacheStats.totalComponents.toLocaleString()} components
            &mdash; {cacheStats.cacheHits.toLocaleString()} served from the content-addressed cache.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
