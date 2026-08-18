import type { Connection } from '@salesforce/core';
import { ComponentSet, DestructiveChangesType, RegistryAccess, type DeployResult } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey, MetadataSource } from '../types/metadata-source.js';
import type { DeploymentOptions, DeploymentResult } from '../types/deployment.js';
import { virtualComponent, type DestructiveMode } from '../package/package-xml.js';
import { cleanupSourceTree } from '../compare/content-reader.js';
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

/**
 * Performs the actual SDR deploy-and-poll round trip for an already-built
 * `ComponentSet` (start the deploy, subscribe to aggregate progress, wire
 * cancellation, poll to completion) and returns the raw `DeployResult`.
 * Defaults to the real implementation; overridable in tests — same
 * dependency-injection seam `OrgSource` already uses for its own
 * network-touching step (`OrgSourceDeps.retrieveAndConvert` in
 * `sources/org-source.ts`) — so `runDeploy`'s orchestration (materialize,
 * build the `ComponentSet`, add destructive members, normalize the result,
 * clean up the temp dir) is unit-testable without a live org or a deep
 * mock of `@salesforce/core`'s `Connection`.
 */
export type DeployOperationRunner = (
  cs: ComponentSet,
  usernameOrConnection: string | Connection,
  options: DeploymentOptions,
  apiVersion: string | undefined,
  signal: AbortSignal | undefined,
  onProgress: ((percent: number, message: string) => void) | undefined,
) => Promise<DeployResult>;

async function defaultRunDeployOperation(
  cs: ComponentSet,
  usernameOrConnection: string | Connection,
  options: DeploymentOptions,
  apiVersion: string | undefined,
  signal: AbortSignal | undefined,
  onProgress: ((percent: number, message: string) => void) | undefined,
): Promise<DeployResult> {
  const deployOp = await cs.deploy({
    usernameOrConnection,
    apiVersion,
    apiOptions: {
      checkOnly: options.checkOnly,
      testLevel: options.testLevel,
      runTests: options.runTests,
      rest: options.rest ?? true,
    },
  });

  deployOp.onUpdate((status) => {
    onProgress?.(percentFromDeployStatus(status), deployStatusSummaryMessage(status));
  });

  const onAbort = (): void => {
    void deployOp.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await deployOp.pollStatus();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface RunDeployParams {
  /** A live `Connection`, or a plain username string (SDR resolves it via `AuthInfo`/`Connection.create` the same way `OrgSource` does — see `sources/org-source.ts`). Accepting either avoids callers needing to construct/hold onto a `Connection` object just to call this function. */
  readonly usernameOrConnection: string | Connection;
  /** Recorded on `DeploymentResult.targetOrgId` — the org this deploy actually ran against. */
  readonly targetOrgId: string;
  /** Supplies file content for `components`. Not consulted for `destructiveComponents` — deletions need no content, only identity. */
  readonly source: MetadataSource;
  readonly components: readonly ComponentKey[];
  readonly destructiveComponents: readonly ComponentKey[];
  readonly destructiveMode?: DestructiveMode;
  readonly options: DeploymentOptions;
  readonly registry?: RegistryAccess;
  readonly apiVersion?: string;
  readonly signal?: AbortSignal;
  /** Called on every aggregate status poll AND once per component once results are known — see the module doc for why this is the pragmatic reading of "stream per-component results" against the existing `JobProgress` (percent + message string) contract. */
  readonly onProgress?: (percent: number, message: string) => void;
  /** Test-only override — see `DeployOperationRunner`'s doc comment. Defaults to the real SDR deploy round trip. */
  readonly runDeployOperation?: DeployOperationRunner;
}

export interface RunDeployResult {
  readonly result: DeploymentResult;
  readonly diagnostics: DeployDiagnostics;
}

/**
 * Executes (or validates, when `options.checkOnly`) a deployment via SDR's
 * `ComponentSet`/`MetadataApiDeploy` — `rest: true` by default per the task
 * brief, with SOAP as SDR's own built-in fallback (SDR itself, not this
 * function, owns the REST/SOAP switch once `apiOptions.rest` is set; there
 * is no separate fallback code path to write here).
 *
 * `components` are materialized from `source` (reusing the exact same
 * `MetadataSource.materialize()` the comparison engine uses — no separate
 * retrieval logic for deploy) and turned into a real `ComponentSet` via
 * `ComponentSet.fromSource`; `destructiveComponents` need no file content
 * and are added directly as destructive manifest members.
 *
 * "Stream per-component results over the existing WebSocket job-progress
 * channel": the existing channel's payload (`JobProgress`) is `{percent,
 * message, ...}` — a single string, not a structured per-file event. This
 * function's pragmatic reading: relay SDR's aggregate `onUpdate` status
 * during polling (component counts, not yet resolved to names), then once
 * the deploy finishes and per-file `FileResponse`s are known, emit one
 * additional progress tick per component with a readable one-line summary.
 * The full per-component `DeploymentComponentResult[]` is always available
 * in the final `RunDeployResult` regardless.
 */
export async function runDeploy(params: RunDeployParams): Promise<RunDeployResult> {
  const registry = params.registry ?? new RegistryAccess();
  const destructiveMode = params.destructiveMode ?? 'post';

  const tree = params.components.length > 0 ? await params.source.materialize([...params.components]) : undefined;

  try {
    const cs =
      tree && tree.files.size > 0 ? ComponentSet.fromSource({ fsPaths: [tree.rootDir], registry }) : new ComponentSet([], registry);

    for (const key of params.destructiveComponents) {
      // Real `SourceComponent` instances, not plain `{fullName, type}`
      // literals — see `package/package-xml.ts`'s `virtualComponent` doc
      // comment for the SDR internal-map-population quirk this avoids.
      cs.add(virtualComponent(key, registry), destructiveMode === 'pre' ? DestructiveChangesType.PRE : DestructiveChangesType.POST);
    }
    if (params.apiVersion) cs.apiVersion = params.apiVersion;

    const startedAt = new Date().toISOString();
    const runOperation = params.runDeployOperation ?? defaultRunDeployOperation;
    const deployResult = await runOperation(
      cs,
      params.usernameOrConnection,
      params.options,
      params.apiVersion,
      params.signal,
      params.onProgress,
    );

    const fileResponses = deployResult.getFileResponses();
    for (const fr of fileResponses) params.onProgress?.(99, componentResultLine(fr));

    const completedAt = new Date().toISOString();
    const status = deployResult.response;
    const result: DeploymentResult = {
      deploymentId: status.id,
      targetOrgId: params.targetOrgId,
      status: mapDeployStatus(status),
      checkOnly: status.checkOnly,
      startedAt,
      completedAt,
      componentResults: normalizeFileResponses(fileResponses),
      numberComponentErrors: status.numberComponentErrors,
      numberComponentsDeployed: status.numberComponentsDeployed,
      numberComponentsTotal: status.numberComponentsTotal,
      testResults: normalizeTestResults(status.details?.runTestResult),
      validationId: params.options.checkOnly ? status.id : undefined,
    };

    return { result, diagnostics: normalizeDeployDiagnostics(status) };
  } finally {
    if (tree) await cleanupSourceTree(tree);
  }
}

