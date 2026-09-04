import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ComponentKey } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useGitRefConnections, useMergeResolve } from '@/lib/adapters/merge';
import { computeResolutionCounts, applyResolution, clearResolution, type UserResolution } from '@/lib/merge-resolution';
import { isMergeChildCollectionsUnsupported } from '@/lib/metadata-types';
import { componentKeyToString } from '@/lib/selection-store';
import { MergeModeBanner } from './MergeModeBanner';
import { MergeEntryTable } from './MergeEntryTable';

/**
 * The conflict-resolution surface for one component — VibeSet's headline
 * differentiator over Gearset's "stops at every conflict for manual
 * resolution" (no auto-merge). Fetches `merge.resolve` for real (never
 * fabricated) entries, shows the two-way/three-way mode honestly (see
 * `MergeModeBanner`), and lets the user accept-left/accept-right/leave
 * unresolved per conflicting entry. Resolution choices are UI-local state
 * only — `merge.resolve` is a read-only query with no persistence side of
 * its own (see the route's doc comment in `packages/server/src/trpc/
 * routers/merge.ts`); wiring a chosen resolution into an actual deploy
 * package is follow-up work flagged in this session's PR body, not
 * something this panel can honestly claim to do yet.
 */
export function MergeResolutionPanel({
  comparisonId,
  resultKey,
  leftLabel,
  rightLabel,
}: {
  comparisonId: string | undefined;
  resultKey: ComponentKey;
  leftLabel: string;
  rightLabel: string;
}) {
  const [baseConnectionId, setBaseConnectionId] = useState<string | undefined>(undefined);
  const [resolutions, setResolutions] = useState<Map<string, UserResolution>>(new Map());

  const { options: gitRefOptions } = useGitRefConnections();
  const unsupported = isMergeChildCollectionsUnsupported(resultKey.type);

  const query = useMergeResolve({
    comparisonId,
    key: resultKey,
    baseConnectionId,
    enabled: !unsupported,
  });

  // A fresh component (or a fresh base) starts with no user picks — carrying
  // stale resolutions across to a different merge would silently apply
  // yesterday's decision to today's entry.
  useEffect(() => {
    setResolutions(new Map());
  }, [comparisonId, resultKey.type, resultKey.fullName, resultKey.parentFullName, baseConnectionId]);

  if (unsupported) {
    return (
      <div className="flex h-full flex-col gap-3">
        <EmptyState
          icon={AlertTriangle}
          title={`Entry-level merge not yet supported for ${resultKey.type}`}
          description={
            `${resultKey.type}'s child collections (fields, list views, record types, ...) are stored as separate files ` +
            `by Salesforce's source format, and VibeSet's content resolver currently only reads back the object-level ` +
            `shell — so a merge here could only ever show scalar object properties, never the actual field-level ` +
            `changes. Rather than render a merge that looks complete while silently missing every field conflict, this ` +
            `is refused outright until that gap is closed. Profile/PermissionSet merge works today; ${resultKey.type} ` +
            `support is in progress.`
          }
        />
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex h-full flex-col gap-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="min-h-0 flex-1" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not resolve this merge"
        description={query.error?.message ?? 'The server could not compute a merge for this component.'}
      />
    );
  }

  const result = query.data;
  const counts = computeResolutionCounts(result.entries, resolutions);
  const baseLabel = gitRefOptions.find((o) => o.id === baseConnectionId)?.label;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="merge-resolution-panel">
      <MergeModeBanner
        mode={result.mode}
        baseLabel={baseLabel}
        gitRefOptions={gitRefOptions}
        selectedBaseId={baseConnectionId}
        onSelectBase={setBaseConnectionId}
      />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-neutral-400" title={componentKeyToString(resultKey)}>
          {leftLabel} <span className="text-neutral-300">↔</span> {rightLabel}
        </span>
        <Badge variant="neutral">{counts.unchanged} unchanged</Badge>
        <Badge variant="info">{result.summary['take-left']} auto → left</Badge>
        <Badge variant="success">{result.summary['take-right']} auto → right</Badge>
        <Badge variant={counts.conflictsOpen > 0 ? 'error' : 'success'}>
          {counts.conflictsOpen > 0
            ? `${counts.conflictsOpen} of ${counts.conflictsTotal} conflicts need your decision`
            : counts.conflictsTotal > 0
              ? `all ${counts.conflictsTotal} conflicts resolved`
              : 'no conflicts'}
        </Badge>
      </div>

      <MergeEntryTable
        entries={result.entries}
        mode={result.mode}
        resolutions={resolutions}
        onResolve={(path, choice) => setResolutions((prev) => applyResolution(prev, path, choice))}
        onClear={(path) => setResolutions((prev) => clearResolution(prev, path))}
      />
    </div>
  );
}
