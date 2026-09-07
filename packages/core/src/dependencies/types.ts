import type { ComponentKey } from '../types/metadata-source.js';

/**
 * One directed dependency edge: `from` references/depends on `to`.
 *
 * PROVENANCE IS PART OF THE DATA MODEL, NOT AN AFTERTHOUGHT — this is the
 * single most important design decision in this module (see the task
 * brief: "a caller cannot mistake 'no edge recorded' for 'definitely no
 * dependency'").
 *
 *  - `'org'`: came directly from the Tooling API's `MetadataComponentDependency`
 *    object — Salesforce's OWN, org-computed answer for this pair. Treat
 *    this as authoritative for "yes, a dependency exists". It must NEVER be
 *    treated as authoritative for the negative case ("no edge of this kind
 *    exists therefore there is no dependency") — see `KNOWN_COVERAGE_GAPS`
 *    below for why: the API's coverage is good but demonstrably not total
 *    (e.g. certain Flow/Process Builder references, some formula-field
 *    cross-references, and generally anything Salesforce hasn't wired into
 *    its own dependency indexer yet).
 *  - `'supplemented'`: VibeSet derived this edge itself by parsing metadata
 *    XML VibeSet already has locally (Profile/PermissionSet grants,
 *    Layout field placements) specifically to backfill known
 *    `MetadataComponentDependency` gaps. Still a real, confirmed reference
 *    (the grant/placement genuinely names the target) — just not the org's
 *    own graph. Kept in a visibly distinct lane (`supplementKind`) so a
 *    caller can tell "Salesforce says so" from "VibeSet inferred this from
 *    a Profile" without guessing from the edge shape.
 *
 * There is deliberately no third provenance for "confirmed absence" — this
 * module has no way to produce one. A caller asking "does X reference Y"
 * and getting back no edge has learned "no RECORDED edge", never "no
 * dependency". See `ReferenceAnswer` below, which encodes this at the type
 * level rather than leaving it as a comment convention.
 */
export interface DependencyEdge {
  readonly fromType: string;
  readonly fromFullName: string;
  readonly toType: string;
  readonly toFullName: string;
  readonly provenance: 'org' | 'supplemented';
  /** Only present for `provenance: 'supplemented'` — which local heuristic produced this edge, for UI/debug transparency. */
  readonly supplementKind?: 'profile-grant' | 'permission-set-grant' | 'layout-field-reference';
  /**
   * Managed-package namespace of each endpoint, when known. For `'org'`
   * edges this is the Tooling API's own `MetadataComponentNamespace`/
   * `RefMetadataComponentNamespace` (authoritative — `''`/`null` both mean
   * "confirmed no namespace", normalized to `undefined` here, matching
   * `sources/type-filter.ts`'s convention). For `'supplemented'` edges this
   * is derived the same heuristic way `extractNamespace` in
   * `sources/type-filter.ts` does, since the source metadata XML carries no
   * namespace field of its own.
   */
  readonly fromNamespace?: string;
  readonly toNamespace?: string;
}

/** Converts a `DependencyEdge` endpoint into a plain `ComponentKey` for lookups elsewhere in `core`. */
export function edgeFromKey(edge: DependencyEdge): ComponentKey {
  return { type: edge.fromType, fullName: edge.fromFullName };
}
export function edgeToKey(edge: DependencyEdge): ComponentKey {
  return { type: edge.toType, fullName: edge.toFullName };
}

/**
 * Documented, known gaps in Tooling API `MetadataComponentDependency`
 * coverage, observed in Salesforce's own release notes and independently
 * confirmed against real orgs during this workstream (see the PR
 * description for the specific ARM DEV/RCA DEV spot checks). This list is
 * data, not a code comment, so it can be surfaced verbatim to a UI or a
 * caller deciding how much to trust an "no edge found" result — it is
 * attached to every sync run (`dependencySyncRuns.knownGapsJson` in
 * `@vibeset/server`) rather than living only here as a comment nobody
 * downstream ever sees.
 *
 * Not exhaustive — Salesforce doesn't publish a complete list either — but
 * every entry here is a gap this workstream specifically checked for and
 * confirmed, which is why `dependencies/supplement.ts` exists to backfill
 * the two gaps (Profile/PermissionSet grants, Layout field placement) that
 * are both common AND cheaply recoverable from metadata VibeSet already
 * parses.
 */
export const KNOWN_COVERAGE_GAPS: readonly string[] = [
  'Profile and PermissionSet class/page/tab grants (classAccesses, '
    + 'pageAccesses, tabVisibilities) are not represented as edges by the '
    + "Tooling API at all — VibeSet backfills these via dependencies/supplement.ts "
    + "(provenance: 'supplemented', supplementKind 'profile-grant' or "
    + "'permission-set-grant'). Confirmed absent in both RCA DEV and ARM DEV: "
    + "0 Profile/PermissionSet rows of any kind appeared in MetadataComponentDependency.",
  'Profile and PermissionSet field-level security / object permissions / '
    + 'record-type visibility (fieldPermissions, objectPermissions, '
    + 'recordTypeVisibilities) are backfilled ONLY when the referenced '
    + 'CustomObject/CustomField/RecordType happens to also be retrieved in the '
    + 'same pass as the Profile/PermissionSet — the Metadata API only populates '
    + "these sections for components present in the SAME retrieve (Salesforce's "
    + "own behavior, not a VibeSet limitation; see retrieval/chunking.ts's "
    + "PROFILE_PAIRED_TYPES pairing rule, which real comparisons already rely on). "
    + "dependencies.sync deliberately excludes CustomObject from its own pairing "
    + '(SUPPLEMENT_PAIRING_TYPES in @vibeset/server) because a real org can have '
    + 'hundreds of objects (629 in ARM DEV) and pulling every one just to backfill '
    + 'grants would turn a bounded supplementary pass into a near-full-org retrieve '
    + '— so these three grant kinds are CURRENTLY NOT backfilled by dependencies.sync, '
    + 'a disclosed, deliberate scope limitation, not an oversight.',
  'Layout field placements ARE partially represented as edges by the Tooling '
    + 'API — confirmed in both real orgs (89-100 Layout -> CustomField/WebLink '
    + 'edges appeared as provenance: "org") — but that coverage is materially '
    + 'incomplete: the same orgs\' Layout XML actually names far more fields than '
    + 'the Tooling API records (6,000+ additional Layout -> CustomField edges '
    + 'recovered by VibeSet\'s own Layout-XML parsing per org). VibeSet backfills '
    + "the difference via dependencies/supplement.ts (provenance: 'supplemented', "
    + "supplementKind: 'layout-field-reference') — always prefer the supplemented "
    + 'edges as the more complete picture for Layout, even though a same-pair '
    + "'org' edge may also exist.",
  'Declarative automation built on Flow (Process Builder-authored flows, '
    + 'record-triggered flows referencing other flows/subflows via dynamic '
    + 'element configuration) is inconsistently represented — some subflow '
    + 'references appear, others do not, depending on how the flow was built.',
  'Formula fields and validation rules that reference other fields via '
    + 'cross-object formula syntax are not always fully represented, '
    + 'particularly for references several relationship-hops away.',
  'Merge fields inside email templates, Visualforce markup expressions, and '
    + 'Lightning Web Component/Aura JavaScript (as opposed to their declared '
    + 'component-to-component bundle dependencies) are not indexed at all — '
    + 'only the bundle-level dependency (e.g. an LWC depending on an Apex '
    + 'controller class it explicitly imports) is captured, not references '
    + 'embedded in markup or script text.',
  'A component with zero rows on either side of MetadataComponentDependency '
    + 'may mean the org has never (re)computed dependencies for it since it '
    + 'was created/modified — Salesforce recomputes this table asynchronously '
    + 'after metadata changes, not synchronously on save.',
] as const;

/** One-hop lookup surface a dependency source must provide — the minimal shape `transitiveImpact` and the reference-checker below need, independent of how edges are actually stored (SQLite in `@vibeset/server`, in-memory for tests/`core`-only callers). */
export interface DependencyGraphSource {
  /** Direct edges where `key` is the FROM side — "what does this depend on". */
  forward(key: ComponentKey): Promise<DependencyEdge[]>;
  /** Direct edges where `key` is the TO side — "what depends on this" (the higher-stakes, delete-safety direction). */
  reverse(key: ComponentKey): Promise<DependencyEdge[]>;
}

/**
 * The "does X reference Y?" seam — Phase 3 Workstream B (dependency
 * intelligence, this module) and Workstream (Cassia's missing-dependency
 * analyzers) converge here. An analyzer that needs to know "if I deploy/
 * remove component A, does component B still get what it needs" injects a
 * `DependencyReferenceChecker` rather than building or querying a
 * competing graph of its own.
 *
 * THE RETURN TYPE IS THE WHOLE POINT: there is no boolean `false` case.
 * `'no-recorded-edge'` is returned whenever no path was found within
 * `maxDepth` — it must never be read as "confirmed: A does not reference
 * B". See `DependencyEdge`'s doc comment and `KNOWN_COVERAGE_GAPS`: the
 * underlying graph's coverage is real but partial, and collapsing that
 * distinction into a boolean is exactly the mistake that makes a
 * delete-safety check dangerous.
 */
export interface DependencyReferenceChecker {
  references(from: ComponentKey, to: ComponentKey, opts?: { readonly maxDepth?: number }): Promise<ReferenceAnswer>;
}

export type ReferenceAnswer =
  | { readonly certainty: 'confirmed'; readonly path: readonly DependencyEdge[] }
  | { readonly certainty: 'no-recorded-edge' };
