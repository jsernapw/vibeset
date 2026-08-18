import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  generateRollbackPlan,
  isQuickDeployable,
  manifestToYaml,
  saveManifest,
  toManifest,
  type ComponentKey,
  type DeployDiagnostics,
} from '@vibeset/core';
import { connections, deploymentComponents, deploymentPackages, deployments } from '../../db/schema.js';
import { preDeployStateFromRows } from '../../jobs/shared/pre-deploy-state.js';
import { vibesetHome } from '../../db/paths.js';
import { publicProcedure, router } from '../trpc.js';

export const historyRouter = router({
  /**
   * Every deployment ever run, most recent first, with the Quick Deploy flag
   * computed per row plus the resolved package name/components and target
   * label — `@vibeset/web`'s history/deployments lists and its Quick Deploy
   * candidate matching (`lib/adapters/deploy.ts`'s `findQuickDeployCandidate`)
   * both need these without an extra round trip per row.
   */
  list: publicProcedure.query(({ ctx }) => {
    const rows = ctx.db.select().from(deployments).orderBy(desc(deployments.createdAt)).all();
    return rows.map((row) => {
      const pkg = row.packageId ? ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, row.packageId)).get() : undefined;
      const target = row.targetConnectionId
        ? ctx.db.select().from(connections).where(eq(connections.id, row.targetConnectionId)).get()
        : undefined;
      return {
        ...row,
        quickDeployable: isQuickDeployable({
          checkOnly: row.checkOnly,
          status: row.status as 'succeeded',
          completedAt: row.completedAt ?? undefined,
          validationId: row.validationId ?? undefined,
        }),
        packageName: pkg?.name,
        packageComponents: pkg ? (JSON.parse(pkg.componentsJson) as ComponentKey[]) : [],
        targetLabel: target?.label,
      };
    });
  }),

  /** Full detail for one deployment: package, manifest, target, result, timings, logs, per-component results. */
  get: publicProcedure.input(z.object({ deploymentId: z.string() })).query(({ ctx, input }) => {
    const row = ctx.db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).get();
    if (!row) throw new Error(`No deployment with id ${input.deploymentId}.`);

    const pkg = row.packageId ? ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, row.packageId)).get() : undefined;
    const target = row.targetConnectionId
      ? ctx.db.select().from(connections).where(eq(connections.id, row.targetConnectionId)).get()
      : undefined;
    const components = ctx.db.select().from(deploymentComponents).where(eq(deploymentComponents.deploymentId, input.deploymentId)).all();

    return {
      ...row,
      package: pkg,
      components,
      diagnostics: row.diagnosticsJson ? (JSON.parse(row.diagnosticsJson) as DeployDiagnostics) : undefined,
      quickDeployable: isQuickDeployable({
        checkOnly: row.checkOnly,
        status: row.status as 'succeeded',
        completedAt: row.completedAt ?? undefined,
        validationId: row.validationId ?? undefined,
      }),
      packageName: pkg?.name,
      packageComponents: pkg ? (JSON.parse(pkg.componentsJson) as ComponentKey[]) : [],
      targetLabel: target?.label,
    };
  }),

  /**
   * Generates the inverse of a completed deployment (`package/rollback.ts`)
   * and saves it as a normal `deploymentPackages` row (with a manifest) —
   * see `deploy.ts`'s `validate`/`deploy` doc comments for how this package
   * is then actually deployed through the SAME validate/deploy path as any
   * other package. Cheap: pre-deploy state was already captured at deploy
   * time (`capturePreDeployState`), so this only reads already-stored
   * content-addressed blobs, no re-retrieve.
   */
  generateRollback: publicProcedure
    .input(z.object({ deploymentId: z.string(), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const original = ctx.db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).get();
      if (!original) throw new Error(`No deployment with id ${input.deploymentId}.`);
      if (!original.packageId) throw new Error(`Deployment ${input.deploymentId} has no associated package to invert.`);
      if (original.checkOnly) throw new Error(`Deployment ${input.deploymentId} was a validation only (checkOnly) — nothing was actually deployed, so there is nothing to roll back.`);

      const originalPackage = ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, original.packageId)).get();
      if (!originalPackage) throw new Error(`No deployment package with id ${original.packageId}.`);

      const componentRows = ctx.db
        .select()
        .from(deploymentComponents)
        .where(eq(deploymentComponents.deploymentId, input.deploymentId))
        .all();
      const preDeployState = preDeployStateFromRows(componentRows);

      const originalComponents = JSON.parse(originalPackage.componentsJson) as ComponentKey[];
      const originalDestructive = originalPackage.destructiveComponentsJson
        ? (JSON.parse(originalPackage.destructiveComponentsJson) as ComponentKey[])
        : [];

      const plan = await generateRollbackPlan(
        { components: originalComponents, destructiveComponents: originalDestructive, preDeployState },
        ctx.snapshotStore,
      );

      const packageId = nanoid();
      const now = new Date().toISOString();
      const name = input.name ?? `Rollback of ${originalPackage.name}`;

      const manifest = toManifest(
        { id: packageId, name, components: plan.components, destructiveComponents: plan.destructiveComponents, createdAt: now },
        { destructiveMode: (originalPackage.destructiveMode as 'pre' | 'post' | null) ?? 'post', createdAt: now },
      );
      const manifestPath = await saveManifest(manifest, vibesetHome());

      ctx.db
        .insert(deploymentPackages)
        .values({
          id: packageId,
          name,
          componentsJson: JSON.stringify(plan.components),
          destructiveComponentsJson: JSON.stringify(plan.destructiveComponents),
          manifestPath,
          destructiveMode: originalPackage.destructiveMode,
          rollbackOfDeploymentId: input.deploymentId,
          createdAt: now,
        })
        .run();

      return {
        packageId,
        manifestPath,
        // The YAML text itself, not just the path it was saved to —
        // `@vibeset/web`'s rollback dialog previews this directly and has
        // no filesystem access of its own (it's a browser). Cheap: `manifest`
        // is already in memory, this just serializes it a second time
        // instead of round-tripping through disk.
        manifestYaml: manifestToYaml(manifest),
        components: plan.components,
        destructiveComponents: plan.destructiveComponents,
        skipped: plan.skipped,
      };
    }),
});
