import { eq } from 'drizzle-orm';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { z } from 'zod';
import {
  buildAnalyzerDependencyGraph,
  cleanupSourceTree,
  componentKeyString,
  DEFAULT_ANALYZERS,
  KNOWN_COVERAGE_GAPS,
  OrgSource,
  resolveAnalyzerComponents,
  runAnalyzers,
  type AnalysisContext,
  type ComponentKey,
  type DependencyGraph,
  type DeploymentIntent,
  type Finding,
  type OrgContext,
} from '@vibeset/core';
import { comparisons, connections, deploymentPackages } from '../../db/schema.js';
import { sourceFromConnectionRow } from '../../jobs/shared/source-from-connection.js';
import { DrizzleDependencyGraph } from '../../store/drizzle-dependency-graph.js';
import { publicProcedure, router } from '../trpc.js';

const registry = new RegistryAccess();

const ComponentKeySchema = z.object({
  type: z.string(),
  fullName: z.string(),
  parentFullName: z.string().optional(),
});

const TestLevelSchema = z.enum(['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']);

const IntentSchema = z.object({
  testLevel: TestLevelSchema.optional(),
  runTests: z.array(z.string()).optional(),
  checkOnly: z.boolean().optional(),
});

/**
 * `analyze.run`'s input. TWO ways to name what to analyze, because the
 * task brief is explicit that an analyzer's value peaks BEFORE a
 * deployment package is finalized ("an analyzer can run before a target
 * is even chosen"):
 *
 *  - `packageId` — a saved `deployment_packages` row (the common case once
 *    the wizard has one): `components`/`destructiveComponents` and the
 *    comparison it belongs to are all read off that row, nothing else to
 *    pass.
 *  - `comparisonId` + `components` — an ad hoc set of components from an
 *    in-progress comparison, for a "review before you even build the
 *    package" step. `destructiveComponents` is optional either way (most
 *    comparisons have none).
 *
 * `targetConnectionId` and `intent` are BOTH optional and BOTH sharpen the
 * findings when present (org-type/coverage-aware rules, test-level-aware
 * rules) — omitting either is a completely normal, supported call that
 * still runs every target-independent rule (hardcoded ids, stale API
 * version needs `target.currentApiVersion` though, missing-dependency
 * rules needing `existsInTarget`, ...). See the router doc comment above
 * `run` for exactly what each optional input unlocks.
 */
const RunInputSchema = z.object({
  packageId: z.string().optional(),
  comparisonId: z.string().optional(),
  components: z.array(ComponentKeySchema).optional(),
  destructiveComponents: z.array(ComponentKeySchema).optional(),
  targetConnectionId: z.string().optional(),
  intent: IntentSchema.optional(),
  disabledAnalyzerIds: z.array(z.string()).optional(),
});

export interface AnalyzeRunResult {
  readonly findings: Finding[];
  /** Populated only when `targetConnectionId` was given AND resolved to an `OrgSource` — `undefined` otherwise, never a guessed/default context (see `types/analyzer.ts`'s `OrgContext` contract). */
  readonly target: OrgContext | undefined;
  /** Whether a real (non-`undefined`) `DependencyGraph` was wired into this run — `false` means every dependency/destructive rule that requires one (see each rule's `appliesTo`) was skipped, not that it ran and found nothing. */
  readonly dependencyGraphApplied: boolean;
  /** Disclosed, non-exhaustive gaps in the underlying dependency graph's coverage — surface verbatim next to any "no missing dependency found" result so a user never reads silence as a guarantee. */
  readonly knownCoverageGaps: readonly string[];
  readonly packageComponentCount: number;
  readonly destructiveComponentCount: number;
  /** Requested components that did not resolve to real file content (missing/failed retrieve) — analyzers never saw these, so a finding's absence for one of these keys proves nothing. */
  readonly unresolvedComponents: ComponentKey[];
}

function dedupeKeys(keys: readonly ComponentKey[]): ComponentKey[] {
  const seen = new Set<string>();
  const out: ComponentKey[] = [];
  for (const k of keys) {
    const ks = componentKeyString(k);
    if (seen.has(ks)) continue;
    seen.add(ks);
    out.push(k);
  }
  return out;
}

export const analyzeRouter = router({
  /** Every shipped analyzer's id/title/category/defaultSeverity — for a suppression-list UI (`disabledAnalyzerIds` below) or a "what does VibeSet check for" settings page. Static, needs no db/network access. */
  listAnalyzers: publicProcedure.query(() => {
    return DEFAULT_ANALYZERS.map((a) => ({
      id: a.id,
      title: a.title,
      category: a.category,
      defaultSeverity: a.defaultSeverity,
    }));
  }),

  /**
   * Runs Cassia's 23-rule shipped analyzer set (`DEFAULT_ANALYZERS`) against
   * a real package, with a REAL dependency graph and REAL target-org
   * context wired in — the join this route exists to make reachable (see
   * the Phase 3 task brief: the analyzers previously only ever ran against
   * `FakeDependencyGraph` in tests; the dependency-sync workstream's real
   * `dependency_edges` had nothing consuming it).
   *
   * Pipeline:
   *  1. Resolve `components`/`destructiveComponents` (from `packageId` or
   *     the request body directly) and the comparison they belong to.
   *  2. Materialize `components`' real file content from the comparison's
   *     RIGHT-side connection (`left = target org (current state)`, `right
   *     = desired/source` — the same pairing convention
   *     `trpc/routers/comparisons.ts` documents; the source-of-truth
   *     content for "what's being deployed" is always the right side).
   *  3. If `targetConnectionId` was given: build its `OrgContext` (only
   *     when it's an `OrgSource` — org type/coverage/API version are
   *     meaningless for a git-ref/sfdx-project target) and a synchronous
   *     `DependencyGraph` adapter (`buildAnalyzerDependencyGraph`) over
   *     that connection's persisted `dependency_edges` PLUS its live
   *     inventory (for `existsInTarget`) — see that function's doc comment
   *     in `@vibeset/core` for exactly how "unknown" is preserved across
   *     the seam.
   *  4. `runAnalyzers(DEFAULT_ANALYZERS, ctx, { disabledIds })`, sorted,
   *     returned verbatim alongside the coverage gaps and unresolved keys
   *     a caller needs to interpret an empty result honestly.
   *
   * Read-only throughout: no `deploy`/`validate` call, no write to the
   * target org. Runs in-process (a live `Connection` can't cross a worker-
   * thread boundary — same reasoning as `comparisons`/`deploy`), as a
   * `mutation` rather than a `query` since it performs real org I/O
   * (materialize + Tooling/SOQL queries), not a pure db read.
   */
  // Deliberately no `: Promise<AnalyzeRunResult>` return-type annotation —
  // same reasoning as `comparisons.ts`'s `ZERO_CACHE_STATS`: naming the
  // exported `AnalyzeRunResult` interface here makes tRPC's inferred
  // `AppRouter` type reference it directly, which `@vibeset/web` then
  // cannot name portably (TS4023) without importing `@vibeset/server`
  // types it has no other reason to depend on. The returned object below
  // is still shaped exactly like `AnalyzeRunResult` — that interface
  // documents the shape for this file's readers and for Leonidas — it's
  // just never spelled out as an annotation.
  run: publicProcedure.input(RunInputSchema).mutation(async ({ ctx, input }) => {
    let comparisonId = input.comparisonId;
    let components: ComponentKey[] = (input.components as ComponentKey[] | undefined) ?? [];
    let destructiveComponents: ComponentKey[] = (input.destructiveComponents as ComponentKey[] | undefined) ?? [];

    if (input.packageId) {
      const pkg = ctx.db.select().from(deploymentPackages).where(eq(deploymentPackages.id, input.packageId)).get();
      if (!pkg) throw new Error(`No deployment package with id ${input.packageId}.`);
      comparisonId ??= pkg.comparisonId ?? undefined;
      components = JSON.parse(pkg.componentsJson) as ComponentKey[];
      destructiveComponents = pkg.destructiveComponentsJson
        ? (JSON.parse(pkg.destructiveComponentsJson) as ComponentKey[])
        : [];
    }

    if (!comparisonId) {
      throw new Error(
        'analyze.run requires either "packageId" (of a package already linked to a comparison) or an explicit "comparisonId".',
      );
    }
    if (components.length === 0 && destructiveComponents.length === 0) {
      throw new Error('analyze.run requires at least one component in "components" or "destructiveComponents".');
    }

    const comparisonRow = ctx.db.select().from(comparisons).where(eq(comparisons.id, comparisonId)).get();
    if (!comparisonRow) throw new Error(`No comparison with id ${comparisonId}.`);
    if (!comparisonRow.rightConnectionId) {
      throw new Error(
        `Comparison ${comparisonId} has no right-side connection recorded — cannot resolve component content ` +
          `("right" is the desired/source side per the left/right safety invariant).`,
      );
    }

    const contentConnectionRow = ctx.db
      .select()
      .from(connections)
      .where(eq(connections.id, comparisonRow.rightConnectionId))
      .get();
    if (!contentConnectionRow) throw new Error(`No connection with id ${comparisonRow.rightConnectionId}.`);
    const contentSource = sourceFromConnectionRow(contentConnectionRow);

    const tree = await contentSource.materialize(components);
    let packageComponents: AnalysisContext['packageComponents'] = [];
    let unresolvedComponents: ComponentKey[] = [];
    try {
      const resolved = await resolveAnalyzerComponents(tree, components, registry);
      packageComponents = resolved.components;
      unresolvedComponents = resolved.unresolved;
    } finally {
      await cleanupSourceTree(tree);
    }

    let target: OrgContext | undefined;
    let dependencyGraph: DependencyGraph | undefined;
    if (input.targetConnectionId) {
      const targetRow = ctx.db.select().from(connections).where(eq(connections.id, input.targetConnectionId)).get();
      if (!targetRow) throw new Error(`No connection with id ${input.targetConnectionId}.`);
      const targetSource = sourceFromConnectionRow(targetRow);

      if (targetSource instanceof OrgSource) {
        target = await targetSource.orgContext();
      }

      const edgeSource = new DrizzleDependencyGraph(ctx.db, input.targetConnectionId);
      const scopeKeys = dedupeKeys([...components, ...destructiveComponents]);
      dependencyGraph = await buildAnalyzerDependencyGraph(edgeSource, targetSource, { edgeScopeKeys: scopeKeys });
    }

    const analysisContext: AnalysisContext = {
      packageComponents,
      destructiveComponents: destructiveComponents.length > 0 ? destructiveComponents : undefined,
      target,
      intent: input.intent as DeploymentIntent | undefined,
      dependencyGraph,
    };

    const disabledIds =
      input.disabledAnalyzerIds && input.disabledAnalyzerIds.length > 0 ? new Set(input.disabledAnalyzerIds) : undefined;
    const findings = runAnalyzers(DEFAULT_ANALYZERS, analysisContext, { disabledIds });

    return {
      findings,
      target,
      dependencyGraphApplied: dependencyGraph !== undefined,
      knownCoverageGaps: KNOWN_COVERAGE_GAPS,
      packageComponentCount: packageComponents.length,
      destructiveComponentCount: destructiveComponents.length,
      unresolvedComponents,
    };
  }),
});
