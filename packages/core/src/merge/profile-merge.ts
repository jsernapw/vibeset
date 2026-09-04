import type { MergeEntry, MergeInput, MergeResult, MergeSummary } from '../types/merge.js';
import type { ComponentKey } from '../types/metadata-source.js';
import {
  ALWAYS_DIFFED_SCALAR_FIELDS,
  asArray,
  isCovered,
  isPlainObject,
  parseProfileLikeRoot,
  PERMISSION_COLLECTIONS,
  type ProfileLikeType,
  type SideCoverage,
} from '../diff/profiles.js';
import { unwrapCdata } from '../diff/natural-keys.js';
import {
  resolveThreeWay,
  resolveThreeWayCoverageAware,
  resolveTwoWay,
  resolveTwoWayCoverageAware,
} from './resolve.js';

/**
 * Coverage for a Profile/PermissionSet merge. `left`/`right` are REQUIRED —
 * deliberately no default, mirroring `ProfileDiffContext` in
 * `diff/profiles.ts` (see that file's header for the full hazard writeup:
 * a Profile retrieved alone is nearly empty, and assuming full coverage
 * produces deployments that silently strip permissions). `base` is optional
 * and defaults to `{ mode: 'full' }` — a three-way merge base always comes
 * from a `GitRefSource` (a git-tracked SFDX source file) or a full-org
 * retrieve, never a scope-limited comparison, so treating it as complete by
 * default is safe here in a way it is NOT safe for left/right.
 */
export interface MergeProfileCoverage {
  readonly base?: SideCoverage;
  readonly left: SideCoverage;
  readonly right: SideCoverage;
}

const FULL: SideCoverage = { mode: 'full' };

/**
 * The runtime half of the "no default" safety guarantee for merge coverage,
 * mirroring `diff/dispatch.ts`'s `requireProfileContext`. Omitting coverage
 * is not allowed to silently degrade to full-coverage assumptions — that is
 * exactly the bug class this whole file exists to prevent.
 */
export function requireMergeProfileCoverage(
  key: ComponentKey,
  coverage: MergeProfileCoverage | undefined,
): MergeProfileCoverage {
  if (!coverage) {
    throw new Error(
      `mergeComponent: merging ${key.type} "${key.fullName}" requires an explicit MergeProfileCoverage — ` +
        `omitting it is not allowed. A Profile/PermissionSet retrieved from an org only contains entries for ` +
        `components that were ALSO in the same retrieve package, so assuming full coverage by default would ` +
        `silently treat an unretrieved permission as deleted, and a deployment built from that merge would ` +
        `strip real user permissions with no warning. Pass { left, right } coverage computed from the actual ` +
        `set of components co-retrieved on each side (see retrieval/chunking.ts); pass { mode: 'full' } for a ` +
        `side only when it is genuinely a complete file (a local SFDX project file, a full-org retrieve, or a ` +
        `hand-written fixture).`,
    );
  }
  return coverage;
}

/**
 * Entry-level merge for Profile/PermissionSet, built directly on
 * `diff/profiles.ts`'s own `PERMISSION_COLLECTIONS` table and
 * `isCovered`/`deepEqual` — the SAME coverage rule the differ uses, reused
 * rather than re-derived, so merge and diff can never disagree about what
 * an ambiguous absence means. See `resolve.ts` for the two-way/three-way
 * resolution rules this stacks the coverage check on top of.
 */
export function mergeProfileLike(
  key: ComponentKey,
  input: MergeInput,
  coverage: MergeProfileCoverage,
): MergeResult {
  const type = key.type as ProfileLikeType;
  const leftRoot = parseProfileLikeRoot(type, input.left);
  const rightRoot = parseProfileLikeRoot(type, input.right);
  const baseRoot = input.mode === 'three-way' ? parseProfileLikeRoot(type, input.base) : {};
  const baseCoverage = coverage.base ?? FULL;

  const entries: MergeEntry[] = [];

  for (const field of ALWAYS_DIFFED_SCALAR_FIELDS[type]) {
    const l = unwrapCdata(leftRoot[field]);
    const r = unwrapCdata(rightRoot[field]);
    if (input.mode === 'two-way') {
      const { status, resolved } = resolveTwoWay(l, r);
      entries.push({ path: field, key: field, status, left: l, right: r, resolved });
    } else {
      const b = unwrapCdata(baseRoot[field]);
      const { status, resolved } = resolveThreeWay(b, l, r);
      entries.push({ path: field, key: field, status, base: b, left: l, right: r, resolved });
    }
  }

  for (const spec of PERMISSION_COLLECTIONS) {
    const leftByKey = indexByIdentity(leftRoot[spec.tag], spec.identityField);
    const rightByKey = indexByIdentity(rightRoot[spec.tag], spec.identityField);
    const baseByKey: Map<string, Record<string, unknown>> =
      input.mode === 'three-way'
        ? indexByIdentity(baseRoot[spec.tag], spec.identityField)
        : new Map();

    const allEntryKeys = new Set([...leftByKey.keys(), ...rightByKey.keys(), ...baseByKey.keys()]);
    for (const entryKey of [...allEntryKeys].sort()) {
      const path = `${spec.tag}.${entryKey}`;
      const l = leftByKey.get(entryKey);
      const r = rightByKey.get(entryKey);
      const ref = `${spec.refType}:${entryKey}`;
      const alwaysComplete = spec.alwaysComplete === true;
      const leftConfirmed = isCovered(coverage.left, ref, alwaysComplete);
      const rightConfirmed = isCovered(coverage.right, ref, alwaysComplete);

      if (input.mode === 'two-way') {
        const { status, resolved } = resolveTwoWayCoverageAware(l, r, leftConfirmed, rightConfirmed);
        entries.push({ path, key: entryKey, status, left: l, right: r, resolved });
      } else {
        const b = baseByKey.get(entryKey);
        const baseConfirmed = isCovered(baseCoverage, ref, alwaysComplete);
        if (b === undefined && !baseConfirmed) {
          // Base coverage is ambiguous for this entry (only possible when a
          // caller explicitly passes a scoped `coverage.base` — the default
          // is always `full`). There is no honest 3-way comparison without
          // a reliable base, so degrade to the same coverage-aware two-way
          // check used in two-way mode rather than fabricate a base value —
          // this can never produce a worse outcome than treating the
          // ambiguous absence as a real deletion would.
          const { status, resolved } = resolveTwoWayCoverageAware(l, r, leftConfirmed, rightConfirmed);
          entries.push({ path, key: entryKey, status, base: b, left: l, right: r, resolved });
        } else {
          const { status, resolved } = resolveThreeWayCoverageAware(b, l, r, leftConfirmed, rightConfirmed);
          entries.push({ path, key: entryKey, status, base: b, left: l, right: r, resolved });
        }
      }
    }
  }

  const mode = input.mode;
  return { mode, key, entries, summary: summarize(entries) };
}

function indexByIdentity(value: unknown, identityField: string): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of asArray(value)) {
    if (!isPlainObject(item)) continue;
    const k = String(unwrapCdata(item[identityField]) ?? '');
    if (k) byKey.set(k, item);
  }
  return byKey;
}

function summarize(entries: readonly MergeEntry[]): MergeSummary {
  const summary: MergeSummary = { unchanged: 0, 'take-left': 0, 'take-right': 0, conflict: 0 };
  const mutable = summary as Record<MergeEntry['status'], number>;
  for (const e of entries) mutable[e.status] += 1;
  return summary;
}
