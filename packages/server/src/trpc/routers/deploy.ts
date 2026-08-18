import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  capturePreDeployState,
  componentKeyString,
  deployRecentValidation,
  generatePackageXml,
  generateRollbackPlan,
  isQuickDeployable,
  runDeploy,
  saveManifest,
  SnapshotContentSource,
  toManifest,
  topologicalOrder,
  type ComponentKey,
  type DeployDiagnostics,
  type DeploymentOptions,
  type PreDeployComponentState,
  type RunDeployResult,
  type SnapshotStore,
  type TestLevel,
} from '@vibeset/core';
import type { JobHandler } from '../../jobs/job-runner.js';
import type { Db } from '../../db/client.js';
import { connections, deploymentComponents, deploymentPackages, deployments, diffResults } from '../../db/schema.js';
import { sourceFromConnectionRow } from '../../jobs/shared/source-from-connection.js';
import { preDeployStateFromRows } from '../../jobs/shared/pre-deploy-state.js';
import { vibesetHome } from '../../db/paths.js';
import { publicProcedure, router } from '../trpc.js';

const ComponentKeySchema = z.object({ type: z.string(), fullName: z.string(), parentFullName: z.string().optional() });
const TestLevelSchema = z.enum(['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']);
const DestructiveModeSchema = z.enum(['pre', 'post']);

export interface DeployJobPayload {
  readonly deploymentId: string;
  readonly targetConnectionId: string;
  readonly checkOnly: boolean;
  readonly testLevel: TestLevel;
  readonly runTests?: string[];
  readonly rest?: boolean;
  readonly destructiveMode?: 'pre' | 'post';
  readonly components: ComponentKey[];
  readonly destructiveComponents: ComponentKey[];
  /** Connection supplying content for `components` — the comparison's "desired state" side. Absent for a rollback deploy (content comes from `rollback.restoreContent` instead). */
  readonly sourceConnectionId?: string;
  readonly quickDeploy?: { readonly validationId: string };
  readonly rollback?: { readonly restoreContent: Record<string, string> };
}

/**
 * The `'deploy'`/`'validate'` job types' shared in-process handler
 * (registered twice in `server.ts` — see `forceCheckOnly`). In-process for
 * the same reason as `inventory`/`compare`: a live `Connection` can't cross
 * a worker-thread boundary.
 *
 * Always captures pre-deploy target state (`capturePreDeployState`) before
 * a REAL execute-path deploy (not for `checkOnly` validations — a
 * validation never touches the target, so there's nothing to snapshot, and
 * paying for the extra inventory/materialize round trip on every
 * validation would be pure overhead) — this is what makes
 * `history.generateRollback` "nearly free" later, per the task brief.
 */
export function createDeployJobHandler(
  deps: { readonly db: Db; readonly snapshotStore: SnapshotStore },
  options: { readonly forceCheckOnly?: boolean } = {},
): JobHandler {
  return async (payload, { signal, onProgress }) => {
    const p = payload as DeployJobPayload;
    const checkOnly = options.forceCheckOnly ?? p.checkOnly;

    // The whole body — INCLUDING the connection lookup/validation below —
    // must run inside the try/catch: an earlier version threw those
    // validation errors before entering the try block, which meant a bad
    // target connection left the `deployments` row stuck at 'queued'
    // forever (the job itself correctly failed, but the DB row never
    // learned about it). Every failure path must reach the catch below.
    try {
      const targetRow = deps.db.select().from(connections).where(eq(connections.id, p.targetConnectionId)).get();
      if (!targetRow) throw new Error(`No connection with id ${p.targetConnectionId}.`);
      if (targetRow.kind !== 'org' || !targetRow.username) {
        throw new Error(`Deploy target connection ${p.targetConnectionId} must be an org connection.`);
      }

      deps.db
        .update(deployments)
        .set({ status: 'running', startedAt: new Date().toISOString() })
        .where(eq(deployments.id, p.deploymentId))
        .run();

      const touchedKeys = [...p.components, ...p.destructiveComponents];
      let preDeployState: Map<string, PreDeployComponentState> | undefined;

      let runResult: RunDeployResult;

      if (p.quickDeploy) {
        if (!checkOnly && touchedKeys.length > 0) {
          const targetSource = sourceFromConnectionRow(targetRow);
          preDeployState = await capturePreDeployState({ targetSource, keys: touchedKeys, store: deps.snapshotStore, signal });
        }
        runResult = await deployRecentValidation({
          usernameOrConnection: targetRow.username,
          targetOrgId: targetRow.id,
          validationId: p.quickDeploy.validationId,
          rest: p.rest,
          signal,
          onProgress,
        });
      } else {
        const targetSource = sourceFromConnectionRow(targetRow);
        if (!checkOnly && touchedKeys.length > 0) {
          preDeployState = await capturePreDeployState({ targetSource, keys: touchedKeys, store: deps.snapshotStore, signal });
        }

        const contentSource = p.rollback
          ? new SnapshotContentSource('rollback-content', 'Rollback content', new Map(Object.entries(p.rollback.restoreContent)))
          : (() => {
              if (!p.sourceConnectionId) throw new Error('DeployJobPayload.sourceConnectionId is required for a non-rollback deploy.');
              const sourceRow = deps.db.select().from(connections).where(eq(connections.id, p.sourceConnectionId)).get();
              if (!sourceRow) throw new Error(`No connection with id ${p.sourceConnectionId}.`);
              return sourceFromConnectionRow(sourceRow);
            })();

        const options: DeploymentOptions = { checkOnly, testLevel: p.testLevel, runTests: p.runTests, rest: p.rest };

        runResult = await runDeploy({
          usernameOrConnection: targetRow.username,
          targetOrgId: targetRow.id,
          source: contentSource,
          components: p.components,
          destructiveComponents: p.destructiveComponents,
          destructiveMode: p.destructiveMode,
          options,
          signal,
          onProgress,
        });
      }

      const componentRows = runResult.result.componentResults.map((cr) => {
        const pre = preDeployState?.get(componentKeyString(cr.key));
        return {
          id: nanoid(),
          deploymentId: p.deploymentId,
          type: cr.key.type,
          fullName: cr.key.fullName,
          status: cr.status,
          changed: cr.changed,
          errorMessage: cr.errorMessage,
          lineNumber: cr.lineNumber,
          columnNumber: cr.columnNumber,
          beforeExisted: pre?.existed ?? null,
          beforeSha256: pre?.sha256 ?? null,
        };
      });
      if (componentRows.length > 0) {
        deps.db.transaction((tx) => {
          for (const row of componentRows) tx.insert(deploymentComponents).values(row).run();
        });
      }

      deps.db
        .update(deployments)
        .set({
          status: runResult.result.status,
          numberComponentErrors: runResult.result.numberComponentErrors,
          numberComponentsDeployed: runResult.result.numberComponentsDeployed,
          numberComponentsTotal: runResult.result.numberComponentsTotal,
          resultJson: JSON.stringify(runResult.result),
          diagnosticsJson: JSON.stringify(runResult.diagnostics satisfies DeployDiagnostics),
          targetOrgId: runResult.result.targetOrgId,
          validationId: runResult.result.validationId,
          completedAt: runResult.result.completedAt,
        })
        .where(eq(deployments.id, p.deploymentId))
        .run();

      return { deploymentId: p.deploymentId, status: runResult.result.status };
    } catch (err) {
      // Same reasoning as `comparisons.ts`'s compare job handler: an
      // `AbortError` means `deploy.cancel` fired, not a genuine failure —
      // record it as `canceled` so history doesn't misreport a
      // user-initiated cancel as a broken deploy.
      const status = (err as Error)?.name === 'AbortError' ? 'canceled' : 'failed';
      deps.db
        .update(deployments)
        .set({ status, completedAt: new Date().toISOString() })
        .where(eq(deployments.id, p.deploymentId))
        .run();
      throw err;
    }
  };
}

function loadDiffResultsByKey(db: Db, comparisonId: string, keys: readonly ComponentKey[]) {
  if (keys.length === 0) return new Map<string, (typeof diffResults.$inferSelect)>();
  const types = [...new Set(keys.map((k) => k.type))];
  const rows = db
    .select()
    .from(diffResults)
    .where(eq(diffResults.comparisonId, comparisonId))
    .all()
    .filter((r) => types.includes(r.type));
  return new Map(rows.map((r) => [componentKeyString({ type: r.type, fullName: r.fullName }), r] as const));
}

export const deployRouter = router({
  /**
   * Builds a `DeploymentPackage` from a set of selected diff-result keys,
   * routing each by its recorded status (see `package/selection.ts`'s
   * documented left/right convention: `'new'`/`'changed'` -> add/update,
   * `'deleted'` -> destructive), orders it (`topologicalOrder`), generates
   * `package.xml`/destructive-changes XML for review, and saves a YAML
   * manifest under `.vibeset/`.
   */
  buildPackage: publicProcedure
    .input(
      z.object({
        comparisonId: z.string(),
        name: z.string().min(1),
        selectedKeys: z.array(ComponentKeySchema).min(1),
        destructiveMode: DestructiveModeSchema.default('post'),
        apiVersion: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const byKey = loadDiffResultsByKey(ctx.db, input.comparisonId, input.selectedKeys);
      const components: ComponentKey[] = [];
      const destructiveComponents: ComponentKey[] = [];

      for (const key of input.selectedKeys) {
        const row = byKey.get(componentKeyString(key));
        if (!row) continue;
        if (row.status === 'deleted') destructiveComponents.push(key);
        else if (row.status === 'new' || row.status === 'changed') components.push(key);
      }

      const ordered = topologicalOrder(components);
      const packageId = nanoid();
      const now = new Date().toISOString();

      const manifest = toManifest(
        { id: packageId, name: input.name, comparisonId: input.comparisonId, components: ordered, destructiveComponents, createdAt: now },
        { destructiveMode: input.destructiveMode, createdAt: now },
      );
      const manifestPath = await saveManifest(manifest, vibesetHome());

      ctx.db
        .insert(deploymentPackages)
        .values({
          id: packageId,
          name: input.name,
          comparisonId: input.comparisonId,
          componentsJson: JSON.stringify(ordered),
          destructiveComponentsJson: JSON.stringify(destructiveComponents),
          manifestPath,
          destructiveMode: input.destructiveMode,
          createdAt: now,
        })
        .run();

      const { packageXml, destructiveChangesXml } = await generatePackageXml({
        components: ordered,
        destructiveComponents,
        destructiveMode: input.destructiveMode,
        apiVersion: input.apiVersion,
      });

      return { packageId, manifestPath, components: ordered, destructiveComponents, packageXml, destructiveChangesXml };
    }),

  get: publicProcedure.input(z.object({ packageId: z.string() })).query(({ ctx, input }) => {
    const row = ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, input.packageId)).get();
    if (!row) throw new Error(`No deployment package with id ${input.packageId}.`);
    return {
      ...row,
      components: JSON.parse(row.componentsJson) as ComponentKey[],
      destructiveComponents: row.destructiveComponentsJson ? (JSON.parse(row.destructiveComponentsJson) as ComponentKey[]) : [],
    };
  }),

  /**
   * Starts a `checkOnly` validation. `sourceConnectionId` is the
   * comparison's "desired state" side — where `components`' content is
   * materialized from. Omit it when `packageId` refers to a rollback
   * package (`history.generateRollback`'s output): content is instead
   * re-derived from the content-addressed snapshot store, keeping this ONE
   * route the same "normal deployable package" path for both cases, per
   * the task brief.
   */
  validate: publicProcedure
    .input(
      z.object({
        packageId: z.string(),
        targetConnectionId: z.string(),
        sourceConnectionId: z.string().optional(),
        testLevel: TestLevelSchema.default('NoTestRun'),
        runTests: z.array(z.string()).optional(),
        rest: z.boolean().optional(),
        /** Phase 1d addition: see `deploy` (below) for why the caller may supply this. */
        deploymentId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => startDeployJob(ctx, input, true, 'validate')),

  /**
   * Starts a real (non-`checkOnly`) deploy. See `validate`'s doc comment for
   * the rollback-package case (`sourceConnectionId` omitted).
   *
   * `deploymentId` is optional and normally omitted (the server mints one).
   * `@vibeset/web`'s deploy-review screen navigates to
   * `/deployments/:deploymentId` the instant the user clicks Deploy/Validate
   * — before this mutation (which chains a `buildPackage` call first) has
   * resolved — so it generates the id client-side and passes it through
   * here to be used verbatim, rather than the route needing to `await` this
   * call before it knows where to navigate. See `lib/adapters/deploy.ts`'s
   * top-of-file doc comment in `@vibeset/web` for the full rationale.
   */
  deploy: publicProcedure
    .input(
      z.object({
        packageId: z.string(),
        targetConnectionId: z.string(),
        sourceConnectionId: z.string().optional(),
        testLevel: TestLevelSchema.default('NoTestRun'),
        runTests: z.array(z.string()).optional(),
        rest: z.boolean().optional(),
        deploymentId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => startDeployJob(ctx, input, false, 'deploy')),

  /** Deploys a prior succeeded validation without re-running tests, within the 10-day window (`isQuickDeployable`). Reuses the original validation's `deploymentPackages` row so the same `components`/`destructiveComponents` set is pre-deploy-snapshotted for rollback purposes. */
  quickDeploy: publicProcedure
    .input(z.object({ sourceDeploymentId: z.string(), rest: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const priorDeployment = ctx.db.select().from(deployments).where(eq(deployments.id, input.sourceDeploymentId)).get();
      if (!priorDeployment) throw new Error(`No deployment with id ${input.sourceDeploymentId}.`);
      if (
        !isQuickDeployable({
          checkOnly: priorDeployment.checkOnly,
          status: priorDeployment.status as 'succeeded',
          completedAt: priorDeployment.completedAt ?? undefined,
          validationId: priorDeployment.validationId ?? undefined,
        })
      ) {
        throw new Error(`Deployment ${input.sourceDeploymentId} is not eligible for Quick Deploy.`);
      }
      if (!priorDeployment.packageId) throw new Error(`Deployment ${input.sourceDeploymentId} has no associated package.`);
      const pkg = ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, priorDeployment.packageId)).get();
      if (!pkg) throw new Error(`No deployment package with id ${priorDeployment.packageId}.`);
      if (!priorDeployment.targetConnectionId) throw new Error('Original validation has no recorded target connection.');

      const deploymentId = nanoid();
      const now = new Date().toISOString();
      ctx.db
        .insert(deployments)
        .values({
          id: deploymentId,
          packageId: pkg.id,
          targetConnectionId: priorDeployment.targetConnectionId,
          status: 'queued',
          checkOnly: false,
          testLevel: priorDeployment.testLevel,
          createdAt: now,
        })
        .run();

      const jobId = await ctx.jobRunner.enqueue({
        type: 'deploy',
        payload: {
          deploymentId,
          targetConnectionId: priorDeployment.targetConnectionId,
          checkOnly: false,
          testLevel: (priorDeployment.testLevel ?? 'NoTestRun') as TestLevel,
          rest: input.rest,
          components: JSON.parse(pkg.componentsJson) as ComponentKey[],
          destructiveComponents: pkg.destructiveComponentsJson ? (JSON.parse(pkg.destructiveComponentsJson) as ComponentKey[]) : [],
          destructiveMode: (pkg.destructiveMode as 'pre' | 'post' | null) ?? 'post',
          quickDeploy: { validationId: priorDeployment.validationId! },
        } satisfies DeployJobPayload,
      });

      ctx.db.update(deployments).set({ jobId }).where(eq(deployments.id, deploymentId)).run();
      return { deploymentId, jobId };
    }),

  /** Deployment row + per-component results + resolved package/target labels + whether it's still Quick-Deployable. */
  status: publicProcedure.input(z.object({ deploymentId: z.string() })).query(({ ctx, input }) => {
    const row = ctx.db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).get();
    if (!row) throw new Error(`No deployment with id ${input.deploymentId}.`);
    const components = ctx.db
      .select()
      .from(deploymentComponents)
      .where(eq(deploymentComponents.deploymentId, input.deploymentId))
      .all();
    const quickDeployable = isQuickDeployable({
      checkOnly: row.checkOnly,
      status: row.status as 'succeeded',
      completedAt: row.completedAt ?? undefined,
      validationId: row.validationId ?? undefined,
    });

    const pkg = row.packageId ? ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, row.packageId)).get() : undefined;
    const target = row.targetConnectionId
      ? ctx.db.select().from(connections).where(eq(connections.id, row.targetConnectionId)).get()
      : undefined;

    return {
      ...row,
      components,
      quickDeployable,
      diagnostics: row.diagnosticsJson ? (JSON.parse(row.diagnosticsJson) as DeployDiagnostics) : undefined,
      packageName: pkg?.name,
      packageComponents: pkg ? (JSON.parse(pkg.componentsJson) as ComponentKey[]) : [],
      targetLabel: target?.label,
    };
  }),

  cancel: publicProcedure.input(z.object({ deploymentId: z.string() })).mutation(({ ctx, input }) => {
    const row = ctx.db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).get();
    if (!row?.jobId) return { canceled: false };
    return { canceled: ctx.jobRunner.cancel(row.jobId) };
  }),
});

interface StartDeployInput {
  readonly packageId: string;
  readonly targetConnectionId: string;
  readonly sourceConnectionId?: string;
  readonly testLevel: TestLevel;
  readonly runTests?: string[];
  readonly rest?: boolean;
  readonly deploymentId?: string;
}

async function startDeployJob(
  ctx: {
    readonly db: Db;
    readonly snapshotStore: SnapshotStore;
    readonly jobRunner: { enqueue: (opts: { type: 'deploy' | 'validate'; payload: unknown }) => Promise<string> };
  },
  input: StartDeployInput,
  checkOnly: boolean,
  jobType: 'deploy' | 'validate',
) {
  const pkg = ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, input.packageId)).get();
  if (!pkg) throw new Error(`No deployment package with id ${input.packageId}.`);

  const components = JSON.parse(pkg.componentsJson) as ComponentKey[];
  const destructiveComponents = pkg.destructiveComponentsJson ? (JSON.parse(pkg.destructiveComponentsJson) as ComponentKey[]) : [];

  // Rollback package: content comes from the content-addressed snapshot
  // store (the original deployment's pre-deploy state), not a registered
  // connection. Re-derive it fresh here rather than persisting a
  // potentially large content blob on the package row.
  let rollback: DeployJobPayload['rollback'];
  if (pkg.rollbackOfDeploymentId) {
    const originalRows = ctx.db
      .select()
      .from(deploymentComponents)
      .where(eq(deploymentComponents.deploymentId, pkg.rollbackOfDeploymentId))
      .all();
    const preDeployState = preDeployStateFromRows(originalRows);
    const plan = await generateRollbackPlan(
      { components, destructiveComponents, preDeployState },
      ctx.snapshotStore,
    );
    rollback = { restoreContent: Object.fromEntries(plan.restoreContent) };
  } else if (!input.sourceConnectionId) {
    throw new Error(`Package ${input.packageId} is not a rollback package; sourceConnectionId is required.`);
  }

  const deploymentId = input.deploymentId ?? nanoid();
  const now = new Date().toISOString();
  ctx.db
    .insert(deployments)
    .values({
      id: deploymentId,
      packageId: pkg.id,
      targetConnectionId: input.targetConnectionId,
      status: 'queued',
      checkOnly,
      testLevel: input.testLevel,
      rollbackOfDeploymentId: pkg.rollbackOfDeploymentId,
      createdAt: now,
    })
    .run();

  const jobId = await ctx.jobRunner.enqueue({
    type: jobType,
    payload: {
      deploymentId,
      targetConnectionId: input.targetConnectionId,
      sourceConnectionId: rollback ? undefined : input.sourceConnectionId,
      checkOnly,
      testLevel: input.testLevel,
      runTests: input.runTests,
      rest: input.rest,
      destructiveMode: (pkg.destructiveMode as 'pre' | 'post' | null) ?? 'post',
      components,
      destructiveComponents,
      rollback,
    } satisfies DeployJobPayload,
  });

  ctx.db.update(deployments).set({ jobId }).where(eq(deployments.id, deploymentId)).run();
  return { deploymentId, jobId };
}
