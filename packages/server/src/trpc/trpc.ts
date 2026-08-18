import { initTRPC } from '@trpc/server';
import type { AppContext } from './context.js';

/**
 * The single `initTRPC` instance, split into its own module so both
 * `router.ts` (which composes `appRouter`) and `routers/*.ts` (individual
 * feature routers) can import `router`/`publicProcedure` from here without
 * a circular import — `routers/*` importing back from `router.ts` while
 * `router.ts` imports the feature routers would deadlock on the shared `t`
 * instance's module evaluation order.
 */
const t = initTRPC.context<AppContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
