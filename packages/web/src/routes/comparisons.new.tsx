import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { SourceTargetPicker } from '@/components/comparisons/SourceTargetPicker';
import { useSourceOptions } from '@/lib/adapters/comparisons';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { buildWizardSteps } from '@/lib/wizard-steps';
import { resolveContinueHint } from '@/lib/source-target-hint';

/** Step 1 of the comparison wizard: choose the source and target to diff. */
export function ComparisonSourcesPage() {
  const navigate = useNavigate();
  const { options, isLoading } = useSourceOptions();
  const flow = useComparisonFlowStore();
  const [leftId, setLeftId] = useState<string | undefined>(flow.leftId);
  const [rightId, setRightId] = useState<string | undefined>(flow.rightId);

  const leftOpt = options.find((o) => o.id === leftId);
  const rightOpt = options.find((o) => o.id === rightId);
  const sameNonEmpty = !!leftId && leftId === rightId;
  const canContinue = !!leftOpt && !!rightOpt && !sameNonEmpty;

  // A disabled "Continue" button with no explanation reads as broken (this
  // is the greyed-out-button report in the Phase 2 plan's known debt —
  // investigated at length and never root-caused to a picker defect: a
  // component test and repeated manual reproduction both show Source and
  // Target accept selections identically). Whatever the original cause,
  // a user staring at a disabled button deserves to be told which half is
  // still missing, not just that it's disabled.
  const continueHint = resolveContinueHint({ hasSource: !!leftOpt, hasTarget: !!rightOpt, sameNonEmpty });

  const sourcesCommitted = !!(flow.leftId && flow.rightId && flow.leftId !== flow.rightId);
  const steps = buildWizardSteps({ sourcesReady: sourcesCommitted, comparisonId: flow.comparisonId, deploymentId: flow.deploymentId });

  const handleContinue = () => {
    if (!leftOpt || !rightOpt) return;
    flow.setSources({ leftId: leftOpt.id, leftLabel: leftOpt.label, rightId: rightOpt.id, rightLabel: rightOpt.label });
    navigate({ to: '/comparisons/new/types' });
  };

  return (
    <div className="flex flex-col gap-6">
      <ComparisonStepper current="sources" steps={steps} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New comparison</h1>
        <p className="text-neutral-500 dark:text-neutral-400">Diff two sources — org, SFDX project, or Git ref — and select changes to deploy.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Choose sources</CardTitle>
          <CardDescription>
            {isLoading
              ? 'Loading registered sources...'
              : options.length === 0
                ? 'No sources registered yet — add one on the Connections page first.'
                : 'Pick a source and target. You will narrow the metadata scope on the next step.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SourceTargetPicker
            options={options}
            leftId={leftId}
            rightId={rightId}
            onChangeLeft={setLeftId}
            onChangeRight={setRightId}
            onSwap={() => {
              setLeftId(rightId);
              setRightId(leftId);
            }}
          />

          <div className="flex items-center justify-between gap-4">
            {continueHint ? (
              <p
                className={
                  sameNonEmpty
                    ? 'text-sm text-amber-600 dark:text-amber-400'
                    : 'text-sm text-neutral-400 dark:text-neutral-500'
                }
              >
                {continueHint}
              </p>
            ) : (
              <span />
            )}
            <Button disabled={!canContinue} onClick={handleContinue}>
              Continue to metadata types <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
