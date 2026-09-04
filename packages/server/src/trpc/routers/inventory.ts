import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_INVENTORY_TYPES,
  GitRefSource,
  listAllInventoryTypeNames,
  OrgSource,
  RetrievalPlanner,
  SfdxProjectSource,
  withManagedPackageDefault,
  type MetadataSource,
  type TypeFilter,
} from '@vibeset/core';
import type { JobHandler } from '../../jobs/job-runner.js';
import type { Db } from '../../db/client.js';
import { connections } from '../../db/schema.js';
import { publicProcedure, router } from '../trpc.js';
import { OptionalTypeFilterSchema as TypeFilterSchema } from './shared/type-filter-schema.js';

/** Builds the right `MetadataSource` for a stored `connections` row. */
function sourceFromConnectionRow(row: typeof connections.$inferSelect): MetadataSource {
  switch (row.kind) {
    case 'org': {
      if (!row.username) throw new Error(`Connection ${row.id} is kind "org" but has no username.`);
      return new OrgSource(row.id, row.label, { username: row.username, instanceUrl: row.instanceUrl ?? undefined });
    }
    case 'sfdx-project': {
      if (!row.projectPath) throw new Error(`Connection ${row.id} is kind "sfdx-project" but has no projectPath.`);
      return new SfdxProjectSource(row.id, row.label, row.projectPath);
    }
    case 'git-ref': {
      if (!row.projectPath) throw new Error(`Connection ${row.id} is kind "git-ref" but has no projectPath.`);
      const meta = row.metadataJson ? (JSON.parse(row.metadataJson) as { ref?: string }) : {};
      if (!meta.ref) throw new Error(`Connection ${row.id} is kind "git-ref" but has no ref in metadataJson.`);
      return new GitRefSource(row.id, row.label, row.projectPath, meta.ref);
    }
    default:
      throw new Error(`Unknown connection kind "${row.kind}" for connection ${row.id}.`);
  }
}

export interface InventoryJobPayload {
  readonly connectionId: string;
  readonly filter?: TypeFilter;
}

export interface InventoryJobResult {
  readonly sourceId: string;
  readonly inventoriedCount: number;
  readonly cacheHitCount: number;
  readonly toFetchCount: number;
  readonly chunkCount: number;
  readonly warnings: readonly string[];
}

/**
 * The `'inventory'` job type's in-process handler (see `JobHandler`'s doc
 * comment in `job-runner.ts` for why this runs on the main thread rather
 * than in a `piscina` worker). Registered against the shared `JobRunner`
 * instance in `server.ts`. Runs `RetrievalPlanner.planSource` — not just a
 * raw `source.inventory()` — so a "start inventory" job also demonstrates
 * the cache-aware retrieval plan (hits/misses/chunking) the snapshot store
 * exists to produce, which is the actually useful signal for a user
 * checking "how much would a real retrieve here cost me".
 */
export function createInventoryJobHandler(deps: {
  readonly db: Db;
  readonly snapshotStore: import('@vibeset/core').SnapshotStore;
}): JobHandler {
  return async (payload, { signal, onProgress }) => {
    const { connectionId, filter } = payload as InventoryJobPayload;
    const row = deps.db.select().from(connections).where(eq(connections.id, connectionId)).get();
    if (!row) throw new Error(`No connection with id ${connectionId}.`);

    const source = sourceFromConnectionRow(row);
    const planner = new RetrievalPlanner(deps.snapshotStore);
    const plan = await planner.planSource(source, {
      filter: filter ?? {},
      signal,
      onProgress: (p) => onProgress(p.percent, p.message),
    });

    const result: InventoryJobResult = {
      sourceId: plan.sourceId,
      inventoriedCount: plan.inventoriedCount,
      cacheHitCount: plan.cacheHits.length,
      toFetchCount: plan.toFetch.length,
      chunkCount: plan.chunks.length,
      warnings: plan.warnings,
    };
    return result;
  };
}

export const inventoryRouter = router({
  /**
   * Starts an inventory job for a registered connection through the Phase 0
   * job runner; follow progress over `/ws/jobs/:jobId`. Applies the same
   * `withManagedPackageDefault` policy `comparisons.start` does — an
   * inventory preview should report the same scope a comparison built from
   * the same (unspecified) filter would actually fetch, not a larger one
   * that then shrinks once a comparison actually runs.
   */
  start: publicProcedure
    .input(z.object({ connectionId: z.string(), filter: TypeFilterSchema }))
    .mutation(async ({ ctx, input }) => {
      const jobId = await ctx.jobRunner.enqueue({
        type: 'inventory',
        payload: { connectionId: input.connectionId, filter: withManagedPackageDefault(input.filter ?? {}) } satisfies InventoryJobPayload,
      });
      return { jobId };
    }),

  /**
   * The "available and selectable" half of Phase 2A-b's type expansion
   * (see `sources/registry.ts`'s `DEFAULT_INVENTORY_TYPES` doc comment for
   * the full reasoning): `all` is every metadata type name SDR's
   * `RegistryAccess` can resolve (~418), `default` is the curated ~33-type
   * subset a comparison uses when no explicit `TypeFilter.types` is given.
   * A type-picker UI checks `default` to pre-select the sensible set while
   * still letting a user opt into anything in `all`. No connection/org
   * required — this is pure registry data, not per-org inventory.
   */
  availableTypes: publicProcedure.query(async () => {
    const all = await listAllInventoryTypeNames();
    return { all, default: [...DEFAULT_INVENTORY_TYPES] };
  }),
});
