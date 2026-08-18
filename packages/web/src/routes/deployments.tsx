import { Link, useNavigate } from '@tanstack/react-router';
import { Rocket } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useDeployments } from '@/lib/adapters/deploy';
import { useDeploymentDraftStore } from '@/lib/deployment-draft-store';
import { formatDateTime, formatRelativeTime } from '@/lib/format';

const STATUS_VARIANT = { succeeded: 'success', failed: 'error', 'in-progress': 'info', canceled: 'neutral', queued: 'neutral' } as const;

export function DeploymentsPage() {
  const navigate = useNavigate();
  const deployments = useDeployments();
  const draftCount = useDeploymentDraftStore((s) => s.components.length + s.destructiveComponents.length);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <p className="text-neutral-500 dark:text-neutral-400">Validate and deploy packages, and watch progress live.</p>
        </div>
        <Button disabled={draftCount === 0} onClick={() => navigate({ to: '/deployments/new' })} title={draftCount === 0 ? 'Select components from a comparison first' : undefined}>
          <Rocket className="h-4 w-4" /> Review current selection{draftCount > 0 && ` (${draftCount})`}
        </Button>
      </div>

      {deployments.length === 0 ? (
        <EmptyState icon={Rocket} title="No deployments yet" description="Run a comparison, select changes, and deploy to see them here." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Components</th>
                <th className="px-4 py-2">Initiator</th>
                <th className="px-4 py-2">Started</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id} className="border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2">
                    <Link to="/deployments/$deploymentId" params={{ deploymentId: d.id }} className="font-medium hover:underline">
                      {d.targetLabel}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-neutral-500">{d.checkOnly ? 'Validate' : 'Deploy'}</td>
                  <td className="px-4 py-2 text-neutral-500">
                    {d.numberComponentsDeployed}/{d.numberComponentsTotal}
                    {d.numberComponentErrors > 0 && <span className="text-red-600"> ({d.numberComponentErrors} errors)</span>}
                  </td>
                  <td className="px-4 py-2 text-neutral-500">{d.initiator}</td>
                  <td className="px-4 py-2 text-neutral-500" title={formatDateTime(d.startedAt)}>
                    {formatRelativeTime(d.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
