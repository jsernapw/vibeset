import type { Connection } from '@salesforce/core';
import { MetadataApiDeploy, type DeployResult } from '@salesforce/source-deploy-retrieve';
import type { DeploymentResult } from '../types/deployment.js';
import {
  componentResultLine,
  type DeployDiagnostics,
  deployStatusSummaryMessage,
  mapDeployStatus,
  normalizeDeployDiagnostics,
  normalizeFileResponses,
  normalizeTestResults,
  percentFromDeployStatus,
} from './normalize.js';
import type { RunDeployResult } from './executor.js';

/** Salesforce's documented Quick Deploy window: a validation is only eligible for `deployRecentValidation` within 10 days of completing. */
export const QUICK_DEPLOY_WINDOW_DAYS = 10;

export interface QuickDeployEligibilityInput {
  readonly checkOnly: boolean;
  readonly status: DeploymentResult['status'];
  readonly completedAt?: string;
  readonly validationId?: string;
}

/**
 * Whether a past deployment is still eligible for `deployRecentValidation`
 * ("Quick Deploy"): it must have been a validation (`checkOnly: true`) that
 * `succeeded`, have a recorded `validationId`, and be within the 10-day
 * window. This is a pure function over already-known deployment history —
 * no network call — so `history`/`deploy` routes can compute it cheaply for
 * every row in a list without hitting the org.
 */
export function isQuickDeployable(input: QuickDeployEligibilityInput, now: Date = new Date()): boolean {
  if (!input.checkOnly || input.status !== 'succeeded' || !input.validationId || !input.completedAt) return false;
  const completed = new Date(input.completedAt).getTime();
  if (Number.isNaN(completed)) return false;
  const ageMs = now.getTime() - completed;
  return ageMs >= 0 && ageMs <= QUICK_DEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export interface DeployRecentValidationParams {
  readonly usernameOrConnection: string | Connection;
  readonly targetOrgId: string;
  readonly validationId: string;
  readonly rest?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (percent: number, message: string) => void;
}

/**
 * Deploys a previously-validated package without re-running Apex tests
 * ("Quick Deploy"). Two `MetadataApiDeploy` instances are involved by
 * SDR's own design: one constructed with the ORIGINAL validation's id to
 * call `deployRecentValidation()` (which kicks off a new async deploy
 * request and returns ITS OWN id, not the validation's), and a second
 * constructed with THAT new id to actually poll for completion — polling
 * the original instance would poll the wrong (already-finished) request.
 */
export async function deployRecentValidation(params: DeployRecentValidationParams): Promise<RunDeployResult> {
  const startedAt = new Date().toISOString();

  const validationHandle = new MetadataApiDeploy({ usernameOrConnection: params.usernameOrConnection, id: params.validationId });
  const quickDeployId = await validationHandle.deployRecentValidation(params.rest ?? true);

  const quickDeployOp = new MetadataApiDeploy({ usernameOrConnection: params.usernameOrConnection, id: quickDeployId });
  quickDeployOp.onUpdate((status) => {
    params.onProgress?.(percentFromDeployStatus(status), deployStatusSummaryMessage(status));
  });

  const onAbort = (): void => {
    void quickDeployOp.cancel();
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });

  let deployResult: DeployResult;
  try {
    deployResult = await quickDeployOp.pollStatus();
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
  }

  const fileResponses = deployResult.getFileResponses();
  for (const fr of fileResponses) params.onProgress?.(99, componentResultLine(fr));

  const completedAt = new Date().toISOString();
  const status = deployResult.response;
  const result: DeploymentResult = {
    deploymentId: status.id,
    targetOrgId: params.targetOrgId,
    status: mapDeployStatus(status),
    checkOnly: false, // a quick deploy is a real deploy, not another validation
    startedAt,
    completedAt,
    componentResults: normalizeFileResponses(fileResponses),
    numberComponentErrors: status.numberComponentErrors,
    numberComponentsDeployed: status.numberComponentsDeployed,
    numberComponentsTotal: status.numberComponentsTotal,
    testResults: normalizeTestResults(status.details?.runTestResult),
    validationId: params.validationId,
  };

  const diagnostics: DeployDiagnostics = normalizeDeployDiagnostics(status);
  return { result, diagnostics };
}
