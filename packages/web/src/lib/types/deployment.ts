import type { DeploymentComponentResult, TestLevel } from '@vibeset/core';

/**
 * Non-mock home for the deployment/history record shape shared across
 * `lib/adapters/**` and component files this workstream does not own
 * (`components/deploy/DeployMonitor.tsx`). Moved out of
 * `lib/mock/deployment-mock.ts` — see that file's doc comment — and renamed
 * from `MockDeploymentRecord`: this is real data now, nothing about the
 * shape itself was ever mock-specific.
 */
export interface DeploymentRecord {
  readonly id: string;
  readonly packageName: string;
  readonly targetLabel: string;
  readonly initiator: string;
  readonly status: 'queued' | 'in-progress' | 'succeeded' | 'failed' | 'canceled';
  readonly checkOnly: boolean;
  readonly testLevel: TestLevel;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly componentResults: DeploymentComponentResult[];
  readonly numberComponentErrors: number;
  readonly numberComponentsDeployed: number;
  readonly numberComponentsTotal: number;
  readonly validationId?: string;
  readonly testResults?: { numberRun: number; numberFailures: number; coveragePercent: number };
  readonly logLines: string[];
}
