import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffResult, DiffStatus, TypeFilter } from '@vibeset/core';
import { trpc, jobProgressWsUrl } from '@/lib/trpc';
import type { CacheStats } from '@/lib/types/comparison';

/**
 * Adapter boundary for comparison orchestration — now backed by
 * `packages/server`'s real `comparisons.*` tRPC router instead of the
 * client-side `generateMockComparison` fabrication engine this file used to
 * call (see `lib/mock/comparison-mock.ts`'s doc comment for the bug that
 * caused). Every exported hook keeps its original name and shape so
 * `components/comparisons/**`/`routes/**` (owned by a parallel workstream)
 * did not need to change:
 *
 * - `useRunComparison()` needed NO signature change: `run()` was already
 *   fire-and-forget (updates local `status`/`percent`/`comparisonId` state
 *   over time, consumed reactively), which is exactly the shape a real
 *   enqueue-job-then-follow-progress flow needs. It now calls
 *   `comparisons.start`, streams `/ws/jobs/:jobId` (same pattern as
 *   `DemoJobWidget`/`AddOrgDialog`), and on `'succeeded'` fetches the
 *   comparison's summary for the "recent comparisons" list.
 *
 * - `useComparisonResult(comparisonId)` also needed no signature change: it
 *   returns `undefined` while loading exactly as before (the page already
 *   renders "Loading comparison..." for that case) — internally it's now an
 *   async fetch instead of a synchronous `useMemo`. Because a real
 *   comparison can return 50k+ rows and the results tree
 *   (`components/comparisons/ResultsTree.tsx`) expects one flat
 *   `results: DiffResult[]` array, this pages through
 *   `comparisons.results` (max 5000/page, per the server's scale-aware
 *   limit) and concatenates client-side. That's an interim measure to match
 *   the existing full-array contract — the real fix for very large
 *   comparisons is for the results tree to consume paginated data directly,
 *   which is out of this file's ownership boundary
 *   (`components/comparisons/**`). Flagged in this session's final report.
 */

export interface SourceOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'org' | 'sfdx-project' | 'git-ref';
}

export function useSourceOptions() {
  const query = trpc.connections.list.useQuery();
  const options: SourceOption[] = useMemo(
    () => (query.data ?? []).map((c) => ({ id: c.id, label: c.label, kind: c.kind as SourceOption['kind'] })),
    [query.data],
  );
  return { options, isLoading: query.isPending, error: query.error };
}

export interface AvailableTypesData {
  /** Every metadata type name SDR's `RegistryAccess` can resolve (~418), sorted. */
  readonly all: string[];
  /** The curated ~33-type subset a comparison uses when no explicit filter is given — see `sources/registry.ts`'s `DEFAULT_INVENTORY_TYPES` doc comment in `@vibeset/core`. */
  readonly default: string[];
}

/**
 * Backs the "Select metadata types" step's picker (`TypeFilterPanel`) with
 * `inventory.availableTypes` — pure registry data, no connection required,
 * so this loads independently of which sources were chosen. Replaces the
 * old hardcoded `PHASE1_METADATA_TYPES` list (`lib/metadata-types.ts`),
 * which drifted from what the diff/retrieval engines actually support the
 * moment either one grew past Phase 1's original 11 types.
 */
export function useAvailableTypes() {
  const query = trpc.inventory.availableTypes.useQuery(undefined, {
    // Registry data is static for the life of the server process — no
    // reason to refetch on every window focus like a live org query would.
    staleTime: Infinity,
  });
  return {
    data: query.data as AvailableTypesData | undefined,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface ComparisonResultData {
  readonly comparisonId: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly results: DiffResult[];
  readonly summary: Record<DiffStatus, number>;
  readonly cacheStats: CacheStats;
}

// Session-only recent-comparisons list (the page literally labels it "this
// session") — populated as real comparisons succeed. Real full history is
// available via `comparisons.list`; this is just a lightweight recency
// shortcut, same role the mock version played.
export interface RecentComparison {
  readonly comparisonId: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly runAt: string;
  readonly summary: Record<DiffStatus, number>;
}
const recentComparisons: RecentComparison[] = [];
const recentListeners = new Set<() => void>();
function notifyRecent() {
  for (const l of recentListeners) l();
}

export function useRecentComparisons(): RecentComparison[] {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    recentListeners.add(listener);
    return () => {
      recentListeners.delete(listener);
    };
  }, []);
  return recentComparisons;
}

export type ComparisonRunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface RunComparisonParams {
  readonly leftId: string;
  readonly leftLabel: string;
  readonly rightId: string;
  readonly rightLabel: string;
  readonly filter: TypeFilter;
}

interface WsProgressMessage {
  readonly status: string;
  readonly percent: number;
  readonly message?: string;
}

export function useRunComparison() {
  const [status, setStatus] = useState<ComparisonRunStatus>('idle');
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('');
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const utils = trpc.useUtils();
  const startMutation = trpc.comparisons.start.useMutation();
  const cancelMutation = trpc.comparisons.cancel.useMutation();

  const closeWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const run = useCallback(
    (params: RunComparisonParams) => {
      closeWs();
      setComparisonId(null);
      setStatus('running');
      setPercent(0);
      setMessage('Starting comparison...');

      startMutation.mutate(
        {
          leftConnectionId: params.leftId,
          rightConnectionId: params.rightId,
          name: `${params.leftLabel} vs ${params.rightLabel}`,
          filter: params.filter,
        },
        {
          onSuccess: ({ comparisonId: newId, jobId }) => {
            setComparisonId(newId);

            const ws = new WebSocket(jobProgressWsUrl(jobId));
            wsRef.current = ws;
            ws.onmessage = (event) => {
              const p = JSON.parse(event.data as string) as WsProgressMessage;
              setPercent(p.percent);
              setMessage(p.message ?? '');
              if (p.status === 'succeeded') {
                setStatus('succeeded');
                closeWs();
                void utils.comparisons.get.fetch({ comparisonId: newId }).then((row) => {
                  recentComparisons.unshift({
                    comparisonId: newId,
                    leftLabel: row.leftLabel,
                    rightLabel: row.rightLabel,
                    runAt: row.completedAt ?? new Date().toISOString(),
                    summary: row.summary as Record<DiffStatus, number>,
                  });
                  notifyRecent();
                });
              } else if (p.status === 'failed') {
                setStatus('failed');
                setMessage(p.message ?? 'Comparison failed.');
                closeWs();
              } else if (p.status === 'canceled') {
                setStatus('canceled');
                setMessage(p.message ?? 'Canceled.');
                closeWs();
              }
            };
            ws.onerror = () => {
              setStatus('failed');
              setMessage('Lost connection to the comparison job.');
            };
          },
          onError: (err) => {
            setStatus('failed');
            setMessage(err.message);
          },
        },
      );
    },
    [closeWs, startMutation, utils],
  );

  const cancel = useCallback(() => {
    closeWs();
    if (comparisonId) cancelMutation.mutate({ comparisonId });
    setStatus('canceled');
    setMessage('Canceled by user.');
  }, [closeWs, comparisonId, cancelMutation]);

  useEffect(() => closeWs, [closeWs]);

  return { status, percent, message, comparisonId, run, cancel };
}

const RESULTS_PAGE_SIZE = 5000;
const ZERO_CACHE_STATS: CacheStats = { totalComponents: 0, retrievedComponents: 0, cacheHits: 0, hitRatePercent: 0 };

export function useComparisonResult(comparisonId: string | undefined): ComparisonResultData | undefined {
  const utils = trpc.useUtils();
  const [data, setData] = useState<ComparisonResultData | undefined>(undefined);

  useEffect(() => {
    setData(undefined);
    if (!comparisonId) return;

    let cancelled = false;
    void (async () => {
      const row = await utils.comparisons.get.fetch({ comparisonId });

      const results: DiffResult[] = [];
      for (let offset = 0; ; offset += RESULTS_PAGE_SIZE) {
        const page = await utils.comparisons.results.fetch({ comparisonId, limit: RESULTS_PAGE_SIZE, offset });
        if (cancelled) return;
        // `comparisons.results` returns flattened rows (`type`/`fullName`/
        // `parentFullName` alongside `status` etc.), not a nested `key` —
        // see `toResultRow` in `packages/server/src/trpc/routers/comparisons.ts`.
        for (const r of page) {
          results.push({
            key: { type: r.type, fullName: r.fullName, parentFullName: r.parentFullName ?? undefined },
            status: r.status,
            leftSha256: r.leftSha256 ?? undefined,
            rightSha256: r.rightSha256 ?? undefined,
            entries: r.entries,
            textDiff: r.textDiff,
            // `DiffResult.binary` (`@vibeset/core`) is read defensively here
            // rather than as `r.binary` directly: as of this change,
            // `toResultRow`/`diff_results` in `@vibeset/server` don't
            // persist or serve it yet (the row-mapping in
            // `createCompareJobHandler` drops it, and there's no `binary`
            // column on `diff_results`), even though `ComparisonEngine`
            // already sets it in-memory for `StaticResource`/`Document`.
            // This cast means the UI's binary branch (`DiffViewer.tsx`)
            // lights up the moment that server-side gap is closed, with no
            // further change needed on this side — see this session's PR
            // body for the exact fix required.
            binary: (r as { binary?: boolean }).binary,
          });
        }
        if (page.length < RESULTS_PAGE_SIZE) break;
      }
      if (cancelled) return;

      setData({
        comparisonId,
        leftLabel: row.leftLabel,
        rightLabel: row.rightLabel,
        results,
        summary: row.summary as Record<DiffStatus, number>,
        cacheStats: (row.cacheStats as CacheStats | undefined) ?? ZERO_CACHE_STATS,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [comparisonId, utils]);

  return data;
}

/**
 * Real left/right canonical content for one component, for the diff panel.
 * Backed by `comparisons.componentContent`, which resolves the component's
 * `leftSha256`/`rightSha256` (recorded on its `diff_results` row) against
 * the content-addressed snapshot store — the ACTUAL retrieved Apex/LWC/
 * Aura/VF body, not a fabricated stand-in.
 *
 * Not wired into `components/diff/DiffViewer.tsx` yet — that file is owned
 * by a parallel workstream and still calls
 * `lib/mock/comparison-mock.ts`'s `generateMockApexSource`. See that file's
 * top-of-file doc comment for the swap this hook is meant to enable.
 */
export function useComponentContent(
  comparisonId: string | undefined,
  key: { readonly type: string; readonly fullName: string } | undefined,
) {
  return trpc.comparisons.componentContent.useQuery(
    { comparisonId: comparisonId ?? '', type: key?.type ?? '', fullName: key?.fullName ?? '' },
    { enabled: !!comparisonId && !!key },
  );
}
