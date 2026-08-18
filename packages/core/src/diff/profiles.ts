import type { DiffEntry, DiffStatus } from '../types/diff.js';
import { parseXml, stripVolatileAndSort } from './normalize.js';
import { unwrapRoot } from './differ.js';
import { unwrapCdata } from './natural-keys.js';

/**
 * Profile / PermissionSet decomposition — the #1 source of diff noise and
 * the most common reason people abandon a comparison (per the task brief).
 * Every permission collection is decomposed into individually keyed,
 * individually selectable `DiffEntry` rows (full grid, not just deltas) so
 * the UI can render a filterable grid instead of a wall of XML, and so a
 * deployment package can select individual entries later.
 *
 * THE CENTRAL HAZARD THIS FILE EXISTS TO HANDLE:
 *
 * A Profile (or PermissionSet) retrieved from an org only contains entries
 * for components that were ALSO in the same retrieve package. Retrieve a
 * Profile alone and you get a near-empty file — not because access was
 * revoked, but because nothing else was asked for. If the differ naively
 * treats "entry present on the left, absent on the right" as `'deleted'`,
 * and that diff is used to build a deployment package, the resulting
 * deployment will contain an explicit "revoke this permission" instruction
 * for something that was never actually different — silently stripping
 * real access from the target org.
 *
 * The fix requires knowing, for each side of the comparison, whether the
 * referenced component (the field, object, Apex class, tab, ...) was
 * actually part of that side's retrieve package. That knowledge lives on
 * the retrieval side (owned by a different workstream — the retrieval
 * planner is what's responsible for actually pairing Profile retrieves
 * with the rest of the package). This module's job is the diff-semantics
 * half of the contract: given that information as `ProfileDiffContext`, do
 * not report a permission as added/removed unless we can be sure.
 *
 * `DiffStatus` has no "unknown" state (it's a fixed contract this module
 * doesn't own — see diff.ts). When coverage is ambiguous, this module
 * reports the entry as `'identical'` — i.e., "no known change" — rather
 * than inventing a new status value. This is the conservative direction:
 * an ambiguous entry that's actually unchanged is reported correctly either
 * way; an ambiguous entry that actually did change is under-reported rather
 * than over-reported, which is the safe failure mode for something that
 * feeds deployment package generation (a missed diff can be re-run and
 * caught by a full-coverage comparison later; a false "removed" cannot be
 * un-deployed as cheaply).
 */

export type ProfileLikeType = 'Profile' | 'PermissionSet';

/** What we know about one side's retrieve-package coverage for a Profile/PermissionSet comparison. */
export type SideCoverage =
  | { readonly mode: 'full' }
  | { readonly mode: 'scoped'; readonly retrievedComponents: ReadonlySet<string> };

export interface ProfileDiffContext {
  readonly left: SideCoverage;
  readonly right: SideCoverage;
}

/**
 * Opt-in full-coverage context for callers that KNOW both sides are
 * complete files — a local SFDX project file, a full-org retrieve, or a
 * hand-written fixture. This is NOT a default (see the inverted-default
 * note on `diffProfileLike`/`diffComponent` below): it must be passed
 * explicitly, so choosing the naive "absence means removed" behavior is
 * always a deliberate decision made at the call site, never something that
 * happens silently because a caller forgot to wire retrieval-pairing
 * information through. Any caller comparing components retrieved from a
 * real org via a scoped comparison filter MUST instead pass a computed
 * `'scoped'` context with the actual set of co-retrieved components.
 */
export const FULL_COVERAGE_CONTEXT: ProfileDiffContext = {
  left: { mode: 'full' },
  right: { mode: 'full' },
};

interface PermissionCollectionSpec {
  readonly tag: string;
  readonly identityField: string;
  /** Metadata type the identity field's value refers to, used to build the `refType:fullName` string checked against `retrievedComponents`. */
  readonly refType: string;
  /**
   * True for permission kinds that are never subject to the retrieve-pairing
   * ambiguity — e.g. `userPermissions` enumerates a fixed, org-wide
   * permission list every Profile/PermissionSet retrieve always includes in
   * full, regardless of what else was in the package. For these, absence
   * always means absence.
   */
  readonly alwaysComplete?: boolean;
}

/**
 * The permission collections that make up the grid, and what each entry's
 * identity field refers to. Extend this table (not code elsewhere) to add
 * a new permission kind — see natural-keys.ts for the parallel table this
 * mirrors for ordering/matching.
 */
const PERMISSION_COLLECTIONS: readonly PermissionCollectionSpec[] = [
  { tag: 'fieldPermissions', identityField: 'field', refType: 'CustomField' },
  { tag: 'objectPermissions', identityField: 'object', refType: 'CustomObject' },
  { tag: 'classAccesses', identityField: 'apexClass', refType: 'ApexClass' },
  { tag: 'pageAccesses', identityField: 'apexPage', refType: 'ApexPage' },
  { tag: 'recordTypeVisibilities', identityField: 'recordType', refType: 'RecordType' },
  { tag: 'tabVisibilities', identityField: 'tab', refType: 'CustomTab' },
  { tag: 'tabSettings', identityField: 'tab', refType: 'CustomTab' },
  {
    tag: 'userPermissions',
    identityField: 'name',
    refType: 'UserPermission',
    alwaysComplete: true,
  },
  { tag: 'applicationVisibilities', identityField: 'application', refType: 'CustomApplication' },
  { tag: 'customPermissions', identityField: 'name', refType: 'CustomPermission' },
  { tag: 'flowAccesses', identityField: 'flow', refType: 'Flow' },
  { tag: 'customMetadataTypeAccesses', identityField: 'name', refType: 'CustomMetadataType' },
  { tag: 'customSettingAccesses', identityField: 'name', refType: 'CustomObject' },
  {
    tag: 'externalDataSourceAccesses',
    identityField: 'externalDataSource',
    refType: 'ExternalDataSource',
  },
  { tag: 'layoutAssignments', identityField: 'layout', refType: 'Layout' },
];

/**
 * Non-ambiguous top-level scalar properties of a Profile/PermissionSet
 * itself — NOT a reference into another retrieved component's permission
 * grid. Phase 1's `diffProfileLike` only ever walked `PERMISSION_COLLECTIONS`
 * (the reference-carrying grid this file exists to protect); these plain
 * fields were never diffed at all, so e.g. a `description` or `userLicense`
 * edit was silently invisible — exactly the "stripping something meaningful"
 * failure mode the brief warns against, just via omission instead of an
 * explicit strip. Safe to diff unconditionally regardless of retrieve-pairing
 * coverage, because — unlike `fieldPermissions`/`classAccesses`/etc. — these
 * fields are always serialized in full on any retrieve of the
 * Profile/PermissionSet itself; nothing else needs to have been co-retrieved
 * for them to be populated.
 *
 * Deliberately narrow: only fields verified (against the real Metadata API
 * XSD) to have NO reference-ambiguity hazard belong here. Fields that
 * reference another metadata component (`loginFlows`, `loginIpRanges`,
 * `categoryGroupVisibilities`, `profileActionOverrides`, `agentAccesses`, …)
 * would need the same retrieve-pairing treatment as the rest of the grid —
 * composite keys and/or coverage-aware absence handling `diffOnePermissionCollection`
 * doesn't support today — and are left for follow-up rather than guessed at
 * here. `fullName` is excluded: it's the component's own identity (already
 * carried by the caller's `ComponentKey`), not a diffable property.
 */
const ALWAYS_DIFFED_SCALAR_FIELDS: Record<ProfileLikeType, readonly string[]> = {
  Profile: ['description', 'custom', 'userLicense'],
  PermissionSet: ['description', 'hasActivationRequired', 'label', 'license'],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isCovered(coverage: SideCoverage, ref: string, alwaysComplete: boolean): boolean {
  if (alwaysComplete) return true;
  if (coverage.mode === 'full') return true;
  return coverage.retrievedComponents.has(ref);
}

function joinPath(parent: string, segment: string): string {
  return parent ? `${parent}.${segment}` : segment;
}

function deepEqual(a: unknown, b: unknown): boolean {
  const ua = unwrapCdata(a);
  const ub = unwrapCdata(b);
  if (Array.isArray(ua) || Array.isArray(ub)) {
    const aa = Array.isArray(ua) ? ua : [];
    const bb = Array.isArray(ub) ? ub : [];
    if (aa.length !== bb.length) return false;
    return aa.every((v, i) => deepEqual(v, bb[i]));
  }
  if (isPlainObject(ua) || isPlainObject(ub)) {
    const oa = isPlainObject(ua) ? ua : {};
    const ob = isPlainObject(ub) ? ub : {};
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const k of keys) if (!deepEqual(oa[k], ob[k])) return false;
    return true;
  }
  return ua === ub;
}

/** Per-property leaf diff for a permission entry that exists on both sides (used to populate `children` when `status: 'changed'`). */
function diffFields(
  path: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): DiffEntry[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((k) => !k.startsWith('@_'))
    .sort();
  return keys.map((k) => {
    const l = unwrapCdata(left[k]);
    const r = unwrapCdata(right[k]);
    const status: DiffStatus = deepEqual(l, r) ? 'identical' : 'changed';
    return { path: joinPath(path, k), key: k, status, before: l, after: r };
  });
}

function diffOnePermissionCollection(
  parentPath: string,
  spec: PermissionCollectionSpec,
  leftItems: unknown[],
  rightItems: unknown[],
  ctx: ProfileDiffContext,
): DiffEntry {
  const path = joinPath(parentPath, spec.tag);
  const leftByKey = new Map<string, Record<string, unknown>>();
  for (const item of leftItems) {
    if (!isPlainObject(item)) continue;
    const key = String(unwrapCdata(item[spec.identityField]) ?? '');
    if (key) leftByKey.set(key, item);
  }
  const rightByKey = new Map<string, Record<string, unknown>>();
  for (const item of rightItems) {
    if (!isPlainObject(item)) continue;
    const key = String(unwrapCdata(item[spec.identityField]) ?? '');
    if (key) rightByKey.set(key, item);
  }

  const allKeys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const children: DiffEntry[] = allKeys.map((entryKey) => {
    const entryPath = joinPath(path, entryKey);
    const l = leftByKey.get(entryKey);
    const r = rightByKey.get(entryKey);
    const ref = `${spec.refType}:${entryKey}`;

    if (l && r) {
      const status: DiffStatus = deepEqual(l, r) ? 'identical' : 'changed';
      return status === 'identical'
        ? { path: entryPath, key: entryKey, status, before: l, after: r }
        : { path: entryPath, key: entryKey, status, children: diffFields(entryPath, l, r) };
    }

    if (l && !r) {
      const rightSawTheComponent = isCovered(ctx.right, ref, spec.alwaysComplete === true);
      if (rightSawTheComponent) {
        return { path: entryPath, key: entryKey, status: 'deleted', before: l, after: undefined };
      }
      // Ambiguous: right didn't retrieve this component, so its absence
      // here tells us nothing. Report as unchanged rather than risk a
      // deployment that revokes access nobody actually touched.
      return { path: entryPath, key: entryKey, status: 'identical', before: l, after: l };
    }

    // r && !l
    const leftSawTheComponent = isCovered(ctx.left, ref, spec.alwaysComplete === true);
    if (leftSawTheComponent) {
      return { path: entryPath, key: entryKey, status: 'new', before: undefined, after: r };
    }
    return { path: entryPath, key: entryKey, status: 'identical', before: r, after: r };
  });

  const status: DiffStatus = children.every((c) => c.status === 'identical')
    ? 'identical'
    : 'changed';
  return { path, key: spec.tag, status, children };
}

/**
 * Decomposes and diffs a Profile or PermissionSet's permission grid.
 * `left`/`right` are the raw XML strings (or `undefined` if the component
 * doesn't exist on that side at all — a whole-component new/delete, not a
 * permission-level one; callers should handle that case before calling
 * this). Returns one top-level `DiffEntry` per permission collection
 * (`fieldPermissions`, `objectPermissions`, ...), each with one child per
 * keyed entry, `identical` entries included — the full addressable grid.
 *
 * `ctx` is REQUIRED, deliberately with no default. Earlier versions of this
 * function defaulted to `FULL_COVERAGE_CONTEXT` when omitted, which is
 * unsafe by construction: a Profile retrieved from an org only contains
 * entries for components also present in the same retrieve package, so
 * treating an omitted context as "both sides are complete" silently reports
 * absent-but-not-retrieved entries as deletions — and a deployment package
 * built from that diff would strip real user permissions with no warning.
 * Callers that genuinely have complete files on both sides (a local SFDX
 * project file, a full-org retrieve, a hand-written fixture) must opt into
 * that behavior explicitly by passing `FULL_COVERAGE_CONTEXT`. Callers
 * comparing org retrievals must pass a computed `'scoped'` context. There is
 * intentionally no third option that lets this be forgotten.
 */
export function diffProfileLike(
  type: ProfileLikeType,
  left: string | undefined,
  right: string | undefined,
  ctx: ProfileDiffContext,
): DiffEntry[] {
  const leftRoot =
    left === undefined
      ? {}
      : unwrapRoot(stripVolatileAndSort(type, '', parseXml(left)) as Record<string, unknown>);
  const rightRoot =
    right === undefined
      ? {}
      : unwrapRoot(stripVolatileAndSort(type, '', parseXml(right)) as Record<string, unknown>);

  const scalarEntries: DiffEntry[] = ALWAYS_DIFFED_SCALAR_FIELDS[type].map((field) => {
    const l = unwrapCdata(leftRoot[field]);
    const r = unwrapCdata(rightRoot[field]);
    const status: DiffStatus = deepEqual(l, r) ? 'identical' : 'changed';
    return { path: field, key: field, status, before: l, after: r };
  });

  const gridEntries = PERMISSION_COLLECTIONS.map((spec) =>
    diffOnePermissionCollection(
      '',
      spec,
      asArray(leftRoot[spec.tag]),
      asArray(rightRoot[spec.tag]),
      ctx,
    ),
  ).filter((entry) => entry.children && entry.children.length > 0);

  return [...scalarEntries, ...gridEntries];
}
