import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Play } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { TypeFilterPanel } from '@/components/comparisons/TypeFilterPanel';
import { ComparisonRunPanel } from '@/components/comparisons/ComparisonRunPanel';
import { useRunComparison } from '@/lib/adapters/comparisons';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { toServerSides } from '@/lib/comparison-direction';
import { buildWizardSteps } from '@/lib/wizard-steps';
import { PHASE1_METADATA_TYPES } from '@/lib/metadata-types';

/** Step 2 of the comparison wizard: pick metadata types (genuinely multi-select, re-editable), then run. */
export function ComparisonTypesPage() {
  const navigate = useNavigate();
  const flow = useComparisonFlowStore();
  const [selectedTypes, setSelectedTypes] = useState<string[]>(flow.selectedTypes);
  const run = useRunComparison();

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
    navigate({ to: '/comparisons/new' });
  };

  const handleRun = () => {
    flow.setSelectedTypes(selectedTypes);
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
      filter: { types: selectedTypes },
    });
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

      <Card>
        <CardHeader>
          <CardTitle>Metadata scope</CardTitle>
          <CardDescription>Add or remove types freely — nothing here locks you out of picking more.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <TypeFilterPanel allTypes={PHASE1_METADATA_TYPES} selectedTypes={selectedTypes} onChange={setSelectedTypes} />

          <ComparisonRunPanel status={run.status} percent={run.percent} message={run.message} onCancel={run.cancel} />

          <div className="flex justify-end">
            <Button disabled={run.status === 'running'} onClick={handleRun}>
              <Play className="h-4 w-4" /> Run comparison
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
