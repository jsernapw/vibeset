import { and, desc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ComparisonEngine, withManagedPackageDefault, type DiffEntry, type TextDiffHunk, type TypeFilter } from '@vibeset/core';
import type { JobHandler } from '../../jobs/job-runner.js';
import type { Db } from '../../db/client.js';
import type { SnapshotStore } from '@vibeset/core';
import { comparisons, connections, diffResults } from '../../db/schema.js';
import { sourceFromConnectionRow } from '../../jobs/shared/source-from-connection.js';
import { publicProcedure, router } from '../trpc.js';
import { OptionalTypeFilterSchema as TypeFilterSchema } from './shared/type-filter-schema.js';

export interface CompareJobPayload {
  readonly comparisonId: string;
  readonly leftConnectionId: string;
  readonly rightConnectionId: string;
  readonly filter?: TypeFilter;
}

/** Per-comparison cache stats — see `comparisons.cacheStatsJson`'s doc comment for why this is a delta, not `SnapshotStore.stats()` verbatim. */
export interface ComparisonCacheStats {
  readonly totalComponents: number;
  readonly retrievedComponents: number;
  readonly cacheHits: number;
  readonly hitRatePercent: number;
}

// Deliberately no `: ComparisonCacheStats` annotation — see the cast in
// `comparisons.get` below for why this must stay an anonymous object type.
const ZERO_CACHE_STATS = { totalComponents: 0, retrievedComponents: 0, cacheHits: 0, hitRatePercent: 0 };

/**
 * The `'compare'` job type's in-process handler — same in-process pattern
 * (and same reasoning: `MetadataSource`s hold live, non-transferable
 * `Connection`s) as `inventory.ts`'s `createInventoryJobHandler`. Wraps
 * `ComparisonEngine.run()` (the actual orchestration logic, framework-free,
 * lives in `@vibeset/core`) and persists the result into `comparisons`/
 * `diff_results`.
 */
export function createCompareJobHandler(deps: { readonly db: Db; readonly snapshotStore: SnapshotStore }): JobHandler {
  return async (payload, { signal, onProgress }) => {
    const { comparisonId, leftConnectionId, rightConnectionId, filter } = payload as CompareJobPayload;

    const leftRow = deps.db.select().from(connections).where(eq(connections.id, leftConnectionId)).get();
    if (!leftRow) throw new Error(`No connection with id ${leftConnectionId}.`);
    const rightRow = deps.db.select().from(connections).where(eq(connections.id, rightConnectionId)).get();
    if (!rightRow) throw new Error(`No connection with id ${rightConnectionId}.`);

    const left = sourceFromConnectionRow(leftRow);
    const right = sourceFromConnectionRow(rightRow);

    deps.db.update(comparisons).set({ status: 'running' }).where(eq(comparisons.id, comparisonId)).run();

    // Captured around the actual retrieval work so the delta reflects THIS
    // comparison's hit rate, not the process's lifetime total — `stats()`
    // itself is a global cumulative counter (see `SnapshotStore`'s doc
    // comment), so per-comparison numbers only exist as a before/after diff.
    const statsBefore = await deps.snapshotStore.stats();

    try {
      const engine = new ComparisonEngine(deps.snapshotStore);
      const result = await engine.run(left, right, {
        comparisonId,
        filter: filter ?? {},
        signal,
        onProgress: (p) => onProgress(p.percent, p.message),
      });

      const statsAfter = await deps.snapshotStore.stats();
      const retrievedComponents = statsAfter.misses - statsBefore.misses;
      const cacheHits = statsAfter.hits - statsBefore.hits;
      const totalComponents = retrievedComponents + cacheHits;
      const cacheStats: ComparisonCacheStats = {
        totalComponents,
        retrievedComponents,
        cacheHits,
        hitRatePercent: totalComponents > 0 ? Math.round((cacheHits / totalComponents) * 1000) / 10 : 0,
      };

      const rows = result.results.map((r) => ({
        id: nanoid(),
        comparisonId,
        type: r.key.type,
        fullName: r.key.fullName,
        parentFullName: r.key.parentFullName,
        status: r.status,
        leftSha256: r.leftSha256,
        rightSha256: r.rightSha256,
        entriesJson: r.entries ? JSON.stringify(r.entries) : null,
        textDiffJson: r.textDiff ? JSON.stringify(r.textDiff) : null,
        binary: r.binary ?? null,
        unreadableJson: r.unreadable ? JSON.stringify(r.unreadable) : null,
      }));

      if (rows.length > 0) {
        deps.db.transaction((tx) => {
          for (const row of rows) tx.insert(diffResults).values(row).run();
        });
      }

      deps.db
        .update(comparisons)
        .set({
          status: 'completed',
          completedAt: new Date().toISOString(),
          cacheStatsJson: JSON.stringify(cacheStats),
          // See `ComparisonResult.profileCoverage`'s doc comment in
          // `@vibeset/core`: captured verbatim from the SAME diff run that
          // just produced `rows` above, so a later merge of one of these
          // components (`trpc/routers/merge.ts`) reuses the EXACT
          // retrieve-pairing coverage the diff used rather than recomputing
          // it from a possibly-since-changed org. Omitted entirely (column
          // left untouched, not overwritten with null) when this comparison
          // had no Profile/PermissionSet at all.
          ...(result.profileCoverage ? { profileCoverageJson: JSON.stringify(result.profileCoverage) } : {}),
        })
        .where(eq(comparisons.id, comparisonId))
        .run();

      return { comparisonId, summary: result.summary, resultCount: result.results.length };
    } catch (err) {
      // `AbortError` means `comparisons.cancel` fired (job-runner.ts aborts
      // the signal on cancel) — record that distinctly from a genuine
      // failure, or a canceled run reads as a broken one in `comparisons.list`/
      // `comparisons.get` history.
      const status = (err as Error)?.name === 'AbortError' ? 'canceled' : 'failed';
      deps.db.update(comparisons).set({ status }).where(eq(comparisons.id, comparisonId)).run();
      throw err;
    }
  };
}

const DiffStatusSchema = z.enum(['new', 'changed', 'deleted', 'identical']);

/**
 * Deliberately has NO explicit return-type annotation (relies on
 * inference): a NAMED type here — even module-private, unexported —
 * breaks `@vibeset/web`'s `tsc --noEmit` (TS4023 — "has or is using name
 * ... but cannot be named") the moment it flows into `comparisons.results`'
 * inferred return type, since `AppRouter`'s inferred type must be fully
 * nameable from `@vibeset/server`'s public entry point and a private
 * interface can never satisfy that from outside this module. An inferred
 * ANONYMOUS object type has no such problem — it prints structurally
 * in-place instead of needing a name. Same reasoning `trpc/context.ts`
 * already documents for why `AppContext` excludes the raw Fastify req/res.
 */
function toResultRow(row: typeof diffResults.$inferSelect) {
  return {
    type: row.type,
    fullName: row.fullName,
    parentFullName: row.parentFullName,
    status: row.status as 'new' | 'changed' | 'deleted' | 'identical',
    leftSha256: row.leftSha256,
    rightSha256: row.rightSha256,
    entries: row.entriesJson ? (JSON.parse(row.entriesJson) as DiffEntry[]) : undefined,
    textDiff: row.textDiffJson ? (JSON.parse(row.textDiffJson) as TextDiffHunk[]) : undefined,
    binary: row.binary ?? undefined,
    // See `DiffResult.unreadable`'s doc comment in `@vibeset/core`: MUST
    // survive to here so the UI can render "could not compare" instead of
    // trusting `status` at face value for a binary result.
    unreadable: row.unreadableJson ? (JSON.parse(row.unreadableJson) as { left?: boolean; right?: boolean }) : undefined,
  };
}

export const comparisonsRouter = router({
  /** Starts a comparison as a cancellable job; follow progress over `/ws/jobs/:jobId`. `left`/`right` follow the convention documented in `@vibeset/core`'s `package/selection.ts`: present `left = target org (current state)` and `right = desired/source state` if the comparison will feed a deployment package. */
  start: publicProcedure
    .input(
      z.object({
        leftConnectionId: z.string(),
        rightConnectionId: z.string(),
        name: z.string().optional(),
        filter: TypeFilterSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const comparisonId = nanoid();
      const now = new Date().toISOString();
      // Applies the product default explicitly, at the one boundary a
      // `TypeFilter` is actually constructed for a real comparison — see
      // `withManagedPackageDefault`'s doc comment in `@vibeset/core`.
      // Managed-package components are excluded unless the caller (the
      // wizard, a saved filter set, a direct API call) explicitly set
      // `excludeManagedPackages: false`. The EFFECTIVE filter (default
      // applied) is what gets persisted to `filterJson` and handed to the
      // job, so a comparison's stored record always shows what was
      // actually compared — never a silent default the UI/API consumer
      // can't see.
      const effectiveFilter = withManagedPackageDefault(input.filter ?? {});

      ctx.db
        .insert(comparisons)
        .values({
          id: comparisonId,
          name: input.name,
          leftConnectionId: input.leftConnectionId,
          rightConnectionId: input.rightConnectionId,
          filterJson: JSON.stringify(effectiveFilter),
          status: 'pending',
          createdAt: now,
        })
        .run();

      const jobId = await ctx.jobRunner.enqueue({
        type: 'compare',
        payload: {
          comparisonId,
          leftConnectionId: input.leftConnectionId,
          rightConnectionId: input.rightConnectionId,
          filter: effectiveFilter,
        } satisfies CompareJobPayload,
      });

      ctx.db.update(comparisons).set({ jobId }).where(eq(comparisons.id, comparisonId)).run();

      return { comparisonId, jobId };
    }),

  /** Comparison row + aggregate status counts (cheap — a `GROUP BY`, not a full result fetch) + resolved left/right connection labels + this comparison's cache-hit stats. */
  get: publicProcedure.input(z.object({ comparisonId: z.string() })).query(({ ctx, input }) => {
    const row = ctx.db.select().from(comparisons).where(eq(comparisons.id, input.comparisonId)).get();
    if (!row) throw new Error(`No comparison with id ${input.comparisonId}.`);

    const counts = ctx.db
      .select({ status: diffResults.status, count: sql<number>`count(*)` })
      .from(diffResults)
      .where(eq(diffResults.comparisonId, input.comparisonId))
      .groupBy(diffResults.status)
      .all();

    const summary: Record<string, number> = { new: 0, changed: 0, deleted: 0, identical: 0 };
    for (const c of counts) summary[c.status] = c.count;

    const leftConn = row.leftConnectionId
      ? ctx.db.select().from(connections).where(eq(connections.id, row.leftConnectionId)).get()
      : undefined;
    const rightConn = row.rightConnectionId
      ? ctx.db.select().from(connections).where(eq(connections.id, row.rightConnectionId)).get()
      : undefined;

    // Deliberately cast to an ANONYMOUS object type here, not the named
    // `ComparisonCacheStats` interface — see `toResultRow`'s doc comment
    // just above for why a named type flowing into a query's inferred
    // return value breaks `@vibeset/web`'s `tsc --noEmit` with TS4023.
    const cacheStats = row.cacheStatsJson
      ? (JSON.parse(row.cacheStatsJson) as {
          totalComponents: number;
          retrievedComponents: number;
          cacheHits: number;
          hitRatePercent: number;
        })
      : ZERO_CACHE_STATS;

    return {
      ...row,
      summary,
      leftLabel: leftConn?.label ?? 'source',
      rightLabel: rightConn?.label ?? 'target',
      cacheStats,
    };
  }),

  list: publicProcedure.query(({ ctx }) => ctx.db.select().from(comparisons).orderBy(desc(comparisons.createdAt)).all()),

  cancel: publicProcedure.input(z.object({ comparisonId: z.string() })).mutation(({ ctx, input }) => {
    const row = ctx.db.select().from(comparisons).where(eq(comparisons.id, input.comparisonId)).get();
    if (!row?.jobId) return { canceled: false };
    return { canceled: ctx.jobRunner.cancel(row.jobId) };
  }),

  /** Paginated, filterable diff results — the virtualized-tree data source. Supports `status`/`type` filters and `limit`/`offset` since a comparison can produce 50k+ rows. */
  results: publicProcedure
    .input(
      z.object({
        comparisonId: z.string(),
        status: DiffStatusSchema.optional(),
        type: z.string().optional(),
        limit: z.number().int().min(1).max(5000).default(500),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(({ ctx, input }) => {
      const conditions = [eq(diffResults.comparisonId, input.comparisonId)];
      if (input.status) conditions.push(eq(diffResults.status, input.status));
      if (input.type) conditions.push(eq(diffResults.type, input.type));

      const rows = ctx.db
        .select()
        .from(diffResults)
        .where(and(...conditions))
        .limit(input.limit)
        .offset(input.offset)
        .all();

      return rows.map(toResultRow);
    }),

  /**
   * Real left/right canonical content for one component's diff panel,
   * resolved from the content-addressed snapshot store via the
   * `diff_results` row's `leftSha256`/`rightSha256`. Added so
   * `@vibeset/web` can retire `generateMockApexSource` (a fabrication
   * fallback still called by `components/diff/DiffViewer.tsx` for every
   * text-diff type — see `lib/mock/comparison-mock.ts`'s doc comment in
   * `@vibeset/web`) in favor of the ACTUAL Apex/LWC/Aura/VF body content
   * that was retrieved and diffed. `undefined` for a side means that side
   * has no snapshot for this component (e.g. `status: 'new'` has no left
   * content, `status: 'deleted'` has no right content).
   */
  componentContent: publicProcedure
    .input(z.object({ comparisonId: z.string(), type: z.string(), fullName: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = ctx.db
        .select()
        .from(diffResults)
        .where(
          and(
            eq(diffResults.comparisonId, input.comparisonId),
            eq(diffResults.type, input.type),
            eq(diffResults.fullName, input.fullName),
          ),
        )
        .get();
      if (!row) throw new Error(`No diff result for ${input.type} ${input.fullName} in comparison ${input.comparisonId}.`);

      const [leftBlob, rightBlob] = await Promise.all([
        row.leftSha256 ? ctx.snapshotStore.getBlob(row.leftSha256) : undefined,
        row.rightSha256 ? ctx.snapshotStore.getBlob(row.rightSha256) : undefined,
      ]);

      return { leftContent: leftBlob?.content, rightContent: rightBlob?.content };
    }),
});
