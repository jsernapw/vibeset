import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DeploymentRecord } from '@/lib/types/deployment';

const ROW_HEIGHT = 40;

const STATUS_ICON = {
  succeeded: <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
  failed: <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />,
  skipped: <CircleDashed className="h-4 w-4 text-neutral-400" />,
  pending: <CircleDashed className="h-4 w-4 text-neutral-300" />,
  'in-progress': <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />,
} as const;

/** Live per-component deployment results, virtualized so a large package doesn't jank the browser while streaming. */
export function DeployMonitor({ record, onCancel }: { record: DeploymentRecord; onCancel?: () => void }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = record.componentResults;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const percent = record.numberComponentsTotal > 0 ? Math.round(((record.numberComponentsDeployed + record.numberComponentErrors) / record.numberComponentsTotal) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Progress value={percent} className="flex-1" />
        <span className="w-12 shrink-0 text-right text-sm text-neutral-500">{percent}%</span>
        {record.status === 'in-progress' && onCancel && (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant={record.status === 'succeeded' ? 'success' : record.status === 'failed' ? 'error' : record.status === 'canceled' ? 'neutral' : 'info'}>
          {record.status}
        </Badge>
        <span className="text-neutral-500">
          {record.numberComponentsDeployed.toLocaleString()} deployed · {record.numberComponentErrors.toLocaleString()} errors ·{' '}
          {record.numberComponentsTotal.toLocaleString()} total
        </span>
        {record.testResults && (
          <span className="text-neutral-500">
            · {record.testResults.numberRun} tests, {record.testResults.numberFailures} failures, {record.testResults.coveragePercent}% coverage
          </span>
        )}
      </div>

      <div ref={parentRef} className="h-96 overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div
                key={`${row.key.type}-${row.key.fullName}-${vi.index}`}
                className="absolute left-0 top-0 flex w-full flex-col justify-center gap-0.5 border-b border-neutral-50 px-3 dark:border-neutral-900"
                style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
              >
                <div className="flex items-center gap-2 text-sm">
                  {STATUS_ICON[row.status]}
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {row.key.type}
                  </Badge>
                  <span className="truncate font-mono text-xs">{row.key.fullName}</span>
                </div>
                {row.status === 'failed' && row.errorMessage && (
                  <p className={cn('truncate pl-6 text-xs text-red-600 dark:text-red-400')} title={row.errorMessage}>
                    {row.lineNumber ? `L${row.lineNumber}${row.columnNumber ? `:${row.columnNumber}` : ''} — ` : ''}
                    {row.errorMessage}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
