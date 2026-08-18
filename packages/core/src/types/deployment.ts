import type { ComponentKey } from './metadata-source.js';

export type DeployComponentStatus = 'succeeded' | 'failed' | 'skipped' | 'pending' | 'in-progress';

/** A selected, orderable set of components destined for a target org. */
export interface DeploymentPackage {
  readonly id: string;
  readonly name: string;
  readonly comparisonId?: string;
  /** Components to add/update, in topological deploy order where constraints are known. */
  readonly components: ComponentKey[];
  /** Components to delete via `destructiveChangesPost.xml`. */
  readonly destructiveComponents: ComponentKey[];
  readonly createdAt: string;
  /** YAML manifest source of truth, saved under `.vibeset/` — this struct is derived from it. */
  readonly manifestPath?: string;
}

export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';

export interface DeploymentOptions {
  readonly checkOnly: boolean;
  readonly testLevel: TestLevel;
  readonly runTests?: string[];
  readonly rest?: boolean;
}

export interface DeploymentComponentResult {
  readonly key: ComponentKey;
  readonly status: DeployComponentStatus;
  readonly changed: boolean;
  readonly errorMessage?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

export interface DeploymentResult {
  readonly deploymentId: string;
  readonly targetOrgId: string;
  readonly status: 'queued' | 'in-progress' | 'succeeded' | 'failed' | 'canceled';
  readonly checkOnly: boolean;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly componentResults: DeploymentComponentResult[];
  readonly numberComponentErrors: number;
  readonly numberComponentsDeployed: number;
  readonly numberComponentsTotal: number;
  readonly testResults?: {
    readonly numberRun: number;
    readonly numberFailures: number;
    readonly coveragePercent?: number;
  };
  /** Salesforce validation id, kept for Quick Deploy (`deployRecentValidation`) within the 10-day window. */
  readonly validationId?: string;
}
