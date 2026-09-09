import { useCallback, useMemo, useState } from 'react';
import type { ComponentKey } from '@vibeset/core';
import { trpc, jobProgressWsUrl } from '@/lib/trpc';
import type { ImpactNodeLike } from '@/lib/dependency-graph';

/**
 * Adapter boundary for the `dependencies` tRPC router (packages/server/
 * src/trpc/routers/dependencies.ts, landed in PR #17) — mirrors the shape
 * `adapters/comparisons.ts` established: route/component files never call
 * `trpc.dependencies.*` directly, they go through hooks here.
 */

export interface DependencySyncRunSummary {
  readonly id: string;
  readonly status: string;
  readonly orgEdgeCount: number | null;
  readonly supplementedEdgeCount: number | null;
  readonly managedPackageEdgeCount: number | null;
  readonly knownGaps: readonly string[];
  readonly createdAt: string | null;
  readonly completedAt: string | null;
  readonly errors?: readonly string[];
}

/** Last few sync runs for a connection, newest first — backs the "graph last refreshed" indicator and the disclosed coverage-gap text (see `KNOWN_COVERAGE_GAPS` in `@vibeset/core`). */
export function useDependencySyncRuns(connectionId: string | undefined) {
  const query = trpc.dependencies.syncRuns.useQuery(
    { connectionId: connectionId ?? '', limit: 5 },
    { enabled: !!connectionId },
  );
  return {
    runs: (query.data ?? []) as DependencySyncRunSummary[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

interface WsProgressMessage {
  readonly status: string;
  readonly percent: number;
  readonly message?: string;
}

export type SyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';

/**
 * Kicks off `dependencies.sync` (a read-only Tooling API query against the
 * connection's org — never a deploy/validate) and follows its progress the
 * same enqueue -> `/ws/jobs/:jobId` pattern `useRunComparison` uses.
 */
export function useSyncDependencies() {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('');
  const syncMutation = trpc.dependencies.sync.useMutation();
  const utils = trpc.useUtils();

  const run = useCallback(
    (connectionId: string) => {
      setStatus('running');
      setPercent(0);
      setMessage('Starting dependency sync...');

      syncMutation.mutate(
        { connectionId },
        {
          onSuccess: ({ jobId }) => {
            const ws = new WebSocket(jobProgressWsUrl(jobId));
            ws.onmessage = (event) => {
              const p = JSON.parse(event.data as string) as WsProgressMessage;
              setPercent(p.percent);
              setMessage(p.message ?? '');
              if (p.status === 'succeeded') {
                setStatus('succeeded');
                ws.close();
                void utils.dependencies.syncRuns.invalidate({ connectionId });
              } else if (p.status === 'failed' || p.status === 'canceled') {
                setStatus('failed');
                setMessage(p.message ?? 'Dependency sync failed.');
                ws.close();
              }
            };
            ws.onerror = () => {
              setStatus('failed');
              setMessage('Lost connection to the dependency sync job.');
            };
          },
          onError: (err) => {
            setStatus('failed');
            setMessage(err.message);
          },
        },
      );
    },
    [syncMutation, utils],
  );

  return { status, percent, message, run };
}

export type ImpactDirection = 'forward' | 'reverse';

/**
 * One direction of transitive impact for a focus component —
 * `dependencies.impact`. Disabled (no request fired) whenever `seed` is
 * absent, exactly like `useComponentContent`'s `enabled` guard in
 * `adapters/comparisons.ts`.
 */
export function useDependencyImpact(
  connectionId: string | undefined,
  seed: ComponentKey | undefined,
  direction: ImpactDirection,
  maxDepth: number,
) {
  const query = trpc.dependencies.impact.useQuery(
    {
      connectionId: connectionId ?? '',
      seeds: seed ? [seed] : [],
      direction,
      maxDepth,
    },
    { enabled: !!connectionId && !!seed },
  );
  return {
    nodes: (query.data?.nodes ?? []) as ImpactNodeLike[],
    knownCoverageGaps: query.data?.knownCoverageGaps ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}

/** Convenience wrapper: both directions for the same focus component/depth, as one hook so a page doesn't juggle two separate loading states by hand. */
export function useDependencyImpactBoth(connectionId: string | undefined, seed: ComponentKey | undefined, maxDepth: number) {
  const forward = useDependencyImpact(connectionId, seed, 'forward', maxDepth);
  const reverse = useDependencyImpact(connectionId, seed, 'reverse', maxDepth);
  const knownCoverageGaps = useMemo(
    () => (forward.knownCoverageGaps.length > 0 ? forward.knownCoverageGaps : reverse.knownCoverageGaps),
    [forward.knownCoverageGaps, reverse.knownCoverageGaps],
  );
  return {
    forward,
    reverse,
    knownCoverageGaps,
    isLoading: forward.isLoading || reverse.isLoading,
  };
}
