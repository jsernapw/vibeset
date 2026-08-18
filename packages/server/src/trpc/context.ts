import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import type { SnapshotStore } from '@vibeset/core';
import type { Db } from '../db/client.js';
import type { JobRunner } from '../jobs/job-runner.js';

export interface AppContextDeps {
  readonly db: Db;
  readonly jobRunner: JobRunner;
  readonly snapshotStore: SnapshotStore;
}

/**
 * Deliberately does NOT include the raw Fastify `req`/`res` objects: doing
 * so pulls Fastify's internal types into the inferred `AppRouter` type,
 * which `@vibeset/web` then can't name portably in its own build (TS2742)
 * without adding `fastify` as a direct dependency just for type plumbing.
 * If a procedure needs request data later, extract the specific primitive
 * fields it needs here instead of passing the whole request through.
 */
export interface AppContext {
  readonly db: Db;
  readonly jobRunner: JobRunner;
  readonly snapshotStore: SnapshotStore;
}

export function createContextFactory(deps: AppContextDeps) {
  return function createContext(_opts: CreateFastifyContextOptions): AppContext {
    return { db: deps.db, jobRunner: deps.jobRunner, snapshotStore: deps.snapshotStore };
  };
}
