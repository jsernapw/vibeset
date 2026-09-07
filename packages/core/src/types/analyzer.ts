import type { ComponentKey } from './metadata-source.js';
import type { TestLevel } from './deployment.js';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface ComponentFile {
  readonly path: string;
  readonly content: string;
}

/**
 * A resolved metadata component as seen by an analyzer: key + materialized
 * file content(s). `path`/`content` are the primary file — the body for
 * ApexClass/ApexTrigger/LWC/Aura, or the sole file for most XML-only types
 * (Layout, Profile, ValidationRule...). `auxFiles` carries any OTHER files
 * real retrieval materializes for this component: an ApexClass/ApexTrigger's
 * `-meta.xml` sidecar (apiVersion, status — see the stale-API-version
 * rules), or an LWC/Aura bundle's remaining members. Modeling this
 * explicitly, rather than assuming one file per component, matters here
 * for the same reason it mattered for the decomposed-CustomObject bug: an
 * analyzer fixture that only ever supplies a `.cls` body and never its
 * `-meta.xml` would make an API-version rule look correct while never
 * actually exercising the data it reads.
 */
export interface Component {
  readonly key: ComponentKey;
  readonly path: string;
  readonly content: string;
  readonly auxFiles?: readonly ComponentFile[];
}

/** Per-component Apex code coverage, as reported by `ApexCodeCoverageAggregate`. */
export interface ApexCoverageEntry {
  readonly percentCovered: number;
  readonly linesCovered: number;
  readonly linesUncovered: number;
}

/**
 * What is known about the deploy TARGET org. Every field is optional
 * because an analyzer can run before a target is even chosen (e.g. a
 * "review this package" step) — analyzers MUST treat a missing field as
 * "unknown", never substitute a default value for it. Populating this is
 * the caller's job (a future `trpc` route querying the org, or a CLI flag
 * pointing at a connection); `core` never reaches out to a network itself.
 */
export interface OrgContext {
  readonly orgId?: string;
  /** Human-readable label for messages (org alias, instance name). */
  readonly label?: string;
  /**
   * Raw `Organization.OrganizationType` (e.g. `'Developer Edition'`,
   * `'Enterprise Edition'`, `'Production'`). Informational only — see
   * `isProductionLikeOrg` below for the field that actually drives rules.
   * The flagship bug this workstream exists to catch is treating
   * `organizationType === 'Production'` as the production signal: that
   * check silently passes on a Developer Edition org, which the Metadata
   * API gates identically to Production.
   */
  readonly organizationType?: string;
  /**
   * `Organization.IsSandbox`. The one authoritative signal for "does the
   * Metadata API enforce the org-wide 75% Apex coverage gate on this
   * org" — every non-sandbox org is gated, Developer Edition included.
   */
  readonly isSandbox?: boolean;
  /** `ApexOrgWideCoverage.PercentCovered` (0-100) at last computation. */
  readonly orgWideCoveragePercent?: number;
  readonly totalApexClassCount?: number;
  readonly totalApexTriggerCount?: number;
  /** Per-class/trigger coverage, keyed by `ApexClass`/`ApexTrigger` `fullName`. */
  readonly apexCoverage?: ReadonlyMap<string, ApexCoverageEntry>;
  /** Org's current effective API version (e.g. `"62.0"`), for the stale-API-version rule. */
  readonly currentApiVersion?: string;
}

/**
 * Whether the Metadata API treats `org` as production for the purpose of
 * the 75% org-wide Apex coverage gate. Returns `undefined` — never a
 * guessed `false` — when `isSandbox` itself hasn't been supplied; callers
 * must propagate "unknown" rather than have it silently become "safe".
 */
export function isProductionLikeOrg(org: Pick<OrgContext, 'isSandbox'>): boolean | undefined {
  if (org.isSandbox === undefined) return undefined;
  return org.isSandbox === false;
}

/** The deployment options chosen so far. May be partial/absent when an analyzer runs ahead of the Deploy step, which is exactly when its findings are most valuable. */
export interface DeploymentIntent {
  readonly testLevel?: TestLevel;
  readonly runTests?: readonly string[];
  readonly checkOnly?: boolean;
}

/**
 * Minimal query surface an analyzer needs from a metadata dependency
 * graph. THIS IS THE SEAM with the parallel Phase 3 dependency-
 * intelligence workstream (`MetadataComponentDependency` via the Tooling
 * API, persisted to a `dependency_edges` table): every dependency-aware
 * rule in this package is written against this interface, never against
 * that table directly. Tests inject a small in-memory implementation
 * (`test/analyzers/fake-dependency-graph.ts`); wiring the real thing later
 * is exactly one adapter class implementing `DependencyGraph` over
 * `dependency_edges`, with zero rule code changing.
 *
 * Every method's "don't know" case returns `undefined`/empty rather than
 * guessing — the same absent-vs-not-retrieved discipline `diff/profiles.ts`
 * established for Profile comparisons applies here: an edge that hasn't
 * been indexed yet is not evidence the reference doesn't exist, and a
 * target-org component that hasn't been indexed is not evidence it's
 * missing. Rules built on this interface must fail closed (report
 * nothing) rather than fail open (report a false hazard) when a method
 * returns the "unknown" case.
 */
export interface DependencyGraph {
  /** Components `from` references (compile-time/config dependencies), if indexed. Empty means "indexed, and it has none" — not "unknown". */
  dependenciesOf(from: ComponentKey): readonly ComponentKey[];
  /** Components that reference `to` — the reverse edge, e.g. "what breaks if I delete this". */
  dependentsOf(to: ComponentKey): readonly ComponentKey[];
  /**
   * Tri-state: does the TARGET org already have this component, independent
   * of whether it's part of the CURRENT deployment package? `undefined`
   * means "not indexed" and rules MUST treat it as "cannot say" — never
   * silently equivalent to `false`.
   */
  existsInTarget(key: ComponentKey): boolean | undefined;
}

export interface Finding {
  readonly analyzerId: string;
  readonly severity: FindingSeverity;
  /** Short, specific headline — e.g. "RunLocalTests will fail ARM DEV's 75% coverage gate", never a generic rule name. */
  readonly title: string;
  /** Why this matters, with the concrete numbers/names that make it credible instead of a template sentence. */
  readonly detail: string;
  /** What to do about it — specific and actionable (name the component, the setting, the alternative test level), never "please review". */
  readonly recommendation: string;
  /** The component this finding is primarily about, when there is one. Absent for package/org-level findings (the coverage gate concerns the whole deployment, not one component). */
  readonly key?: ComponentKey;
  /** Other components implicated — the referencing component and the missing one, or every Layout that still references a field being deleted. */
  readonly relatedKeys?: readonly ComponentKey[];
  readonly path?: string;
  readonly line?: number;
}

/** A proposed edit an autofix can produce; applying it is the caller's responsibility. */
export interface Mutation {
  readonly key: ComponentKey;
  readonly description: string;
  /** New full content for the component, when the fix is a whole-file rewrite. */
  readonly newContent?: string;
  /** Additional components to add to the deployment package (the "add missing dependency" autofix class). */
  readonly addToPackage?: readonly ComponentKey[];
}

/** Everything an analyzer needs to reason about a deployment package. */
export interface AnalysisContext {
  /** Every component in the deployment package being analyzed. */
  readonly packageComponents: readonly Component[];
  /** Components slated for deletion (`destructiveChangesPost.xml`), when analyzing a package that includes a destructive side. */
  readonly destructiveComponents?: readonly ComponentKey[];
  /** What's known about the deploy target, when a target has been chosen. */
  readonly target?: OrgContext;
  /** Deployment options chosen so far (test level, etc.), when known. */
  readonly intent?: DeploymentIntent;
  /** The dependency-graph seam described above. Absent until that data source is wired; dependency-aware rules must apply `appliesTo` accordingly. */
  readonly dependencyGraph?: DependencyGraph;
}

export type AnalyzerCategory =
  'coverage' | 'dependencies' | 'hardcoded-id' | 'permissions' | 'stale' | 'destructive';

/**
 * Plugin interface for "problem analyzers" (Phase 3). `core` ships the
 * interface, a registry, and a runner (see `analyzers/registry.ts`) — the
 * rule set itself is data registered against this interface, and adding a
 * new rule never requires touching the runner. This is the load-bearing
 * differentiator from Gearset's closed analyzer set.
 *
 * Contract:
 * - `id` is stable and namespaced (`"<category>/<rule>"`) — it is a public
 *   identifier once shipped (a CLI `--disable-analyzer` flag or a saved
 *   per-project suppression list keys on it), so renaming one is a
 *   breaking change to treat like any other.
 * - `appliesTo` is a cheap, side-effect-free pre-filter (e.g. "only if the
 *   package contains Apex") that lets the runner skip irrelevant analyzers
 *   without paying for a full `analyze()` call. Omit it only when the
 *   analyzer is cheap enough that the distinction doesn't matter.
 * - `analyze` does the real work and returns every finding for this run —
 *   an analyzer sees the WHOLE package plus org/dependency context, so it
 *   can reason across components (a Layout referencing a field elsewhere
 *   in the same package) as easily as within one.
 * - `autofix` is optional and produces `Mutation`s for a SPECIFIC finding
 *   this analyzer already reported — never invents new findings.
 */
export interface Analyzer {
  readonly id: string;
  readonly title: string;
  readonly category: AnalyzerCategory;
  readonly defaultSeverity: FindingSeverity;
  appliesTo?(ctx: AnalysisContext): boolean;
  analyze(ctx: AnalysisContext): readonly Finding[];
  autofix?(ctx: AnalysisContext, finding: Finding): readonly Mutation[];
}
