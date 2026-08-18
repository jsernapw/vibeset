import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
};

/** A registered source: an authenticated org, a local SFDX project, or a Git repo/ref. */
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'org' | 'sfdx-project' | 'git-ref'
  label: text('label').notNull(),
  username: text('username'),
  instanceUrl: text('instance_url'),
  alias: text('alias'),
  isSandbox: integer('is_sandbox', { mode: 'boolean' }),
  apiVersion: text('api_version'),
  projectPath: text('project_path'),
  expiresAt: text('expires_at'),
  metadataJson: text('metadata_json'),
  ...timestamps,
  updatedAt: text('updated_at'),
});

/** A comparison run between two connections. */
export const comparisons = sqliteTable('comparisons', {
  id: text('id').primaryKey(),
  name: text('name'),
  leftConnectionId: text('left_connection_id').references(() => connections.id),
  rightConnectionId: text('right_connection_id').references(() => connections.id),
  filterJson: text('filter_json'),
  status: text('status').notNull().default('pending'),
  /** Phase 1c addition: the job runner's id for this comparison's `'compare'` job, so `comparisons.cancel` can find it. Nullable — set right after `jobRunner.enqueue()` returns (the job id isn't known until enqueue time). */
  jobId: text('job_id'),
  /** Phase 1d addition: JSON-serialized `{totalComponents, retrievedComponents, cacheHits, hitRatePercent}` — the DELTA of `SnapshotStore.stats()` observed around this comparison's retrieval (captured before/after in `createCompareJobHandler`), since the store's own `stats()` is a global cumulative counter, not scoped to one comparison. Null until the job completes; null forever for comparisons that failed before reaching that point. */
  cacheStatsJson: text('cache_stats_json'),
  ...timestamps,
  completedAt: text('completed_at'),
});

/**
 * Content-addressed blob store. Primary key is the sha256 of the
 * canonicalized content — the same unchanged component is stored once
 * regardless of how many comparisons reference it.
 */
export const componentSnapshots = sqliteTable('component_snapshots', {
  sha256: text('sha256').primaryKey(),
  type: text('type').notNull(),
  fullName: text('full_name').notNull(),
  parentFullName: text('parent_full_name'),
  content: text('content').notNull(),
  size: integer('size').notNull(),
  firstSeenAt: text('first_seen_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

/**
 * Join-table-shaped cache index: which source, at which observed
 * `lastModifiedDate`, produced a given `sha256` blob for a given component.
 * This is the table `DrizzleSnapshotStore` (`@vibeset/core`'s `SnapshotStore`
 * interface, implemented here) reads for cache lookups keyed on
 * `(sourceId, type, fullName, lastModifiedDate)` — a hit means retrieval
 * can be skipped entirely and the stored `sha256` reused. Many refs can
 * point at the same blob in `componentSnapshots`.
 */
export const componentSnapshotRefs = sqliteTable(
  'component_snapshot_refs',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    orgId: text('org_id'),
    type: text('type').notNull(),
    fullName: text('full_name').notNull(),
    parentFullName: text('parent_full_name'),
    lastModifiedDate: text('last_modified_date').notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => componentSnapshots.sha256),
    capturedAt: text('captured_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    index('component_snapshot_refs_lookup_idx').on(t.sourceId, t.type, t.fullName, t.lastModifiedDate),
  ],
);

/** Per-component diff outcome for a comparison. References snapshots by hash, not by copy. */
export const diffResults = sqliteTable(
  'diff_results',
  {
    id: text('id').primaryKey(),
    comparisonId: text('comparison_id')
      .notNull()
      .references(() => comparisons.id),
    type: text('type').notNull(),
    fullName: text('full_name').notNull(),
    parentFullName: text('parent_full_name'),
    status: text('status').notNull(), // new | changed | deleted | identical
    leftSha256: text('left_sha256').references(() => componentSnapshots.sha256),
    rightSha256: text('right_sha256').references(() => componentSnapshots.sha256),
    entriesJson: text('entries_json'),
    textDiffJson: text('text_diff_json'),
  },
  (t) => [index('diff_results_comparison_idx').on(t.comparisonId)],
);

/** A saved, selected set of components destined for a target org. */
export const deploymentPackages = sqliteTable('deployment_packages', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  comparisonId: text('comparison_id').references(() => comparisons.id),
  componentsJson: text('components_json').notNull(),
  destructiveComponentsJson: text('destructive_components_json'),
  manifestPath: text('manifest_path'),
  /** Phase 1c addition: 'pre' | 'post' — which destructive-changes manifest this package's deletions belong in. Defaults 'post' to match `package/package-xml.ts`'s default. */
  destructiveMode: text('destructive_mode').default('post'),
  /** Phase 1c addition: set by `history.generateRollback` when this package IS the inverse of a prior deployment. When set, `deploy.validate`/`deploy.deploy` source this package's component CONTENT from the content-addressed snapshot store (re-derived from the referenced deployment's pre-deploy state) instead of requiring `sourceConnectionId` — see `trpc/routers/deploy.ts`. */
  rollbackOfDeploymentId: text('rollback_of_deployment_id'),
  ...timestamps,
});

/** One deploy or validate execution of a deployment package. */
export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  packageId: text('package_id').references(() => deploymentPackages.id),
  targetConnectionId: text('target_connection_id').references(() => connections.id),
  status: text('status').notNull().default('queued'),
  checkOnly: integer('check_only', { mode: 'boolean' }).notNull().default(false),
  testLevel: text('test_level'),
  validationId: text('validation_id'),
  numberComponentErrors: integer('number_component_errors').default(0),
  numberComponentsDeployed: integer('number_components_deployed').default(0),
  numberComponentsTotal: integer('number_components_total').default(0),
  resultJson: text('result_json'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  /** Phase 1c addition: the job runner's id for this deployment's `'deploy'`/`'validate'` job, so `deploy.cancel`/`deploy.status` can find it. */
  jobId: text('job_id'),
  /** Phase 1c addition: `DeploymentResult.targetOrgId` — the org id actually deployed to (from the target connection's health check / identity), kept alongside `targetConnectionId` since a connection's underlying org id is otherwise a second lookup away. */
  targetOrgId: text('target_org_id'),
  /** Phase 1c addition: `DeployDiagnostics` (individual Apex test failures, coverage warnings, component failure detail) — richer than `resultJson`'s typed `DeploymentResult.testResults` has room for; see `deploy/normalize.ts`. */
  diagnosticsJson: text('diagnostics_json'),
  /** Phase 1c addition: set when this deployment IS a rollback, pointing at the deployment it rolls back. Plain text (no FK constraint) to avoid a self-referencing-table migration wrinkle for what is an optional, purely informational link. */
  rollbackOfDeploymentId: text('rollback_of_deployment_id'),
  ...timestamps,
});

/** Per-component result rows for a deployment, for the live progress table. */
export const deploymentComponents = sqliteTable(
  'deployment_components',
  {
    id: text('id').primaryKey(),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id),
    type: text('type').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').notNull().default('pending'),
    changed: integer('changed', { mode: 'boolean' }).default(false),
    errorMessage: text('error_message'),
    lineNumber: integer('line_number'),
    columnNumber: integer('column_number'),
    /** Phase 1c addition: whether this component existed in the TARGET org immediately before this deploy ran, captured by `capturePreDeployState` — the input `package/rollback.ts`'s inverse-package generation needs. `null` when pre-deploy state wasn't captured for this row (e.g. rows from before this column existed). */
    beforeExisted: integer('before_existed', { mode: 'boolean' }),
    /** Phase 1c addition: content-addressed sha256 of this component's pre-deploy content in the `component_snapshots` table, when `beforeExisted` is true. */
    beforeSha256: text('before_sha256'),
  },
  (t) => [index('deployment_components_deployment_idx').on(t.deploymentId)],
);

/** Findings from problem analyzers (Phase 3), attached to a comparison and/or deployment. */
export const analyzerFindings = sqliteTable('analyzer_findings', {
  id: text('id').primaryKey(),
  analyzerId: text('analyzer_id').notNull(),
  severity: text('severity').notNull(),
  type: text('type').notNull(),
  fullName: text('full_name').notNull(),
  message: text('message').notNull(),
  path: text('path'),
  line: integer('line'),
  comparisonId: text('comparison_id').references(() => comparisons.id),
  deploymentId: text('deployment_id').references(() => deployments.id),
  ...timestamps,
});

/** Job queue + history. The job runner polls/claims rows here; live progress rides the WS channel. */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('queued'),
  payloadJson: text('payload_json'),
  resultJson: text('result_json'),
  error: text('error'),
  errorStack: text('error_stack'),
  progressPercent: integer('progress_percent').default(0),
  progressMessage: text('progress_message'),
  ...timestamps,
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

/** Component dependency graph edges (Tooling API `MetadataComponentDependency` + static analysis, Phase 3). */
export const dependencyEdges = sqliteTable(
  'dependency_edges',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').references(() => connections.id),
    fromType: text('from_type').notNull(),
    fromFullName: text('from_full_name').notNull(),
    toType: text('to_type').notNull(),
    toFullName: text('to_full_name').notNull(),
    source: text('source').notNull(), // 'tooling-api' | 'static'
    ...timestamps,
  },
  (t) => [index('dependency_edges_from_idx').on(t.fromType, t.fromFullName)],
);

/** Freeform key/value app settings. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at'),
});
