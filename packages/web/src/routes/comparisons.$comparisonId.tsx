import { useEffect, useMemo, useRef, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { DiffResult, DiffStatus } from '@vibeset/core';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ResultsTree } from '@/components/comparisons/ResultsTree';
import { ResultsToolbar } from '@/components/comparisons/ResultsToolbar';
import { DiffViewer } from '@/components/diff/DiffViewer';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { SelectedComponentsView } from '@/components/comparisons/SelectedComponentsView';
import { useComparisonResult } from '@/lib/adapters/comparisons';
import { filterResults, groupByType } from '@/lib/comparison-tree';
import { componentKeyToString, useSelectedCount, useSelectionStore } from '@/lib/selection-store';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { buildWizardSteps } from '@/lib/wizard-steps';
import type { ComparisonReviewSearch } from '@/router';

const routeApi = getRouteApi('/comparisons/$comparisonId');

export function ComparisonResultsPage() {
  const { comparisonId } = routeApi.useParams();
  const searchParams = routeApi.useSearch();
  const navigate = useNavigate();
  const result = useComparisonResult(comparisonId);
  const flow = useComparisonFlowStore();

  const statuses = useMemo(() => new Set<DiffStatus>(searchParams.statuses ?? []), [searchParams.statuses]);
  const search = searchParams.search ?? '';
  const view = searchParams.view ?? 'tree';

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedResult, setSelectedResult] = useState<DiffResult>();
  const selectedCount = useSelectedCount();

  // Claims this comparisonId for the current selection, clearing it only if
  // it's genuinely a *different* comparison than before. Navigating away
  // (e.g. to the deploy step) and back with Back/Forward remounts this page
  // but must NOT wipe an in-progress selection of tens of thousands of rows.
  useEffect(() => {
    useSelectionStore.getState().ensureComparison(comparisonId);
    setSelectedResult(undefined);
  }, [comparisonId]);

  // Auto-expand every type group the first time this comparison's results
  // actually arrive. `result` loads asynchronously (a real comparison job),
  // so this can't live in the effect above — on first mount `result` is
  // still `undefined`, and that effect never re-runs once it resolves. The
  // ref guards against re-expanding groups the user has since collapsed if
  // `result`'s identity happens to change again for the same comparisonId.
  const autoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    if (result && autoExpandedFor.current !== comparisonId) {
      setExpanded(new Set(result.results.map((r) => r.key.type)));
      autoExpandedFor.current = comparisonId;
    }
  }, [comparisonId, result]);

  const filtered = useMemo(
    () => (result ? filterResults(result.results, { statuses, search }) : []),
    [result, statuses, search],
  );
  const groups = useMemo(() => groupByType(filtered), [filtered]);

  const updateSearch = (patch: Partial<ComparisonReviewSearch>) =>
    navigate({
      to: '/comparisons/$comparisonId',
      params: { comparisonId },
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });

  const toggleStatus = (status: DiffStatus) => {
    const next = new Set(statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    updateSearch({ statuses: next.size > 0 ? [...next] : undefined });
  };

  const toggleExpand = (type: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Only trust the flow store's sources as belonging to *this* comparison
  // if it was the one that produced it — otherwise (e.g. arriving here via
  // the recent-comparisons list) we don't actually know what sources/types
  // were chosen, so Back should land somewhere honest instead of a stale
  // or empty "Select types" form.
  const sourcesMatchThisComparison = flow.comparisonId === comparisonId && !!flow.leftId && !!flow.rightId;
  const steps = buildWizardSteps({ sourcesReady: sourcesMatchThisComparison, comparisonId, deploymentId: flow.deploymentId });

  const goBack = () => {
    if (sourcesMatchThisComparison) navigate({ to: '/comparisons/new/types' });
    else navigate({ to: '/comparisons' });
  };
  const goToDeploy = () => navigate({ to: '/comparisons/$comparisonId/deploy', params: { comparisonId } });

  if (!result) {
    return (
      <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
        <ComparisonStepper current="review" steps={steps} />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4">
          <Skeleton className="h-full" />
          <Skeleton className="h-full" />
        </div>
      </div>
    );
  }

  // The server stores `left = target org (current state)`, `right = desired/
  // source state` (see comparisons.new.types.tsx's `handleRun`). Alias back
  // to source/target for display so the header reads intuitively as
  // "source → target" regardless of that internal convention.
  const sourceLabel = result.rightLabel;
  const targetLabel = result.leftLabel;

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
      <ComparisonStepper current="review" steps={steps} selectedCount={selectedCount} />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {sourceLabel} <span className="text-neutral-400">→</span> {targetLabel}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{result.results.length.toLocaleString()} components compared</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button disabled={selectedCount === 0} onClick={goToDeploy}>
            Continue to deploy {selectedCount > 0 && `(${selectedCount})`} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {(
          [
            ['tree', 'All results'],
            ['selected', `Selected (${selectedCount})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => updateSearch({ view: key === 'tree' ? undefined : key })}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              view === key
                ? 'border-neutral-900 text-neutral-900 dark:border-white dark:text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'selected' ? (
        <SelectedComponentsView results={result.results} className="min-h-0 flex-1" />
      ) : (
        <>
          <ResultsToolbar
            summary={result.summary}
            statuses={statuses}
            onToggleStatus={toggleStatus}
            search={search}
            onSearchChange={(v) => updateSearch({ search: v || undefined })}
            cacheStats={result.cacheStats}
          />

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4">
            <div className="min-h-0 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <ResultsTree
                groups={groups}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                selectedResultKey={selectedResult ? componentKeyToString(selectedResult.key) : undefined}
                onSelectResult={setSelectedResult}
              />
            </div>
            <div className="min-h-0 overflow-hidden rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <DiffViewer
                result={selectedResult}
                leftLabel={result.leftLabel}
                rightLabel={result.rightLabel}
                comparisonId={comparisonId}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
