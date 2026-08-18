import { useEffect, useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, ShieldCheck, Sparkles } from 'lucide-react';
import type { TestLevel } from '@vibeset/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { SelectedComponentsView } from '@/components/comparisons/SelectedComponentsView';
import { TestLevelPicker } from '@/components/deploy/TestLevelPicker';
import { useComparisonResult } from '@/lib/adapters/comparisons';
import { findQuickDeployCandidate, useStartDeployment } from '@/lib/adapters/deploy';
import { componentKeyToString, useSelectionStore } from '@/lib/selection-store';
import { useDeploymentDraftStore } from '@/lib/deployment-draft-store';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { buildWizardSteps } from '@/lib/wizard-steps';
import { buildPackageXmlPreview } from '@/lib/package-xml';
import { formatRelativeTime } from '@/lib/format';

const routeApi = getRouteApi('/comparisons/$comparisonId/deploy');

/** Step 4 of the comparison wizard: review the package built from whatever is currently selected, and deploy or validate. */
export function ComparisonDeployPage() {
  const { comparisonId } = routeApi.useParams();
  const navigate = useNavigate();
  const result = useComparisonResult(comparisonId);
  const flow = useComparisonFlowStore();
  const selected = useSelectionStore((s) => s.selected);
  const { start } = useStartDeployment();

  const [packageName, setPackageName] = useState(flow.deployOptions.packageName);
  const [checkOnly, setCheckOnly] = useState(flow.deployOptions.checkOnly);
  const [testLevel, setTestLevel] = useState<TestLevel>(flow.deployOptions.testLevel);
  const [runTests, setRunTests] = useState<string[]>(flow.deployOptions.runTests);

  // Keep the flow store in sync as the user edits, so Back to Review
  // differences and Continue back here preserves the form instead of
  // resetting it.
  useEffect(() => {
    flow.setDeployOptions({ packageName, checkOnly, testLevel, runTests });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageName, checkOnly, testLevel, runTests]);

  // Components are derived live from the comparison + current selection
  // rather than a one-time snapshot, so editing the selection after
  // visiting this step (via Back) is always reflected here without an
  // extra "re-sync" step.
  const draft = useMemo(() => {
    if (!result) return { selectedResults: [], components: [], destructiveComponents: [] };
    const selectedResults = result.results.filter((r) => selected.has(componentKeyToString(r.key)));
    return {
      selectedResults,
      components: selectedResults.filter((r) => r.status !== 'deleted').map((r) => r.key),
      destructiveComponents: selectedResults.filter((r) => r.status === 'deleted').map((r) => r.key),
    };
  }, [result, selected]);

  const packageXml = useMemo(() => buildPackageXmlPreview(draft.components), [draft.components]);
  const destructiveXml = useMemo(
    () => (draft.destructiveComponents.length > 0 ? buildPackageXmlPreview(draft.destructiveComponents) : null),
    [draft.destructiveComponents],
  );
  const quickDeploy = useMemo(() => findQuickDeployCandidate(draft.components), [draft.components]);

  const steps = buildWizardSteps({ sourcesReady: true, comparisonId, deploymentId: flow.deploymentId });
  const totalCount = draft.components.length + draft.destructiveComponents.length;

  if (!result) {
    return (
      <div className="flex flex-col gap-6">
        <ComparisonStepper current="deploy" steps={steps} />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="flex flex-col gap-6">
        <ComparisonStepper current="deploy" steps={steps} />
        <EmptyState
          title="Nothing selected"
          description="Go back to Review differences and select components to build a deployment package."
          action={
            <Button variant="outline" onClick={() => navigate({ to: '/comparisons/$comparisonId', params: { comparisonId } })}>
              <ArrowLeft className="h-4 w-4" /> Back to review differences
            </Button>
          }
        />
      </div>
    );
  }

  // The server stores `left = target org (current state)`, `right = desired/
  // source state` (see comparisons.new.types.tsx's `handleRun`) — alias back
  // to source/target here so this page's copy and the values handed to
  // `start()`/the draft store describe the deploy direction correctly.
  const sourceLabel = result.rightLabel;
  const targetLabel = result.leftLabel;

  const runDeployment = (asCheckOnly: boolean) => {
    // `useStartDeployment().start()` reads the comparisonId this selection
    // came from off `deployment-draft-store` (it needs it to resolve the
    // source/target connections and build the real package server-side) —
    // this wizard step derives its component list live rather than through
    // that store, so it must still publish this snapshot immediately before
    // calling `start()`.
    useDeploymentDraftStore.getState().setDraft({
      comparisonId,
      sourceLabel,
      targetLabel,
      components: draft.components,
      destructiveComponents: draft.destructiveComponents,
    });
    const id = start({
      components: draft.components,
      destructiveComponents: draft.destructiveComponents,
      checkOnly: asCheckOnly,
      testLevel,
      // Only sent for RunSpecifiedTests; harmless (and ignored) otherwise.
      runTests: testLevel === 'RunSpecifiedTests' ? runTests : undefined,
      targetLabel,
      packageName,
    });
    // Claim this comparisonId + the new deploymentId so the Result step
    // knows it's part of this flow (correct even if this deploy step was
    // reached via a deep link rather than the wizard's own navigation).
    flow.setComparisonId(comparisonId);
    flow.setDeploymentId(id);
    navigate({ to: '/deployments/$deploymentId', params: { deploymentId: id } });
  };

  return (
    <div className="flex flex-col gap-6">
      <ComparisonStepper current="deploy" steps={steps} selectedCount={totalCount} />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review &amp; deploy</h1>
          <p className="text-neutral-500 dark:text-neutral-400">
            From <span className="font-medium">{sourceLabel}</span> to <span className="font-medium">{targetLabel}</span> &mdash;{' '}
            {draft.components.length} to add/update, {draft.destructiveComponents.length} to delete.
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate({ to: '/comparisons/$comparisonId', params: { comparisonId } })}>
          <ArrowLeft className="h-4 w-4" /> Back to review differences
        </Button>
      </div>

      {quickDeploy && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950">
          <Sparkles className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="flex-1">
            <p className="font-medium text-emerald-800 dark:text-emerald-300">Quick Deploy available</p>
            <p className="text-emerald-700 dark:text-emerald-400">
              This exact component set validated successfully {formatRelativeTime(quickDeploy.validatedAt)} ({quickDeploy.daysRemaining} day
              {quickDeploy.daysRemaining === 1 ? '' : 's'} left in the 10-day window) — deploy without re-running tests.
            </p>
          </div>
          <Button size="sm" onClick={() => runDeployment(false)}>
            Quick Deploy
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>package.xml</CardTitle>
              <CardDescription>{draft.components.length} components across {new Set(draft.components.map((c) => c.type)).size} types.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">{packageXml}</pre>
            </CardContent>
          </Card>

          {destructiveXml && (
            <Card className="border-red-200 dark:border-red-900">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <AlertTriangle className="h-4 w-4" /> destructiveChangesPost.xml
                </CardTitle>
                <CardDescription>{draft.destructiveComponents.length} components will be permanently deleted from the target.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-72 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">{destructiveXml}</pre>
              </CardContent>
            </Card>
          )}

          <Card className="flex min-h-[22rem] flex-col">
            <CardHeader>
              <CardTitle>Selected components</CardTitle>
              <CardDescription>Searchable across every type — deselect here to shrink the package without leaving this screen.</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              <SelectedComponentsView results={result.results} className="h-80" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Analyzer findings</CardTitle>
              <CardDescription>Problem analyzers (missing dependencies, hardcoded IDs, coverage warnings...) ship in Phase 3.</CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState title="No analyzer findings yet" description="This placeholder will surface actionable warnings before you deploy." />
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Deploy options</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pkg-name">Package name</Label>
              <Input id="pkg-name" value={packageName} onChange={(e) => setPackageName(e.target.value)} />
            </div>

            <TestLevelPicker
              value={testLevel}
              onChange={setTestLevel}
              runTests={runTests}
              onChangeRunTests={setRunTests}
            />

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={checkOnly} onCheckedChange={(c) => setCheckOnly(c === true)} />
              Validate only (checkOnly) &mdash; no changes are made to the target
            </label>

            <Separator />

            <div className="flex flex-col gap-2">
              <Button onClick={() => runDeployment(checkOnly)} className="w-full">
                <ShieldCheck className="h-4 w-4" /> {checkOnly ? 'Validate' : 'Deploy'}
              </Button>
              {checkOnly && (
                <Button variant="outline" onClick={() => runDeployment(false)} className="w-full">
                  Skip validation, deploy directly
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
