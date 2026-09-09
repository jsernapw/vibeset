import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { DependencySyncRunSummary, SyncStatus } from '@/lib/adapters/dependencies';
import { formatRelativeTime } from '@/lib/format';

export interface SyncStatusPanelProps {
  readonly runs: readonly DependencySyncRunSummary[];
  readonly isLoading: boolean;
  readonly syncStatus: SyncStatus;
  readonly syncPercent: number;
  readonly syncMessage: string;
  readonly onSync: () => void;
}

/**
 * "How fresh is this graph, and did it fully sync" — surfaced up front
 * because everything else on this page (impact lists, the graph) is only
 * as trustworthy as the last successful sync. Sync itself is a read-only
 * Tooling API query (`MetadataComponentDependency`), never a deploy or
 * validate, so it's safe to trigger against RCA DEV / ARM DEV directly
 * from here.
 */
export function SyncStatusPanel({ runs, isLoading, syncStatus, syncPercent, syncMessage, onSync }: SyncStatusPanelProps) {
  const lastSucceeded = runs.find((r) => r.status === 'succeeded');
  const isRunning = syncStatus === 'running';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-col gap-0.5">
        {isLoading ? (
          <span className="text-neutral-400">Checking sync status...</span>
        ) : lastSucceeded ? (
          <>
            <span>
              Last synced <span className="font-medium">{formatRelativeTime(lastSucceeded.completedAt ?? lastSucceeded.createdAt ?? '')}</span> &mdash;{' '}
              {(lastSucceeded.orgEdgeCount ?? 0).toLocaleString()} org edges, {(lastSucceeded.supplementedEdgeCount ?? 0).toLocaleString()} supplemented,{' '}
              {(lastSucceeded.managedPackageEdgeCount ?? 0).toLocaleString()} managed-package.
            </span>
          </>
        ) : (
          <span className="text-neutral-500 dark:text-neutral-400">This connection has never been synced — impact analysis will be empty until it is.</span>
        )}
        {isRunning && (
          <span className="text-neutral-500 dark:text-neutral-400">
            {syncPercent}% &mdash; {syncMessage}
          </span>
        )}
        {syncStatus === 'failed' && <span className="text-red-600 dark:text-red-400">{syncMessage || 'Sync failed.'}</span>}
      </div>
      <div className="flex items-center gap-2">
        {syncStatus === 'succeeded' && <Badge variant="success">Synced</Badge>}
        <Button size="sm" variant="outline" onClick={onSync} disabled={isRunning}>
          <RefreshCw className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} /> {isRunning ? 'Syncing...' : 'Sync now'}
        </Button>
      </div>
    </div>
  );
}
