export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** Job kinds the runner knows about. Extend as new long-running operations are added. */
export type JobType =
  | 'demo'
  | 'inventory'
  | 'retrieve'
  | 'compare'
  | 'deploy'
  | 'validate'
  | 'analyze'
  // Phase 3 Workstream B: populates `dependency_edges` for one org
  // connection — Tooling API `MetadataComponentDependency` paging plus the
  // Profile/PermissionSet/Layout supplement pass (see
  // `@vibeset/core`'s `dependencies/` module). A job (not a plain
  // mutation) because the Tooling API query can page through a large
  // result set on a big org and the supplement pass materializes
  // Profile/PermissionSet/Layout content — both are I/O-bound and worth
  // reporting progress for, same reasoning as 'compare'.
  | 'dependency-sync'
  // Interactive browser OAuth via `sf org login web`. A job rather than a
  // plain mutation because it blocks on a human completing a login in a
  // browser — minutes, not seconds. Held open as an HTTP request it exceeds
  // the dev proxy's patience, and the client then fails to parse the cut-off
  // response ("Unable to transform response from server").
  | 'login-web';

export interface Job<TPayload = unknown> {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly payload: TPayload;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly errorStack?: string;
  readonly result?: unknown;
}

/** A single progress event, streamed to the client over WebSocket. */
export interface JobProgress {
  readonly jobId: string;
  readonly status: JobStatus;
  /** 0-100. */
  readonly percent: number;
  readonly message?: string;
  readonly at: string;
}
