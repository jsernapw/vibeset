import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ComponentKey, DeployComponentStatus, DeployDiagnostics, DeploymentComponentResult, TestLevel } from '@vibeset/core';
import { componentKeyToString } from '@/lib/selection-store';
import { useDeploymentDraftStore } from '@/lib/deployment-draft-store';
import type { DeploymentRecord } from '@/lib/types/deployment';
import { jobProgressWsUrl, trpc } from '@/lib/trpc';

/**
 * Adapter boundary for deployment execution — now backed by
 * `packages/server`'s real `deploy.*` tRPC router instead of the
 * client-side fabrication in `lib/mock/deployment-mock.ts`/`deployment-store.ts`
 * this file used to drive (both now deleted/trimmed — see
 * `lib/mock/deployment-mock.ts`'s doc comment).
 *
 * ONE SIGNATURE NUANCE the parallel UX workstream (owns `routes/**`,
 * `components/deploy/**`) should know about: `useStartDeployment().start()`
 * is STILL synchronous, returning a `string` deployment id immediately —
 * `routes/deployments.new.tsx` relies on this (`const id = start(...);
 * navigate(...)`) and this file cannot touch that route. But starting a
 * real deployment is inherently two chained async tRPC calls
 * (`deploy.buildPackage` then `deploy.validate`/`deploy.deploy`), so the
 * "synchronous" id returned here is generated CLIENT-SIDE
 * (`crypto.randomUUID()`) and passed through to the server, which now
 * accepts an optional caller-supplied `deploymentId` on `deploy.validate`/
 * `deploy.deploy` (see `packages/server/src/trpc/routers/deploy.ts`) and
 * uses it verbatim instead of minting its own. The real async chain runs in
 * the background; a module-level "live" overlay (below) synthesizes a
 * `queued`/`in-progress` record for that id until the server's `deployments`
 * row actually exists, then steps aside once it does. If/when the UX
 * workstream touches `deployments.new.tsx` again, switching `start()` to
 * `Promise<string>` + `await`-ing at the call site would be the cleaner
 * long-term shape — flagged here rather than done unilaterally since it's
 * outside this file's ownership boundary.
 */

/** Matches `deploymentComponents` row shape (`deploy.status`/`history.get`'s `components` field) — defined manually rather than derived via `ReturnType<typeof trpc.*.useQuery>`, which doesn't specialize cleanly through tRPC v11's overloaded `useQuery` signature (collapses to `{}`). */
interface DeploymentComponentRow {
  readonly type: string;
  readonly fullName: string;
  readonly status: string;
  readonly changed: boolean | null;
  readonly errorMessage: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}

/** Common shape of a `deployments` row as returned by `deploy.status`/`history.get`/`history.list` — see this file's top-of-file note on why this is spelled out manually rather than derived from `typeof trpc...useQuery`. */
interface DeployRowLike {
  readonly id: string;
  readonly packageName?: string;
  readonly targetLabel?: string;
  readonly targetConnectionId: string | null;
  readonly status: string;
  readonly checkOnly: boolean;
  readonly testLevel: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly numberComponentErrors: number | null;
  readonly numberComponentsDeployed: number | null;
  readonly numberComponentsTotal: number | null;
  readonly validationId: string | null;
  readonly resultJson: string | null;
}

/** `history.list`'s row shape: a `DeployRowLike` plus the Quick Deploy flag and the resolved package component list `findQuickDeployCandidate` matches against. */
interface HistoryRow extends DeployRowLike {
  readonly quickDeployable: boolean;
  readonly packageComponents: ComponentKey[];
}

function toComponentResults(rows: readonly DeploymentComponentRow[]): DeploymentComponentResult[] {
  return rows.map((r) => ({
    key: { type: r.type, fullName: r.fullName },
    status: r.status as DeployComponentStatus,
    changed: !!r.changed,
    errorMessage: r.errorMessage ?? undefined,
    lineNumber: r.lineNumber ?? undefined,
    columnNumber: r.columnNumber ?? undefined,
  }));
}

function buildLogLines(row: DeployRowLike, diagnostics: DeployDiagnostics | undefined): string[] {
  const lines: string[] = [
    `[info] ${row.checkOnly ? 'Validation' : 'Deployment'} against ${row.targetLabel ?? row.targetConnectionId ?? 'target'}`,
    `[info] Test level: ${row.testLevel ?? 'NoTestRun'}`,
  ];
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'canceled') {
    lines.push(
      `[info] Result: ${row.status} — ${row.numberComponentsDeployed ?? 0}/${row.numberComponentsTotal ?? 0} deployed, ${row.numberComponentErrors ?? 0} error(s).`,
    );
  }
  if (diagnostics) {
    for (const f of diagnostics.testFailures) lines.push(`[test] FAILED ${f.className}.${f.methodName}: ${f.message}`);
    for (const w of diagnostics.coverageWarnings) lines.push(`[coverage] ${w.name}: ${w.message}`);
    for (const f of diagnostics.componentFailures) lines.push(`[component] ${f.type} ${f.fullName}: ${f.problem}`);
  }
  return lines;
}

function toRecord(
  row: DeployRowLike,
  componentRows: readonly DeploymentComponentRow[] = [],
  diagnostics?: DeployDiagnostics,
): DeploymentRecord {
  const parsedResult = row.resultJson ? (JSON.parse(row.resultJson) as { testResults?: DeploymentRecord['testResults'] }) : undefined;
  return {
    id: row.id,
    packageName: row.packageName ?? 'package',
    targetLabel: row.targetLabel ?? row.targetConnectionId ?? 'target',
    initiator: 'you',
    status: row.status as DeploymentRecord['status'],
    checkOnly: row.checkOnly,
    testLevel: (row.testLevel ?? 'NoTestRun') as TestLevel,
    startedAt: row.startedAt ?? row.createdAt,
    completedAt: row.completedAt ?? undefined,
    componentResults: toComponentResults(componentRows),
    numberComponentErrors: row.numberComponentErrors ?? 0,
    numberComponentsDeployed: row.numberComponentsDeployed ?? 0,
    numberComponentsTotal: row.numberComponentsTotal ?? 0,
    validationId: row.validationId ?? undefined,
    testResults: parsedResult?.testResults,
    logLines: buildLogLines(row, diagnostics),
  };
}

// --- Live overlay for deployments started this session -------------------
// Bridges the brief window between `start()` returning a client-generated
// id and the server's `deployments` row actually existing (two chained
// mutations), and carries live WS progress messages the server doesn't
// persist mid-job (per-component results only land once the real Metadata
// API deploy finishes — see `runDeploy`'s doc comment in `@vibeset/core`).

interface LiveEntry {
  phase: 'starting' | 'running' | 'done' | 'failed' | 'canceled';
  message: string;
  packageName: string;
  targetLabel: string;
  checkOnly: boolean;
  testLevel: TestLevel;
  startedAt: string;
  logLines: string[];
}

const liveDeployments = new Map<string, LiveEntry>();
let liveVersion = 0;
const liveListeners = new Set<() => void>();

function bumpLive(): void {
  liveVersion += 1;
  for (const l of liveListeners) l();
}

function patchLive(id: string, patch: Partial<Omit<LiveEntry, 'logLines'>> & { appendLog?: string }): void {
  const current = liveDeployments.get(id);
  if (!current) return;
  const { appendLog, ...rest } = patch;
  liveDeployments.set(id, {
    ...current,
    ...rest,
    logLines: appendLog ? [...current.logLines, `[progress] ${appendLog}`] : current.logLines,
  });
  bumpLive();
}

function useLiveVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => liveListeners.delete(cb);
    },
    () => liveVersion,
    () => liveVersion,
  );
}

/** Synthesizes/overlays live session state onto (possibly absent) server data for one deployment id. */
function withLiveOverlay(id: string, base: DeploymentRecord | undefined): DeploymentRecord | undefined {
  const live = liveDeployments.get(id);
  if (!live || live.phase === 'done') return base;

  if (base) {
    const status: DeploymentRecord['status'] =
      live.phase === 'failed' ? 'failed' : live.phase === 'canceled' ? 'canceled' : live.phase === 'running' ? 'in-progress' : base.status;
    return { ...base, status, logLines: [...base.logLines, ...live.logLines] };
  }

  return {
    id,
    packageName: live.packageName,
    targetLabel: live.targetLabel,
    initiator: 'you',
    status: live.phase === 'failed' ? 'failed' : live.phase === 'canceled' ? 'canceled' : live.phase === 'running' ? 'in-progress' : 'queued',
    checkOnly: live.checkOnly,
    testLevel: live.testLevel,
    startedAt: live.startedAt,
    componentResults: [],
    numberComponentErrors: 0,
    numberComponentsDeployed: 0,
    numberComponentsTotal: 0,
    logLines: live.logLines,
  };
}

// Last-seen `history.list` rows, kept for `findQuickDeployCandidate` (a
// plain synchronous function, not a hook — see its doc comment) to read
// synchronously. Warmed by `useDeployments()`.
let historyCache: readonly HistoryRow[] = [];

export function useDeployments(): DeploymentRecord[] {
  const query = trpc.history.list.useQuery(undefined, { refetchInterval: 3000 });
  const version = useLiveVersion();

  useEffect(() => {
    if (query.data) historyCache = query.data;
  }, [query.data]);

  return useMemo(() => {
    const rows = query.data ?? [];
    const merged = rows.map((r) => withLiveOverlay(r.id, toRecord(r)) ?? toRecord(r));
    const knownIds = new Set(merged.map((r) => r.id));
    const pendingOnly: DeploymentRecord[] = [];
    for (const [id, live] of liveDeployments) {
      if (knownIds.has(id) || live.phase === 'done') continue;
      const synthesized = withLiveOverlay(id, undefined);
      if (synthesized) pendingOnly.push(synthesized);
    }
    return [...pendingOnly, ...merged];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the live-overlay change signal.
  }, [query.data, version]);
}

export function useDeployment(id: string | undefined): DeploymentRecord | undefined {
  const query = trpc.deploy.status.useQuery(
    { deploymentId: id ?? '' },
    { enabled: !!id, retry: false, refetchInterval: 2000 },
  );
  const version = useLiveVersion();

  return useMemo(() => {
    if (!id) return undefined;
    const base = query.data ? toRecord(query.data, query.data.components, query.data.diagnostics) : undefined;
    return withLiveOverlay(id, base);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the live-overlay change signal.
  }, [id, query.data, version]);
}

export interface StartDeploymentParams {
  readonly components: ComponentKey[];
  readonly destructiveComponents: ComponentKey[];
  readonly checkOnly: boolean;
  readonly testLevel: TestLevel;
  readonly targetLabel: string;
  readonly packageName: string;
  /** Required by `RunSpecifiedTests` (the API rejects an empty list); ignored by every other level. */
  readonly runTests?: string[];
}

/** Stable signature for a component set, used to key the Quick Deploy validation-window lookup. */
export function componentsSignature(components: readonly ComponentKey[]): string {
  return components.map(componentKeyToString).sort().join('|');
}

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Plain synchronous function (not a hook — `routes/deployments.new.tsx`
 * calls it inside a `useMemo`, not as a hook itself), so it reads from
 * `historyCache` rather than issuing its own query. Best-effort: if no
 * `useDeployments()` has mounted yet this session, the cache is empty and
 * this returns `undefined` (same as "nothing recorded yet", the mock's
 * original cold-start behavior) rather than fabricating a match.
 */
export function findQuickDeployCandidate(components: readonly ComponentKey[]) {
  if (components.length === 0) return undefined;
  const sig = componentsSignature(components);
  const now = Date.now();
  for (const row of historyCache) {
    if (!row.checkOnly || row.status !== 'succeeded' || !row.quickDeployable || !row.validationId) continue;
    if (componentsSignature(row.packageComponents ?? []) !== sig) continue;
    const validatedAt = row.completedAt ?? row.startedAt ?? row.createdAt;
    const ageMs = now - new Date(validatedAt).getTime();
    if (ageMs > TEN_DAYS_MS) continue;
    return {
      deploymentId: row.id,
      validationId: row.validationId,
      validatedAt,
      daysRemaining: Math.max(0, Math.ceil((TEN_DAYS_MS - ageMs) / (24 * 60 * 60 * 1000))),
    };
  }
  return undefined;
}

interface WsProgressMessage {
  readonly status: string;
  readonly percent: number;
  readonly message?: string;
}

export function useStartDeployment() {
  const utils = trpc.useUtils();
  const buildPackage = trpc.deploy.buildPackage.useMutation();
  const validateMut = trpc.deploy.validate.useMutation();
  const deployMut = trpc.deploy.deploy.useMutation();
  const cancelMut = trpc.deploy.cancel.useMutation();
  const wsMapRef = useRef(new Map<string, WebSocket>());

  const start = useCallback(
    (params: StartDeploymentParams): string => {
      const deploymentId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      liveDeployments.set(deploymentId, {
        phase: 'starting',
        message: 'Building package...',
        packageName: params.packageName,
        targetLabel: params.targetLabel,
        checkOnly: params.checkOnly,
        testLevel: params.testLevel,
        startedAt,
        logLines: [
          `[info] ${params.checkOnly ? 'Validation' : 'Deployment'} started against ${params.targetLabel}`,
          `[info] Test level: ${params.testLevel}`,
          ...(params.runTests?.length ? [`[info] Tests: ${params.runTests.join(', ')}`] : []),
        ],
      });
      bumpLive();

      void (async () => {
        try {
          const draftComparisonId = useDeploymentDraftStore.getState().comparisonId;
          if (!draftComparisonId) {
            throw new Error('No comparison is associated with this selection — start a deployment from a comparison\'s results.');
          }

          // `comparisons.start`'s doc comment: `left` = target org (current
          // state), `right` = desired/source state — the exact convention a
          // deployment package needs.
          const comparison = await utils.comparisons.get.fetch({ comparisonId: draftComparisonId });
          const targetConnectionId = comparison.leftConnectionId;
          const sourceConnectionId = comparison.rightConnectionId;
          if (!targetConnectionId) throw new Error('The source comparison has no recorded target connection.');

          const selectedKeys = [...params.components, ...params.destructiveComponents];
          const pkg = await buildPackage.mutateAsync({
            comparisonId: draftComparisonId,
            name: params.packageName,
            selectedKeys,
          });

          patchLive(deploymentId, { message: params.checkOnly ? 'Starting validation...' : 'Starting deployment...' });

          const mutate = params.checkOnly ? validateMut : deployMut;
          const res = await mutate.mutateAsync({
            packageId: pkg.packageId,
            targetConnectionId,
            sourceConnectionId: sourceConnectionId ?? undefined,
            testLevel: params.testLevel,
            runTests: params.runTests,
            deploymentId,
          });

          patchLive(deploymentId, { phase: 'running', message: 'Deploying...' });
          void utils.history.list.invalidate();

          const ws = new WebSocket(jobProgressWsUrl(res.jobId));
          wsMapRef.current.set(deploymentId, ws);
          ws.onmessage = (event) => {
            const p = JSON.parse(event.data as string) as WsProgressMessage;
            const phase: LiveEntry['phase'] =
              p.status === 'succeeded' ? 'done' : p.status === 'failed' ? 'failed' : p.status === 'canceled' ? 'canceled' : 'running';
            patchLive(deploymentId, { phase, message: p.message ?? '', appendLog: p.message });
            if (phase !== 'running') {
              ws.close();
              wsMapRef.current.delete(deploymentId);
              void utils.deploy.status.invalidate({ deploymentId });
              void utils.history.list.invalidate();
            }
          };
          ws.onerror = () => {
            patchLive(deploymentId, { phase: 'failed', message: 'Lost connection to the deployment job.' });
          };
        } catch (err) {
          patchLive(deploymentId, { phase: 'failed', message: (err as Error).message });
        }
      })();

      return deploymentId;
    },
    [utils, buildPackage, validateMut, deployMut],
  );

  const cancel = useCallback(
    (id: string) => {
      wsMapRef.current.get(id)?.close();
      wsMapRef.current.delete(id);
      patchLive(id, { phase: 'canceled', message: 'Canceling...' });
      cancelMut.mutate(
        { deploymentId: id },
        {
          onSettled: () => {
            patchLive(id, { phase: 'canceled', message: 'Canceled by user.' });
            void utils.deploy.status.invalidate({ deploymentId: id });
          },
        },
      );
    },
    [cancelMut, utils],
  );

  return { start, cancel };
}
