import { z } from 'zod';
import { publicProcedure, router } from './trpc.js';
import { connectionsRouter } from './routers/connections.js';
import { inventoryRouter } from './routers/inventory.js';
import { comparisonsRouter } from './routers/comparisons.js';
import { deployRouter } from './routers/deploy.js';
import { historyRouter } from './routers/history.js';

const jobsRouter = router({
  enqueueDemo: publicProcedure
    .input(
      z.object({
        steps: z.number().int().min(1).max(100).default(10),
        stepDelayMs: z.number().int().min(10).max(5000).default(300),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const jobId = await ctx.jobRunner.enqueue({ type: 'demo', payload: input });
      return { jobId };
    }),

  get: publicProcedure.input(z.object({ jobId: z.string() })).query(({ ctx, input }) => {
    return ctx.jobRunner.getJob(input.jobId) ?? null;
  }),

  list: publicProcedure.query(({ ctx }) => ctx.jobRunner.listJobs()),

  cancel: publicProcedure.input(z.object({ jobId: z.string() })).mutation(({ ctx, input }) => {
    return { canceled: ctx.jobRunner.cancel(input.jobId) };
  }),
});

const systemRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
});

/**
 * `store.stats` — 1a implemented `SnapshotStore.stats()` but left it
 * unexposed (see the Phase 1c task brief). Cache hit rate is directly
 * user-visible value ("how much of this comparison did we skip re-
 * retrieving"), so it gets its own tiny top-level router here rather than
 * living oddly under `connections` or `inventory` (neither of which own
 * the store).
 */
const storeRouter = router({
  stats: publicProcedure.query(({ ctx }) => ctx.snapshotStore.stats()),
});

export const appRouter = router({
  system: systemRouter,
  jobs: jobsRouter,
  store: storeRouter,
  connections: connectionsRouter,
  inventory: inventoryRouter,
  comparisons: comparisonsRouter,
  deploy: deployRouter,
  history: historyRouter,
});

export type AppRouter = typeof appRouter;
