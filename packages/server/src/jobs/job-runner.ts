import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { nanoid } from 'nanoid';
import Piscina from 'piscina';
import { eq } from 'drizzle-orm';
import type { JobProgress, JobStatus, JobType } from '@vibeset/core';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';

type Listener = (progress: JobProgress) => void;

/**
 * An in-process job implementation, run directly on the main thread rather
 * than in a `piscina` worker. Registered per `JobType` via `registerHandler`
 * and checked before falling back to the `piscina` demo pool in `run()`.
 *
 * Why not a worker thread for everything: `piscina` workers are plain,
 * separately-bundled JS files reached by filesystem path (see
 * `resolveWorkerFile` above) — appropriate for CPU-bound work, but Salesforce
 * SDK calls (`inventory`/`materialize`/health checks) are I/O-bound network
 * calls, not CPU-bound. Running them in-process avoids the complexity of
 * shipping `@vibeset/core` + the Salesforce SDKs into a second worker bundle
 * and re-deriving a `Connection` from a bare username inside that worker (no
 * `Connection` object survives being posted across a thread boundary), for
 * no throughput benefit on a single-user local tool. The `piscina` pool
 * remains exactly as-is for `'demo'` and any future genuinely CPU-bound job
 * type.
 */
export type JobHandler = (
  payload: unknown,
  ctx: { readonly signal: AbortSignal; readonly onProgress: (percent: number, message?: string) => void },
) => Promise<unknown>;

/**
 * Resolves the compiled worker script's absolute path. Piscina always spawns
 * a real `worker_threads` thread that goes through plain Node module
 * resolution (never vite-node/tsx's transform pipeline, even when *this*
 * file is being executed unbundled by them), so the worker must exist as
 * plain JS on disk — i.e. the package must be built first, in dev/test too.
 *
 * A naive `new URL('./workers/demo-worker.js', import.meta.url)` breaks
 * because tsdown bundles this file into a single `dist/index.js`, so its
 * `import.meta.url` at runtime is `dist/index.js`, not `dist/jobs/job-runner.js`
 * — the relative offset to the worker differs depending on whether this
 * module is running bundled (prod) or unbundled (test, via vite-node).
 * Instead, find this package's root (the directory containing `src`/`dist`)
 * from this module's own URL and rebuild an absolute path from there, which
 * is stable either way.
 */
function resolveWorkerFile(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const marker = thisFile.includes(`${sep}dist${sep}`) ? `${sep}dist${sep}` : `${sep}src${sep}`;
  const packageRoot = thisFile.slice(0, thisFile.indexOf(marker));
  return `${packageRoot}${sep}dist${sep}jobs${sep}workers${sep}demo-worker.js`;
}

export interface EnqueueOptions {
  readonly type: JobType;
  readonly payload: unknown;
}

/**
 * SQLite-backed job queue + `piscina` worker-thread pool. Progress is
 * relayed from worker threads to subscribers (the WebSocket route) via an
 * in-memory `MessageChannel` per run — the `jobs` table is the durable
 * record (status, timings, error, last-known progress) for history and for
 * reconnecting clients.
 *
 * No Redis/Postgres: this is a local, single-process tool. The queue is as
 * deep as `piscina`'s internal task queue; concurrency is bounded by the
 * pool's thread count.
 */
export class JobRunner {
  private readonly pool: Piscina;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly handlers = new Map<JobType, JobHandler>();

  constructor(private readonly db: Db) {
    this.pool = new Piscina({
      filename: resolveWorkerFile(),
      minThreads: 1,
      maxThreads: 4,
    });
  }

  /** Registers an in-process handler for `type`, checked before the `piscina` demo pool in `run()`. See `JobHandler`'s doc comment for why. */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  subscribe(jobId: string, listener: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  getJob(jobId: string) {
    return this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  }

  listJobs(limit = 50) {
    return this.db.select().from(jobs).orderBy(jobs.createdAt).limit(limit).all();
  }

  cancel(jobId: string): boolean {
    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async enqueue(opts: EnqueueOptions): Promise<string> {
    const jobId = nanoid();
    const now = new Date().toISOString();

    this.db
      .insert(jobs)
      .values({
        id: jobId,
        type: opts.type,
        status: 'queued' satisfies JobStatus,
        payloadJson: JSON.stringify(opts.payload ?? {}),
        progressPercent: 0,
        createdAt: now,
      })
      .run();

    // Fire-and-forget: the caller gets the job id immediately and follows
    // progress over the WS channel / by polling getJob().
    void this.run(jobId, opts);

    return jobId;
  }

  private emit(progress: JobProgress): void {
    const set = this.listeners.get(progress.jobId);
    if (set) for (const listener of set) listener(progress);
  }

  private updateRow(jobId: string, patch: Partial<typeof jobs.$inferInsert>): void {
    this.db.update(jobs).set(patch).where(eq(jobs.id, jobId)).run();
  }

  private async run(jobId: string, opts: EnqueueOptions): Promise<void> {
    const startedAt = new Date().toISOString();
    this.updateRow(jobId, { status: 'running', startedAt });
    this.emit({ jobId, status: 'running', percent: 0, at: startedAt, message: 'Started' });

    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);

    const handler = this.handlers.get(opts.type);

    try {
      const result = handler
        ? await handler(opts.payload, {
            signal: controller.signal,
            onProgress: (percent, message) => {
              const msg: JobProgress = { jobId, status: 'running', percent, message, at: new Date().toISOString() };
              this.updateRow(jobId, { progressPercent: msg.percent, progressMessage: msg.message });
              this.emit(msg);
            },
          })
        : await this.runViaPool(jobId, opts, controller.signal);

      const completedAt = new Date().toISOString();
      this.updateRow(jobId, {
        status: 'succeeded',
        completedAt,
        progressPercent: 100,
        resultJson: JSON.stringify(result),
      });
      this.emit({ jobId, status: 'succeeded', percent: 100, at: completedAt, message: 'Done' });
    } catch (err) {
      const completedAt = new Date().toISOString();
      const isAbort = (err as Error)?.name === 'AbortError';
      const status: JobStatus = isAbort ? 'canceled' : 'failed';
      this.updateRow(jobId, {
        status,
        completedAt,
        error: (err as Error).message,
        errorStack: (err as Error).stack,
      });
      this.emit({
        jobId,
        status,
        percent: 100,
        at: completedAt,
        message: isAbort ? 'Canceled' : (err as Error).message,
      });
    } finally {
      this.abortControllers.delete(jobId);
    }
  }

  /** The original Phase 0 path: runs `'demo'` (or any other type with no registered in-process handler) in the `piscina` worker pool. */
  private async runViaPool(jobId: string, opts: EnqueueOptions, signal: AbortSignal): Promise<unknown> {
    const { port1, port2 } = new MessageChannel();
    port1.on('message', (msg: JobProgress) => {
      this.updateRow(jobId, { progressPercent: msg.percent, progressMessage: msg.message });
      this.emit(msg);
    });
    try {
      const payload = (opts.payload ?? {}) as Record<string, unknown>;
      return await this.pool.run(
        { jobId, steps: payload.steps ?? 10, stepDelayMs: payload.stepDelayMs ?? 300, port: port2 },
        { name: 'default', transferList: [port2], signal },
      );
    } finally {
      port1.close();
    }
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }
}
