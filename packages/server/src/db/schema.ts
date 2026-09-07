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
  /**
   * Phase 2 Workstream B addition (the merge API): JSON-serialized
   * `Record<componentKeyString, { left: SideCoverage; right: SideCoverage }>`
   * — the EXACT `MergeProfileCoverage`-shaped retrieve-pairing coverage
   * `ComparisonEngine.diffAll` computed for every Profile/PermissionSet in
   * this comparison (see `@vibeset/core`'s `ComparisonResult.profileCoverage`
   * doc comment for why this must be captured verbatim rather than
   * recomputed later). Only present for comparisons that included at least
   * one Profile/PermissionSet result; the merge router
   * (`trpc/routers/merge.ts`) reads this to drive `mergeComponent` without
   * ever guessing or defaulting to full coverage. Null for comparisons run
   * before this column existed — the merge router's `requireMergeProfileCoverage`
   * call then fails loudly (not silently) for a Profile/PermissionSet on
   * those older comparisons, same as it always has for any caller that
   * omits coverage.
   */
  profileCoverageJson: text('profile_coverage_json'),
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
    /** Mirrors `DiffResult.binary` — `true` for binary-bodied types (StaticResource, Document). Previously computed by `ComparisonEngine` but silently dropped before persistence; now stored so the API/UI can tell a binary "changed" from a text/XML one. */
    binary: integer('binary', { mode: 'boolean' }),
    /**
     * Mirrors `DiffResult.unreadable` verbatim (JSON `{left?, right?}` or
     * null) — see that field's doc comment in `@vibeset/core`'s
     * `types/diff.ts` for the hazard this exists to surface: without this
     * column, a binary result's `status: 'changed'`-because-unreadable was
     * indistinguishable from an ordinary confirmed binary change once it
     * left `ComparisonEngine` and hit the database, silently losing the
     * "we could not actually compare this" signal the fix was for.
     */
    unreadableJson: text('unreadable_json'),
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

/**
 * Component dependency graph edges (Phase 3 Workstream B). Populated by
 * `dependencies.sync` from two provenance lanes — see
 * `@vibeset/core`'s `dependencies/types.ts` `DependencyEdge` doc comment
 * for the full reasoning:
 *
 *  - Tooling API `MetadataComponentDependency` rows (`source: 'tooling-api'`,
 *    `authoritative: true`) — Salesforce's own, org-computed graph.
 *  - VibeSet-derived edges backfilling known Tooling API coverage gaps
 *    (`source: 'supplemented:profile-grant' | 'supplemented:permission-set-grant'
 *    | 'supplemented:layout-field'`, `authoritative: false`), parsed from
 *    Profile/PermissionSet grants and Layout field placements VibeSet
 *    already retrieves.
 *
 * `authoritative` is denormalized from `source` for cheap filtering/
 * display. CRITICAL: it is a marker of PROVENANCE for a PRESENT edge, never
 * proof of absence — a component with zero matching rows here has "no
 * recorded edge", not "confirmed no dependency" (see `KNOWN_COVERAGE_GAPS`
 * in `@vibeset/core`, disclosed per-run in `dependencySyncRuns` below).
 * Every sync fully replaces one connection's rows (delete-then-insert in one
 * transaction — see `trpc/routers/dependencies.ts`) rather than upserting,
 * since a stale edge (a reference that no longer exists) is exactly as
 * dangerous as a missing one for the delete-safety use case this table
 * exists for.
 */
export const dependencyEdges = sqliteTable(
  'dependency_edges',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').references(() => connections.id),
    /** Which `dependency_sync_runs` row produced this edge — lets a row be traced back to its run's disclosed coverage gaps and namespace-filter settings. */
    syncRunId: text('sync_run_id'),
    fromType: text('from_type').notNull(),
    fromFullName: text('from_full_name').notNull(),
    toType: text('to_type').notNull(),
    toFullName: text('to_full_name').notNull(),
    source: text('source').notNull(), // 'tooling-api' | 'supplemented:profile-grant' | 'supplemented:permission-set-grant' | 'supplemented:layout-field'
    authoritative: integer('authoritative', { mode: 'boolean' }).notNull(),
    fromNamespace: text('from_namespace'),
    toNamespace: text('to_namespace'),
    ...timestamps,
  },
  (t) => [
    index('dependency_edges_from_idx').on(t.connectionId, t.fromType, t.fromFullName),
    // Reverse lookup ("what depends on this") is the higher-stakes,
    // delete-safety direction (see the Phase 3 task brief) and deserves its
    // own index rather than a table scan — the forward index above can't
    // serve a `WHERE toType = ? AND toFullName = ?` query.
    index('dependency_edges_to_idx').on(t.connectionId, t.toType, t.toFullName),
  ],
);

/**
 * One run of `dependencies.sync` for a connection. Exists so "how fresh is
 * this graph, and what did it not cover" is answerable without recomputing
 * from `dependency_edges` — `knownGapsJson` is `KNOWN_COVERAGE_GAPS`
 * (`@vibeset/core`) captured verbatim at sync time, so a caller reading an
 * old run still sees exactly what gaps applied then, even if the list is
 * later extended.
 */
export const dependencySyncRuns = sqliteTable('dependency_sync_runs', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').references(() => connections.id),
  status: text('status').notNull().default('running'), // 'running' | 'succeeded' | 'failed'
  jobId: text('job_id'),
  orgEdgeCount: integer('org_edge_count').default(0),
  supplementedEdgeCount: integer('supplemented_edge_count').default(0),
  managedPackageEdgeCount: integer('managed_package_edge_count').default(0),
  /** Namespace-filter settings this run applied, JSON `{excludeNamespaces?, excludeManagedPackages?}` — see `filterEdgesByNamespace` in `@vibeset/core`. */
  filterJson: text('filter_json'),
  knownGapsJson: text('known_gaps_json'),
  errorsJson: text('errors_json'),
  ...timestamps,
  completedAt: text('completed_at'),
});

/** Freeform key/value app settings. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at'),
});
