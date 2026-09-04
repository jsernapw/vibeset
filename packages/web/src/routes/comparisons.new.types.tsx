import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Play } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { TypeFilterPanel } from '@/components/comparisons/TypeFilterPanel';
import { ScopeFiltersPanel } from '@/components/comparisons/ScopeFiltersPanel';
import { FilterSetBar } from '@/components/comparisons/FilterSetBar';
import { ComparisonRunPanel } from '@/components/comparisons/ComparisonRunPanel';
import { useAvailableTypes, useRunComparison } from '@/lib/adapters/comparisons';
import { useDeleteFilterSet, useFilterSets, useSaveFilterSet } from '@/lib/adapters/filter-sets';
import { useNamespaceImpactPreview } from '@/lib/adapters/inventory-preview';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { toServerSides } from '@/lib/comparison-direction';
import { buildWizardSteps } from '@/lib/wizard-steps';
import { resolveDefaultTypeSelection } from '@/lib/type-selection';
import { buildTypeFilter, scopeFieldsFromFilter, withoutNamespaceFiltering, type ScopeFilterFields } from '@/lib/filter-set-utils';

/** Step 2 of the comparison wizard: pick metadata types and scope filters (name patterns, modified-since, namespace/managed-package exclusion), then run. */
export function ComparisonTypesPage() {
  const navigate = useNavigate();
  const flow = useComparisonFlowStore();
  const [selectedTypes, setSelectedTypes] = useState<string[]>(flow.selectedTypes);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterFields>(flow.scopeFilter);
  const run = useRunComparison();
  const availableTypes = useAvailableTypes();

  const filterSets = useFilterSets();
  const { save: saveFilterSet, isSaving } = useSaveFilterSet();
  const { remove: deleteFilterSet } = useDeleteFilterSet();
  const impact = useNamespaceImpactPreview();

  // First time this wizard pass reaches the types step (nothing committed
  // to the flow store yet), pre-populate the curated ~33-type default the
  // moment it loads — a user should see exactly what a comparison will run
  // against, not an empty picker with a footnote explaining what "empty"
  // secretly means. `resolveDefaultTypeSelection` (tested directly in
  // `type-selection.test.ts`) is what decides whether to apply it, so a
  // user who deliberately clears every type via "Clear all" doesn't get it
  // silently reapplied.
  useEffect(() => {
    const defaults = resolveDefaultTypeSelection({
      typesInitialized: flow.typesInitialized,
      defaultTypes: availableTypes.data?.default,
    });
    if (defaults) {
      setSelectedTypes(defaults);
      flow.setSelectedTypes(defaults);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTypes.data, flow.typesInitialized]);

  // Guarded by `beforeLoad` in router.tsx, but stay defensive: if sources
  // somehow aren't set (e.g. store cleared in another tab), don't render a
  // broken form.
  const sourcesReady = !!(flow.leftId && flow.rightId);

  useEffect(() => {
    if (run.status === 'succeeded' && run.comparisonId) {
      flow.setComparisonId(run.comparisonId);
      navigate({ to: '/comparisons/$comparisonId', params: { comparisonId: run.comparisonId } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.comparisonId]);

  const steps = buildWizardSteps({ sourcesReady: true, comparisonId: flow.comparisonId, deploymentId: flow.deploymentId });

  const goBack = () => {
    flow.setSelectedTypes(selectedTypes);
    flow.setScopeFilter(scopeFilter);
    navigate({ to: '/comparisons/new' });
  };

  const effectiveFilter = buildTypeFilter(selectedTypes, scopeFilter);

  const handleRun = () => {
    flow.setSelectedTypes(selectedTypes);
    flow.setScopeFilter(scopeFilter);
    if (!flow.leftId || !flow.rightId || !flow.leftLabel || !flow.rightLabel) return;
    // The wizard's Source/Target and the server's left/right are OPPOSITE.
    // That translation lives in `toServerSides` so it is stated once and
    // pinned by `comparison-direction.test.ts` — getting it wrong silently
    // builds the deployment package against the wrong org.
    // NB: this store's `leftId`/`rightId` are the wizard's *Source*/*Target*
    // respectively, despite the names.
    run.run({
      ...toServerSides({
        sourceId: flow.leftId,
        sourceLabel: flow.leftLabel,
        targetId: flow.rightId,
        targetLabel: flow.rightLabel,
      }),
      filter: effectiveFilter,
    });
  };

  const applyFilterSet = (id: string) => {
    const set = filterSets.data.find((s) => s.id === id);
    if (!set) return;
    const types = set.filter.types ?? [];
    const scope = scopeFieldsFromFilter(set.filter);
    setSelectedTypes(types);
    setScopeFilter(scope);
  };

  const handleSaveFilterSet = (name: string) => {
    void saveFilterSet({ name, filter: effectiveFilter });
  };

  const handleCheckImpact = () => {
    if (!flow.leftId || !flow.leftLabel || !flow.rightId || !flow.rightLabel) return;
    const targets = [
      { connectionId: flow.leftId, label: flow.leftLabel },
      { connectionId: flow.rightId, label: flow.rightLabel },
    ];
    void impact.run(targets, withoutNamespaceFiltering(effectiveFilter), effectiveFilter);
  };

  if (!sourcesReady) {
    return (
      <div className="flex flex-col gap-6">
        <ComparisonStepper current="types" steps={steps} />
        <p className="text-neutral-400">Choose sources first.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ComparisonStepper current="types" steps={steps} />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Select metadata types</h1>
          <p className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
            <Badge variant="outline">{flow.leftLabel}</Badge>
            <span>&rarr;</span>
            <Badge variant="outline">{flow.rightLabel}</Badge>
          </p>
        </div>
        <Button variant="outline" onClick={goBack} disabled={run.status === 'running'}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </div>

      <FilterSetBar
        savedSets={filterSets.data}
        isLoading={filterSets.isLoading}
        onApply={applyFilterSet}
        onDelete={(id) => void deleteFilterSet(id)}
        onSave={handleSaveFilterSet}
        isSaving={isSaving}
      />

      <Card>
        <CardHeader>
          <CardTitle>Metadata scope</CardTitle>
          <CardDescription>
            Pre-filled with the {availableTypes.data?.default.length ?? 33} types most release managers deploy. Add or remove
            freely — nothing here locks you out of picking more.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <TypeFilterPanel
            allTypes={availableTypes.data?.all ?? []}
            curatedTypes={availableTypes.data?.default ?? []}
            selectedTypes={selectedTypes}
            onChange={setSelectedTypes}
            isLoading={availableTypes.isLoading}
            error={availableTypes.error as Error | null}
            onRetry={() => availableTypes.refetch()}
          />

          <Separator />

          <ScopeFiltersPanel
            namePatterns={scopeFilter.namePatterns}
            onChangeNamePatterns={(namePatterns) => setScopeFilter({ ...scopeFilter, namePatterns })}
            modifiedSince={scopeFilter.modifiedSince}
            onChangeModifiedSince={(modifiedSince) => setScopeFilter({ ...scopeFilter, modifiedSince })}
            excludeManagedPackages={scopeFilter.excludeManagedPackages}
            onChangeExcludeManagedPackages={(excludeManagedPackages) => setScopeFilter({ ...scopeFilter, excludeManagedPackages })}
            excludeNamespaces={scopeFilter.excludeNamespaces}
            onChangeExcludeNamespaces={(excludeNamespaces) => setScopeFilter({ ...scopeFilter, excludeNamespaces })}
            impact={{
              status: impact.status,
              results: impact.results,
              error: impact.error,
              onCheck: handleCheckImpact,
            }}
          />

          <ComparisonRunPanel status={run.status} percent={run.percent} message={run.message} onCancel={run.cancel} />

          <div className="flex justify-end">
            <Button disabled={run.status === 'running' || selectedTypes.length === 0} onClick={handleRun}>
              <Play className="h-4 w-4" /> Run comparison
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
