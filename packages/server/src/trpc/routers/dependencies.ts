import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { z } from 'zod';
import {
  cleanupSourceTree,
  componentKeyString,
  extractLayoutFieldEdges,
  extractProfileLikeEdges,
  filterEdgesByNamespace,
  GraphDependencyReferenceChecker,
  KNOWN_COVERAGE_GAPS,
  OrgSource,
  PROFILE_PAIRED_TYPES,
  queryOrgDependencyEdges,
  resolveComponentContents,
  transitiveImpact,
  type ComponentKey,
  type DependencyEdge,
  type MetadataSource,
  type ToolingQueryClient,
} from '@vibeset/core';
import type { JobHandler } from '../../jobs/job-runner.js';
import type { Db } from '../../db/client.js';
import { connections, dependencySyncRuns } from '../../db/schema.js';
import { sourceFromConnectionRow } from '../../jobs/shared/source-from-connection.js';
import { DrizzleDependencyGraph, replaceDependencyEdges } from '../../store/drizzle-dependency-graph.js';
import { publicProcedure, router } from '../trpc.js';

const registry = new RegistryAccess();

/** Metadata types this module extracts `provenance: 'supplemented'` edges FROM — see `@vibeset/core`'s `dependencies/supplement.ts`. */
const SUPPLEMENT_TYPES = ['Profile', 'PermissionSet', 'Layout'] as const;

/**
 * Types materialized ALONGSIDE `SUPPLEMENT_TYPES` purely so Salesforce's
 * Metadata API actually populates the Profile/PermissionSet sections this
 * module reads — REAL bug discovered and confirmed against ARM DEV/RCA DEV
 * during Phase 3 Workstream B verification, matching the exact hazard the
 * plan's safety-invariant table already documents for comparisons ("A
 * Profile retrieved alone is nearly empty. Assuming full coverage generates
 * deployments that silently strip permissions."): the Metadata API only
 * populates a `<classAccesses>`/`<pageAccesses>`/`<fieldPermissions>`/
 * `<objectPermissions>`/`<recordTypeVisibilities>`/`<tabVisibilities>`
 * ENTRY for a referenced component that is ALSO present in the SAME
 * retrieve — this is exactly `retrieval/chunking.ts`'s `PROFILE_PAIRED_TYPES`
 * pairing rule (already relied on by real comparisons), reused here rather
 * than re-derived, since it's the authoritative, already-tested list.
 * Before this was wired in, a live sync against ARM DEV extracted 18,959
 * `Profile -> Layout` edges (Layout WAS in the retrieve) but ZERO
 * `Profile -> ApexClass`/`-> ApexPage`/`-> CustomField`/... edges at all —
 * not because those grants don't exist, but because ApexClass/ApexPage/
 * CustomObject/CustomTab/RecordType were never in the same retrieve batch.
 *
 * `CustomObject` is deliberately EXCLUDED from this list even though
 * `PROFILE_PAIRED_TYPES` includes it: ARM DEV alone has 629 CustomObjects,
 * and including it here would mean retrieving every object's full field/
 * record-type/list-view decomposition just to backfill Profile grants —
 * turning a bounded, cheap supplementary pass into something close to a
 * full-org retrieve. The trade-off (documented, not silent): `fieldPermissions`/
 * `objectPermissions`/`recordTypeVisibilities` supplemented edges are
 * consequently INCOMPLETE for this pass — see `KNOWN_COVERAGE_GAPS` in
 * `@vibeset/core`, where this exact limitation is disclosed.
 */
const SUPPLEMENT_PAIRING_TYPES = [...PROFILE_PAIRED_TYPES].filter((t) => t !== 'CustomObject');

/**
 * The minimal surface `syncDependenciesForSource` actually needs: ordinary
 * `MetadataSource` (`inventory`/`materialize`, for the supplement pass)
 * plus `toolingClient()` (Tooling API access, org-only). `OrgSource`
 * satisfies this structurally without any change to its own type — this
 * interface exists purely so tests can pass a plain fake object instead of
 * constructing a real `OrgSource` (which would require live `sf` CLI auth
 * the moment `getConnection()` runs), the same reasoning
 * `test/sources/org-source.test.ts` uses `OrgSourceDeps` injection for.
 */
export interface DependencySource extends MetadataSource {
  toolingClient(): Promise<ToolingQueryClient>;
}

export interface DependencySyncPayload {
  readonly connectionId: string;
  readonly syncRunId: string;
  readonly excludeNamespaces?: readonly string[];
  readonly excludeManagedPackages?: boolean;
  /** Skip the Profile/PermissionSet/Layout backfill pass (org-only sync — faster, but re-introduces the coverage gaps that pass exists to close). Defaults to including it. */
  readonly includeSupplemented?: boolean;
}

const ComponentKeySchema = z.object({ type: z.string(), fullName: z.string() });

/**
 * Reads every Profile/PermissionSet/Layout in scope and extracts
 * `provenance: 'supplemented'` edges from their XML — the backfill for the
 * coverage gaps `@vibeset/core`'s `dependencies/supplement.ts` targets.
 * Reuses `OrgSource.inventory()`/`materialize()` (the exact same retrieve
 * path a comparison already uses) rather than any new fetch mechanism, and
 * `resolveComponentContents` (the same content-resolution `merge.resolve`
 * uses) to turn the materialized files back into raw XML strings.
 *
 * Materializes `SUPPLEMENT_PAIRING_TYPES` in the SAME call as
 * `SUPPLEMENT_TYPES` — see that constant's doc comment for why this is
 * required, not optional, for the Profile/PermissionSet grants to come
 * back non-empty. Content is only ever RESOLVED and EXTRACTED from
 * `SUPPLEMENT_TYPES`; the pairing types exist purely to make the org
 * populate those sections, never to be extracted from themselves here
 * (their own dependency edges are what `MetadataComponentDependency`
 * already covers).
 */
async function collectSupplementedEdges(
  source: MetadataSource,
  filter: { readonly excludeNamespaces?: readonly string[]; readonly excludeManagedPackages?: boolean },
  onProgress: (percent: number, message?: string) => void,
): Promise<DependencyEdge[]> {
  const inventory = await source.inventory({
    types: [...SUPPLEMENT_TYPES, ...SUPPLEMENT_PAIRING_TYPES],
    excludeNamespaces: filter.excludeNamespaces as string[] | undefined,
    excludeManagedPackages: filter.excludeManagedPackages,
  });
  const allKeys = inventory.entries.map((e) => e.key);
  const targetKeys = allKeys.filter((k) => (SUPPLEMENT_TYPES as readonly string[]).includes(k.type));
  if (targetKeys.length === 0) return [];

  onProgress(
    60,
    `Retrieving ${allKeys.length} components (${targetKeys.length} Profile/PermissionSet/Layout + ${allKeys.length - targetKeys.length} paired reference types) for supplemental edges…`,
  );
  const tree = await source.materialize(allKeys);
  try {
    const contents = await resolveComponentContents(tree, targetKeys, registry);
    onProgress(85, 'Parsing grants and layout field placements…');

    const edges: DependencyEdge[] = [];
    for (const key of targetKeys) {
      const xml = contents.get(componentKeyString(key));
      if (!xml) continue; // missing/failed retrieve — treated as absent, same convention as diff/merge.
      if (key.type === 'Profile' || key.type === 'PermissionSet') {
        edges.push(...extractProfileLikeEdges(key.type, key.fullName, xml));
      } else if (key.type === 'Layout') {
        edges.push(...extractLayoutFieldEdges(key.fullName, xml));
      }
    }
    return edges;
  } finally {
    await cleanupSourceTree(tree);
  }
}

function countManagedPackageInvolved(edges: readonly DependencyEdge[]): number {
  return edges.filter((e) => e.fromNamespace || e.toNamespace).length;
}

/**
 * The `'dependency-sync'` job handler: queries the Tooling API's
 * `MetadataComponentDependency` for one org connection, applies namespace
 * filtering, backfills the Profile/PermissionSet/Layout gaps (unless
 * opted out), and replaces that connection's stored graph in one
 * transaction (`replaceDependencyEdges` — see its doc comment for why
 * delete-then-insert rather than upsert). Tooling API access is org-only
 * (`MetadataComponentDependency` doesn't exist for `sfdx-project`/`git-ref`
 * sources), so this refuses anything but an `'org'` connection up front.
 */
export interface SyncDependenciesOptions {
  readonly excludeNamespaces?: readonly string[];
  readonly excludeManagedPackages?: boolean;
  readonly includeSupplemented?: boolean;
  readonly onProgress?: (percent: number, message?: string) => void;
}

export interface SyncDependenciesResult {
  readonly orgEdgeCount: number;
  readonly supplementedEdgeCount: number;
  readonly managedPackageEdgeCount: number;
  readonly totalEdgeCount: number;
}

/**
 * The actual sync logic, factored out of the job handler below so it's
 * directly unit-testable against an `OrgSource` built with injected fakes
 * (`OrgSourceDeps.getConnection`/`retrieveAndConvert` — the exact same
 * pattern `test/sources/org-source.test.ts` already uses), the same way
 * `org-source.ts` itself factors `convertWithIsolation` out of the class
 * for testability. Persists directly (`replaceDependencyEdges` +
 * `dependencySyncRuns` status), rather than returning edges for a caller
 * to persist, so the "delete-then-insert is one transaction" invariant
 * lives in exactly one place regardless of caller.
 */
export async function syncDependenciesForSource(
  db: Db,
  connectionId: string,
  syncRunId: string,
  source: DependencySource,
  options: SyncDependenciesOptions = {},
): Promise<SyncDependenciesResult> {
  const { excludeNamespaces, excludeManagedPackages, includeSupplemented, onProgress = () => {} } = options;

  try {
    onProgress(5, 'Querying Tooling API MetadataComponentDependency…');
    const client = await source.toolingClient();
    const rawOrgEdges = await queryOrgDependencyEdges(client, {
      onPage: (n, total) =>
        onProgress(
          Math.min(50, 5 + Math.floor((n / (total && total > 0 ? total : Math.max(n, 1))) * 45)),
          `Fetched ${n}${total ? `/${total}` : ''} dependency rows`,
        ),
    });
    const orgEdges = filterEdgesByNamespace(rawOrgEdges, { excludeNamespaces, excludeManagedPackages });

    let supplementedEdges: DependencyEdge[] = [];
    if (includeSupplemented !== false) {
      supplementedEdges = await collectSupplementedEdges(source, { excludeNamespaces, excludeManagedPackages }, onProgress);
    }

    const allEdges = [...orgEdges, ...supplementedEdges];
    onProgress(95, `Persisting ${allEdges.length} dependency edges…`);
    replaceDependencyEdges(db, connectionId, syncRunId, allEdges);

    const managedPackageEdgeCount = countManagedPackageInvolved(allEdges);
    db.update(dependencySyncRuns)
      .set({
        status: 'succeeded',
        orgEdgeCount: orgEdges.length,
        supplementedEdgeCount: supplementedEdges.length,
        managedPackageEdgeCount,
        completedAt: new Date().toISOString(),
      })
      .where(eq(dependencySyncRuns.id, syncRunId))
      .run();

    onProgress(
      100,
      `Synced ${allEdges.length} dependency edges (${orgEdges.length} org-authoritative, ${supplementedEdges.length} supplemented).`,
    );

    return { orgEdgeCount: orgEdges.length, supplementedEdgeCount: supplementedEdges.length, managedPackageEdgeCount, totalEdgeCount: allEdges.length };
  } catch (err) {
    db.update(dependencySyncRuns)
      .set({ status: 'failed', errorsJson: JSON.stringify([(err as Error).message]), completedAt: new Date().toISOString() })
      .where(eq(dependencySyncRuns.id, syncRunId))
      .run();
    throw err;
  }
}

export function createDependencySyncJobHandler(deps: { readonly db: Db }): JobHandler {
  return async (payload, { onProgress }) => {
    const { connectionId, syncRunId, excludeNamespaces, excludeManagedPackages, includeSupplemented } =
      payload as DependencySyncPayload;

    const row = deps.db.select().from(connections).where(eq(connections.id, connectionId)).get();
    if (!row) throw new Error(`No connection with id ${connectionId}.`);
    if (row.kind !== 'org') {
      throw new Error(
        `dependencies.sync only supports 'org' connections — Tooling API's MetadataComponentDependency is ` +
          `queryable only against a live org, and connection ${connectionId} is kind "${row.kind}".`,
      );
    }
    const source = sourceFromConnectionRow(row);
    if (!(source instanceof OrgSource)) {
      throw new Error(`Connection ${connectionId} is kind "org" but did not produce an OrgSource — this is a bug.`);
    }

    const result = await syncDependenciesForSource(deps.db, connectionId, syncRunId, source, {
      excludeNamespaces,
      excludeManagedPackages,
      includeSupplemented,
      onProgress,
    });
    return { syncRunId, ...result };
  };
}

export const dependenciesRouter = router({
  /**
   * Starts a dependency graph sync as a cancellable job; follow progress
   * over `/ws/jobs/:jobId`, same convention as `comparisons.start`. Creates
   * the `dependency_sync_runs` row up front (status `'running'`) so
   * `dependencies.syncRuns`/`lastSync` can show an in-progress sync
   * immediately, mirroring `comparisons.start`'s `comparisons` row.
   */
  sync: publicProcedure
    .input(
      z.object({
        connectionId: z.string(),
        excludeNamespaces: z.array(z.string()).optional(),
        excludeManagedPackages: z.boolean().optional(),
        includeSupplemented: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const syncRunId = nanoid();
      const now = new Date().toISOString();

      ctx.db
        .insert(dependencySyncRuns)
        .values({
          id: syncRunId,
          connectionId: input.connectionId,
          status: 'running',
          filterJson: JSON.stringify({
            excludeNamespaces: input.excludeNamespaces,
            excludeManagedPackages: input.excludeManagedPackages,
          }),
          knownGapsJson: JSON.stringify(KNOWN_COVERAGE_GAPS),
          createdAt: now,
        })
        .run();

      const jobId = await ctx.jobRunner.enqueue({
        type: 'dependency-sync',
        payload: {
          connectionId: input.connectionId,
          syncRunId,
          excludeNamespaces: input.excludeNamespaces,
          excludeManagedPackages: input.excludeManagedPackages,
          includeSupplemented: input.includeSupplemented,
        } satisfies DependencySyncPayload,
      });

      ctx.db.update(dependencySyncRuns).set({ jobId }).where(eq(dependencySyncRuns.id, syncRunId)).run();

      return { syncRunId, jobId };
    }),

  /** Every sync run for a connection, newest first — for a "graph last refreshed at X" indicator and the disclosed coverage-gap text. */
  syncRuns: publicProcedure.input(z.object({ connectionId: z.string(), limit: z.number().int().min(1).max(100).default(20) })).query(({ ctx, input }) => {
    return ctx.db
      .select()
      .from(dependencySyncRuns)
      .where(eq(dependencySyncRuns.connectionId, input.connectionId))
      .orderBy(desc(dependencySyncRuns.createdAt))
      .limit(input.limit)
      .all()
      .map((row) => ({
        ...row,
        knownGaps: row.knownGapsJson ? (JSON.parse(row.knownGapsJson) as string[]) : [],
        filter: row.filterJson ? (JSON.parse(row.filterJson) as { excludeNamespaces?: string[]; excludeManagedPackages?: boolean }) : undefined,
        errors: row.errorsJson ? (JSON.parse(row.errorsJson) as string[]) : undefined,
      }));
  }),

  /** Direct (one-hop) forward edges — "what does this depend on" (build a complete deployment package). */
  forward: publicProcedure
    .input(z.object({ connectionId: z.string(), key: ComponentKeySchema }))
    .query(async ({ ctx, input }) => {
      const graph = new DrizzleDependencyGraph(ctx.db, input.connectionId);
      return graph.forward(input.key);
    }),

  /** Direct (one-hop) reverse edges — "what depends on this", the higher-stakes delete-safety direction. */
  reverse: publicProcedure
    .input(z.object({ connectionId: z.string(), key: ComponentKeySchema }))
    .query(async ({ ctx, input }) => {
      const graph = new DrizzleDependencyGraph(ctx.db, input.connectionId);
      return graph.reverse(input.key);
    }),

  /**
   * Transitive impact analysis: given a set of components, what else is
   * implicated, within `maxDepth` hops. `direction: 'forward'` answers
   * "what would a deployment of these components also need"; `'reverse'`
   * answers "what would break if these components were deleted" — see
   * `@vibeset/core`'s `transitiveImpact` doc comment for the depth-bound
   * reasoning (a real graph can be cyclic; this never expands forever).
   *
   * REMEMBER (surfaced to the UI, not just this comment): a component with
   * NO impact rows here has "no recorded edge", not "confirmed safe to
   * delete" — see `KNOWN_COVERAGE_GAPS`. `dependencies.syncRuns` carries
   * the disclosed gap text for whichever sync produced the graph this
   * query reads.
   */
  impact: publicProcedure
    .input(
      z.object({
        connectionId: z.string(),
        seeds: z.array(ComponentKeySchema).min(1),
        direction: z.enum(['forward', 'reverse']),
        maxDepth: z.number().int().min(1).max(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const graph = new DrizzleDependencyGraph(ctx.db, input.connectionId);
      const nodes = await transitiveImpact(graph, input.seeds as ComponentKey[], input.direction, { maxDepth: input.maxDepth });
      return { nodes, knownCoverageGaps: KNOWN_COVERAGE_GAPS };
    }),

  /**
   * The tRPC face of the "does X reference Y?" seam
   * (`@vibeset/core`'s `DependencyReferenceChecker`) — exposed directly so
   * a caller (UI or, eventually, Cassia's analyzers over their own
   * transport) can ask the question ad hoc without building a
   * `DrizzleDependencyGraph` itself. See `ReferenceAnswer`'s doc comment:
   * `certainty: 'no-recorded-edge'` is NOT proof of absence.
   */
  references: publicProcedure
    .input(
      z.object({
        connectionId: z.string(),
        from: ComponentKeySchema,
        to: ComponentKeySchema,
        maxDepth: z.number().int().min(1).max(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const graph = new DrizzleDependencyGraph(ctx.db, input.connectionId);
      const checker = new GraphDependencyReferenceChecker(graph);
      return checker.references(input.from, input.to, { maxDepth: input.maxDepth });
    }),
});
