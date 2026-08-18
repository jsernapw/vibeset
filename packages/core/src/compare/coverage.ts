import type { ComponentKey, MetadataSourceKind } from '../types/metadata-source.js';
import { PROFILE_PAIRED_TYPES } from '../retrieval/chunking.js';
import type { SourceRetrievalPlan } from '../retrieval/planner.js';
import type { SideCoverage } from '../diff/profiles.js';
import { componentKeyString } from '../util/component-key.js';

/**
 * Precomputed, per-side context for answering "what SideCoverage should
 * THIS Profile/PermissionSet comparison use", built once per side of a
 * comparison and then consulted per-component (see `coverageForProfileLike`
 * below) — this is the FIRST real caller of `SideCoverage`/
 * `ProfileDiffContext` (item 2(a) of the Phase 1c brief); everything before
 * this was fixtures opting into `'full'` explicitly.
 *
 * Two source kinds, two different (both safe) answers:
 *
 * - `sfdx-project` / `git-ref`: these materialize the complete file for
 *   every component, every time — there is no Metadata API retrieve-pairing
 *   limitation for local sources. `'full'` coverage is accurate here, not
 *   just convenient.
 *
 * - `org`: a Profile/PermissionSet retrieved from Salesforce only contains
 *   entries for components ALSO present in that exact retrieve request.
 *   `RetrievalPlanner`'s chunking (`retrieval/chunking.ts`) already
 *   guarantees that whenever a Profile/PermissionSet is fetched fresh
 *   (present in `plan.toFetch`), it is forced into the same chunk as every
 *   OTHER `toFetch` component of a `PROFILE_PAIRED_TYPES` type — so that
 *   exact set is precisely what the live retrieve co-fetched it with, and
 *   is exactly reconstructible here without any new bookkeeping.
 *
 *   If the Profile/PermissionSet itself was a CACHE HIT this run (its
 *   `lastModifiedDate` is unchanged, so its stored canonical content came
 *   from some EARLIER retrieve whose pairing context we have no record of),
 *   coverage is deliberately EMPTY rather than guessed — this must be
 *   decided per-component (a side can have some Profiles fetched fresh and
 *   others cache-hit in the same run), which is why this is a function of
 *   the specific key, not a single static value per side. Per
 *   `profiles.ts`'s own documented safe-failure-mode philosophy, empty
 *   coverage makes every entry-absence on that side ambiguous (→ reported
 *   `'identical'`, never a spurious deletion) — the safe direction to fail
 *   in, even though it means a cache-hit Profile's entry-level changes can
 *   be under-reported until it's next fetched fresh.
 */
export interface SideCoverageContext {
  readonly sourceKind: MetadataSourceKind;
  /** `componentKeyString` for every component this side actually fetched fresh this run (i.e. `plan.toFetch`). */
  readonly toFetchKeys: ReadonlySet<string>;
  /** `${type}:${fullName}` refs for every `toFetch` component of a `PROFILE_PAIRED_TYPES` type — exactly what chunking.ts guarantees was co-retrieved with any Profile/PermissionSet also in `toFetch`. */
  readonly pairedRetrievedRefs: ReadonlySet<string>;
}

export function buildSideCoverageContext(sourceKind: MetadataSourceKind, plan: SourceRetrievalPlan): SideCoverageContext {
  const toFetchKeys = new Set<string>();
  const pairedRetrievedRefs = new Set<string>();
  for (const key of plan.toFetch) {
    toFetchKeys.add(componentKeyString(key));
    if (PROFILE_PAIRED_TYPES.has(key.type)) pairedRetrievedRefs.add(`${key.type}:${key.fullName}`);
  }
  return { sourceKind, toFetchKeys, pairedRetrievedRefs };
}

/** Resolves the `SideCoverage` to use when diffing one specific Profile/PermissionSet `key` on this side. See the module doc above for the safety reasoning. */
export function coverageForProfileLike(ctx: SideCoverageContext, key: ComponentKey): SideCoverage {
  if (ctx.sourceKind !== 'org') return { mode: 'full' };
  const wasFetchedFreshThisRun = ctx.toFetchKeys.has(componentKeyString(key));
  if (!wasFetchedFreshThisRun) {
    // Cache hit (or, degenerately, not present in this side's inventory at
    // all — diffComponent won't even reach entry-level dispatch in that
    // case). No record of this content's original pairing context: fail safe.
    return { mode: 'scoped', retrievedComponents: new Set() };
  }
  return { mode: 'scoped', retrievedComponents: ctx.pairedRetrievedRefs };
}
