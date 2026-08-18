import { useNavigate } from '@tanstack/react-router';
import { GitCompare, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useRecentComparisons } from '@/lib/adapters/comparisons';
import { formatRelativeTime } from '@/lib/format';

/**
 * Comparisons landing page — an entry point into the wizard (`/comparisons/new`)
 * plus this session's recent runs. The multi-step form itself lives at
 * `/comparisons/new` and `/comparisons/new/types`; this page stays a plain
 * list so "Comparisons" in the nav always lands somewhere stable regardless
 * of wizard progress.
 */
export function ComparisonsPage() {
  const navigate = useNavigate();
  const recent = useRecentComparisons();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Comparisons</h1>
          <p className="text-neutral-500 dark:text-neutral-400">Diff two sources — org, SFDX project, or Git ref — and select changes to deploy.</p>
        </div>
        <Button onClick={() => navigate({ to: '/comparisons/new' })}>
          <Play className="h-4 w-4" /> New comparison
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Recent comparisons (this session)</h2>
        {recent.length === 0 ? (
          <EmptyState
            icon={GitCompare}
            title="No comparisons run yet"
            description="Start a new comparison to see results here."
            action={
              <Button variant="outline" onClick={() => navigate({ to: '/comparisons/new' })}>
                New comparison
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
            {recent.map((r) => (
              <button
                key={r.comparisonId}
                onClick={() => navigate({ to: '/comparisons/$comparisonId', params: { comparisonId: r.comparisonId } })}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                {/* Server convention: left = target org, right = source/desired state (see comparisons.new.types.tsx) — shown here as source → target. */}
                <span className="font-medium">
                  {r.rightLabel} → {r.leftLabel}
                </span>
                <span className="text-neutral-400">{formatRelativeTime(r.runAt)}</span>
                <div className="ml-auto flex gap-1">
                  {r.summary.new > 0 && <Badge variant="new">{r.summary.new} new</Badge>}
                  {r.summary.changed > 0 && <Badge variant="changed">{r.summary.changed} changed</Badge>}
                  {r.summary.deleted > 0 && <Badge variant="deleted">{r.summary.deleted} deleted</Badge>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
