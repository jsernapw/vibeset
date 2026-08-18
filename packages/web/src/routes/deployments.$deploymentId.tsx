import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, RotateCcw, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { DeployMonitor } from '@/components/deploy/DeployMonitor';
import { ComparisonStepper } from '@/components/comparisons/ComparisonStepper';
import { useDeployment, useStartDeployment } from '@/lib/adapters/deploy';
import { useGenerateRollback } from '@/lib/adapters/history';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';
import { buildWizardSteps } from '@/lib/wizard-steps';
import { formatDateTime } from '@/lib/format';

const routeApi = getRouteApi('/deployments/$deploymentId');

const STATUS_VARIANT = { succeeded: 'success', failed: 'error', 'in-progress': 'info', canceled: 'neutral', queued: 'neutral' } as const;

export function DeploymentDetailPage() {
  const { deploymentId } = routeApi.useParams();
  const navigate = useNavigate();
  const record = useDeployment(deploymentId);
  const { cancel } = useStartDeployment();
  const rollback = useGenerateRollback();
  const flow = useComparisonFlowStore();

  if (!record) {
    return <EmptyState title="Deployment not found" description="This deployment id doesn't exist in this session." />;
  }

  const isDone = record.status !== 'in-progress' && record.status !== 'queued';

  // Only show the wizard stepper (and "start new comparison") when this
  // deployment is the one the active comparison flow just launched — a
  // deployment opened from History or the Deployments list is still a
  // first-class standalone record, not a leftover wizard step.
  const isWizardResult = flow.deploymentId === deploymentId && !!flow.comparisonId;
  const steps = isWizardResult
    ? buildWizardSteps({ sourcesReady: true, comparisonId: flow.comparisonId, deploymentId })
    : null;

  return (
    <div className="flex flex-col gap-6">
      {steps && <ComparisonStepper current="result" steps={steps} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{record.packageName}</h1>
          <p className="text-neutral-500 dark:text-neutral-400">
            {record.checkOnly ? 'Validation' : 'Deployment'} against <span className="font-medium">{record.targetLabel}</span> by {record.initiator}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isWizardResult && flow.comparisonId && (
            <Button
              variant="outline"
              onClick={() => navigate({ to: '/comparisons/$comparisonId/deploy', params: { comparisonId: flow.comparisonId! } })}
            >
              <ArrowLeft className="h-4 w-4" /> Back to review &amp; deploy
            </Button>
          )}
          {isWizardResult && (
            <Button
              variant="outline"
              onClick={() => {
                flow.startOver();
                navigate({ to: '/comparisons/new' });
              }}
            >
              <Sparkles className="h-4 w-4" /> Start new comparison
            </Button>
          )}
          <Badge variant={STATUS_VARIANT[record.status]}>{record.status}</Badge>
          {isDone && (
            <Dialog onOpenChange={(open) => !open && rollback.reset()}>
              <DialogTrigger asChild>
                <Button variant="outline" onClick={() => rollback.generate(record)}>
                  <RotateCcw className="h-4 w-4" /> Generate rollback package
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Rollback package</DialogTitle>
                  <DialogDescription>
                    Restores every changed component in this deployment to its pre-deploy snapshot.
                  </DialogDescription>
                </DialogHeader>
                {rollback.isGenerating && <p className="text-sm text-neutral-400">Building rollback manifest...</p>}
                {rollback.result && (
                  <>
                    <p className="text-sm">
                      <span className="font-medium">{rollback.result.componentCount}</span> components will be restored.
                    </p>
                    <pre className="max-h-72 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">
                      {rollback.result.manifestYaml}
                    </pre>
                  </>
                )}
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
        <span>Test level: {record.testLevel}</span>
        <span>Started: {formatDateTime(record.startedAt)}</span>
        {record.completedAt && <span>Completed: {formatDateTime(record.completedAt)}</span>}
        {record.validationId && <span>Validation id: {record.validationId}</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Component results</CardTitle>
          <CardDescription>Streams live while the job is in progress; virtualized for large packages.</CardDescription>
        </CardHeader>
        <CardContent>
          <DeployMonitor record={record} onCancel={record.status === 'in-progress' ? () => cancel(record.id) : undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-64 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">{record.logLines.join('\n')}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
