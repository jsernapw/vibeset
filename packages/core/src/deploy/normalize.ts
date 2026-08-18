import type {
  DeployMessage,
  FileResponse,
  MetadataApiDeployStatus,
  RunTestResult,
} from '@salesforce/source-deploy-retrieve';
import type { ComponentKey } from '../types/metadata-source.js';
import type { DeployComponentStatus, DeploymentComponentResult, DeploymentResult } from '../types/deployment.js';

function parseIntSafe(s: string | undefined): number {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : 0;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Normalizes SDR's raw `FileResponse[]` (from `DeployResult.getFileResponses()`)
 * into the agreed `DeploymentComponentResult[]` shape (`types/deployment.ts`)
 * — component type, name, line/column, problem text — per the task brief's
 * "normalize the raw Metadata API response into something actionable".
 */
export function normalizeFileResponses(responses: readonly FileResponse[]): DeploymentComponentResult[] {
  return responses.map((fr): DeploymentComponentResult => {
    const key: ComponentKey = { type: fr.type, fullName: fr.fullName };
    if (fr.state === 'Failed') {
      return {
        key,
        status: 'failed' satisfies DeployComponentStatus,
        changed: false,
        errorMessage: fr.error,
        lineNumber: fr.lineNumber,
        columnNumber: fr.columnNumber,
      };
    }
    return {
      key,
      status: 'succeeded' satisfies DeployComponentStatus,
      changed: fr.state === 'Changed' || fr.state === 'Created' || fr.state === 'Deleted',
    };
  });
}

export interface NormalizedTestResults {
  readonly numberRun: number;
  readonly numberFailures: number;
  readonly coveragePercent?: number;
}

/** Normalizes SDR's `RunTestResult` into the agreed `DeploymentResult['testResults']` shape — aggregate run/failure counts and a computed coverage percent (locations covered / locations total across every class in the result, matching how Salesforce itself reports org-wide coverage). */
export function normalizeTestResults(runTestResult: RunTestResult | undefined): NormalizedTestResults | undefined {
  if (!runTestResult) return undefined;
  const coverage = asArray(runTestResult.codeCoverage);
  let totalLocations = 0;
  let totalNotCovered = 0;
  for (const c of coverage) {
    totalLocations += parseIntSafe(c.numLocations);
    totalNotCovered += parseIntSafe(c.numLocationsNotCovered);
  }
  return {
    numberRun: parseIntSafe(runTestResult.numTestsRun),
    numberFailures: parseIntSafe(runTestResult.numFailures),
    coveragePercent:
      totalLocations > 0 ? Math.round(((totalLocations - totalNotCovered) / totalLocations) * 10000) / 100 : undefined,
  };
}

/**
 * Richer diagnostics than `DeploymentResult.testResults` has room for — the
 * agreed type (`types/deployment.ts`) is deliberately narrow (run/failure
 * counts + an overall coverage percent). This carries the individual Apex
 * test failures and per-class coverage warnings the task brief also asks
 * to be surfaced, for callers that want more than the summary (`server`
 * persists this verbatim into `deployments.resultJson` alongside the typed
 * `DeploymentResult`).
 */
export interface DeployDiagnostics {
  readonly testFailures: ReadonlyArray<{
    readonly className: string;
    readonly methodName: string;
    readonly message: string;
    readonly stackTrace: string;
  }>;
  readonly coverageWarnings: ReadonlyArray<{ readonly name: string; readonly message: string }>;
  readonly componentFailures: ReadonlyArray<{
    readonly type: string;
    readonly fullName: string;
    readonly problem: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  }>;
}

export function normalizeDeployDiagnostics(status: MetadataApiDeployStatus): DeployDiagnostics {
  const componentFailureMessages = asArray(status.details?.componentFailures);
  const runTestResult = status.details?.runTestResult;

  const testFailures = asArray(runTestResult?.failures).map((f) => ({
    className: f.name,
    methodName: f.methodName,
    message: f.message,
    stackTrace: f.stackTrace,
  }));

  const coverageWarnings = asArray(runTestResult?.codeCoverageWarnings).map((w) => ({
    name: w.namespace || w.id,
    message: w.message,
  }));

  const componentFailures = componentFailureMessages.map((f: DeployMessage) => ({
    type: f.componentType ?? '',
    fullName: f.fullName,
    problem: f.problem ?? '',
    lineNumber: f.lineNumber !== undefined ? Number(f.lineNumber) : undefined,
    columnNumber: f.columnNumber !== undefined ? Number(f.columnNumber) : undefined,
  }));

  return { testFailures, coverageWarnings, componentFailures };
}

/** Maps SDR's `RequestStatus` string + `done`/`success` flags onto the agreed `DeploymentResult['status']` union. */
export function mapDeployStatus(status: MetadataApiDeployStatus): DeploymentResult['status'] {
  if (status.status === 'Canceled' || status.status === 'Canceling') return 'canceled';
  if (!status.done) return 'in-progress';
  return status.success ? 'succeeded' : 'failed';
}

/**
 * Progress-percent estimate from an in-flight aggregate status poll
 * (`MetadataApiDeploy.onUpdate`). Capped at 99 — 100 is reserved for the
 * job runner's own terminal "succeeded" event once `pollStatus()` resolves,
 * matching how every other job in the codebase (see `retrieval/planner.ts`)
 * treats 100 as "actually done", not "numbers happen to say done".
 */
export function percentFromDeployStatus(status: MetadataApiDeployStatus): number {
  const total = status.numberComponentsTotal || 0;
  if (total === 0) return 50;
  return Math.min(99, Math.round((status.numberComponentsDeployed / total) * 100));
}

export function deployStatusSummaryMessage(status: MetadataApiDeployStatus): string {
  return `Deployed ${status.numberComponentsDeployed}/${status.numberComponentsTotal} component(s), ${status.numberComponentErrors} error(s).`;
}

/** One-line, human-readable summary of a single component's deploy result — the per-component "stream" content relayed over the existing `JobProgress.message` channel (see `executor.ts`'s doc comment for why this is a string, not a structured event). */
export function componentResultLine(fr: FileResponse): string {
  return fr.state === 'Failed' ? `${fr.type} ${fr.fullName}: FAILED — ${fr.error}` : `${fr.type} ${fr.fullName}: ${fr.state}`;
}
