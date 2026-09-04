import { useCallback, useState } from 'react';
import type { TypeFilter } from '@vibeset/core';
import { jobProgressWsUrl, trpc } from '@/lib/trpc';

/**
 * Backs the "Check impact" control on the namespace-exclusion filters
 * (`ScopeFiltersPanel`) with `inventory.start` — the SAME job the wizard's
 * pre-comparison inventory preview uses (`RetrievalPlanner.planSource`,
 * i.e. `listMetadata` + a cache-hit check, never a real retrieve), so
 * asking "how many components would this exclusion remove" is cheap and
 * safe to run against a real, read-only org: retrieve is ~88% of cold
 * wall-clock (see this session's brief) and this never retrieves anything.
 *
 * There's no dedicated "just give me a count" tRPC procedure — `inventory`
 * is job-based like `comparisons`, so this follows the exact same
 * enqueue -> stream `/ws/jobs/:jobId` -> fetch the finished job's result
 * pattern `useRunComparison` (`adapters/comparisons.ts`) already
 * establishes, just wrapped as an awaitable `checkCount` instead of
 * reactive run/percent/message state (the impact preview only needs a
 * final number, not live progress UI).
 */
function waitForJob(jobId: string): Promise<'succeeded' | 'failed' | 'canceled'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(jobProgressWsUrl(jobId));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as { status: string };
      if (msg.status === 'succeeded' || msg.status === 'failed' || msg.status === 'canceled') {
        settled = true;
        resolve(msg.status);
        ws.close();
      }
    };
    ws.onerror = () => {
      if (!settled) reject(new Error('Lost connection while checking inventory.'));
    };
    ws.onclose = () => {
      if (!settled) reject(new Error('Connection closed before the inventory check finished.'));
    };
  });
}

export interface NamespaceImpactRow {
  readonly connectionId: string;
  readonly label: string;
  /** Component count with namespace filtering turned OFF (types/namePatterns/modifiedSince still applied). */
  readonly before: number;
  /** Component count with the current, effective filter (namespace filtering included). */
  readonly after: number;
}

export type ImpactCheckStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * `targets` are the wizard's chosen source/target connections. Sequential
 * on purpose (one inventory job at a time, across both the before/after
 * pair AND across targets) rather than `Promise.all` — this can run
 * against real orgs (RCA DEV / ARM DEV), and there is no reason to fire
 * concurrent `listMetadata` calls at the same org for what is, from the
 * user's perspective, one "check impact" click.
 */
export function useNamespaceImpactPreview() {
  const [status, setStatus] = useState<ImpactCheckStatus>('idle');
  const [results, setResults] = useState<NamespaceImpactRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const startMutation = trpc.inventory.start.useMutation();
  const utils = trpc.useUtils();

  const countFor = useCallback(
    async (connectionId: string, filter: TypeFilter): Promise<number> => {
      const { jobId } = await startMutation.mutateAsync({ connectionId, filter });
      const finalStatus = await waitForJob(jobId);
      if (finalStatus !== 'succeeded') {
        throw new Error(finalStatus === 'canceled' ? 'Inventory check was canceled.' : 'Inventory check failed — see server logs.');
      }
      const job = await utils.jobs.get.fetch({ jobId });
      const result = job?.resultJson ? (JSON.parse(job.resultJson) as { inventoriedCount?: number }) : undefined;
      return result?.inventoriedCount ?? 0;
    },
    [startMutation, utils],
  );

  const run = useCallback(
    async (targets: readonly { connectionId: string; label: string }[], baseline: TypeFilter, effective: TypeFilter) => {
      setStatus('running');
      setError(null);
      setResults([]);
      try {
        const rows: NamespaceImpactRow[] = [];
        for (const target of targets) {
          const before = await countFor(target.connectionId, baseline);
          const after = await countFor(target.connectionId, effective);
          rows.push({ connectionId: target.connectionId, label: target.label, before, after });
        }
        setResults(rows);
        setStatus('done');
      } catch (err) {
        setError((err as Error).message);
        setStatus('error');
      }
    },
    [countFor],
  );

  return { status, results, error, run };
}
