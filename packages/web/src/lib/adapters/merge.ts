import { useMemo } from 'react';
import type { ComponentKey, MergeResult } from '@vibeset/core';
import { trpc } from '@/lib/trpc';

/**
 * Adapter boundary for `merge.resolve` (`packages/server/src/trpc/routers/
 * merge.ts`) — the tRPC face of `@vibeset/core`'s `mergeComponent`. This is
 * intentionally a thin wrapper, not a reshape: the route's response
 * (`{ comparisonId, diffStatus, mode, key, entries, summary }`) is already
 * the shape `components/merge/**` wants, unlike `comparisons.results`'
 * flattened rows (`useComparisonResult` in `adapters/comparisons.ts`
 * reshapes those into `DiffResult`). No client-side pagination is needed
 * either — a merge result is one component's decomposed entries, not a
 * whole comparison's worth of rows.
 */

export interface UseMergeResolveArgs {
  readonly comparisonId: string | undefined;
  readonly key: ComponentKey | undefined;
  /** A `git-ref` connection id to attempt a three-way merge against. Omit for two-way. */
  readonly baseConnectionId?: string;
  /** Set false to skip firing the query entirely — e.g. while a type is gated as merge-unsupported. */
  readonly enabled?: boolean;
}

export function useMergeResolve({ comparisonId, key, baseConnectionId, enabled = true }: UseMergeResolveArgs) {
  return trpc.merge.resolve.useQuery(
    {
      comparisonId: comparisonId ?? '',
      type: key?.type ?? '',
      fullName: key?.fullName ?? '',
      parentFullName: key?.parentFullName,
      baseConnectionId,
    },
    {
      enabled: enabled && !!comparisonId && !!key,
      // A merge result is a point-in-time read over already-stored
      // comparison content (see the route's own doc comment) — it can't
      // change behind the user's back within one session, so there's no
      // reason to refetch on window focus like a live org query would.
      staleTime: Infinity,
    },
  ) as { data: MergeResult & { comparisonId: string; diffStatus: string }; isPending: boolean; isError: boolean; error: { message: string } | null; refetch: () => void };
}

export interface GitRefConnectionOption {
  readonly id: string;
  readonly label: string;
}

/** Connections eligible as a three-way merge base — `merge.resolve` hard-errors on anything else (see its `baseConnectionId` doc comment), so the picker only offers what would actually work. */
export function useGitRefConnections(): { options: GitRefConnectionOption[]; isLoading: boolean } {
  const query = trpc.connections.list.useQuery();
  const options = useMemo(
    () => (query.data ?? []).filter((c) => c.kind === 'git-ref').map((c) => ({ id: c.id, label: c.label })),
    [query.data],
  );
  return { options, isLoading: query.isPending };
}
