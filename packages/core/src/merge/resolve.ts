import { deepEqual } from '../diff/profiles.js';
import type { MergeEntryStatus } from '../types/merge.js';

/**
 * The core per-entry resolution rules, shared by both the generic
 * (CustomObject-like) and Profile-like merge paths. Kept side-effect-free
 * and dependent only on plain values so both callers can unit-test and
 * reuse it identically — the two-way/three-way DISTINCTION lives here, in
 * exactly one place, so it can never silently drift between the two entry
 * decomposition strategies.
 *
 * `undefined` uniformly means "no entry on this side" for every caller here
 * (a missing collection item, or a scalar tag genuinely absent from the
 * XML) — see decompose.ts / profile-merge.ts for how each path establishes
 * that invariant before calling in.
 */

export interface Resolution {
  readonly status: MergeEntryStatus;
  readonly resolved: unknown;
}

/**
 * No common ancestor: an entry present on only one side is a non-overlapping
 * change and merges cleanly (`take-left`/`take-right`) with no ambiguity —
 * nothing was there to conflict with. An entry present on BOTH sides with
 * different content has no base to say who "changed" it, so two-way mode
 * can only report it as a `conflict` requiring an explicit human decision —
 * see the file header on `types/merge.ts` for why this must never be
 * softened into an auto-resolution.
 */
export function resolveTwoWay(left: unknown, right: unknown): Resolution {
  if (left === undefined && right === undefined) return { status: 'unchanged', resolved: undefined };
  if (left !== undefined && right === undefined) return { status: 'take-left', resolved: left };
  if (left === undefined && right !== undefined) return { status: 'take-right', resolved: right };
  if (deepEqual(left, right)) return { status: 'unchanged', resolved: left };
  return { status: 'conflict', resolved: undefined };
}

/**
 * A base is available: an entry changed relative to base on only one side
 * auto-resolves to that side's value ("they didn't touch it, I did — take
 * mine"). An entry changed on BOTH sides is a `conflict` UNLESS both sides
 * independently converged on the identical final value, in which case there
 * is nothing left to decide. This also correctly produces `conflict` for
 * the deletion-vs-edit case: a deletion is "changed relative to base" (to
 * `undefined`) exactly like any other edit, so one side deleting while the
 * other edits the same entry lands in the both-changed branch, and the
 * (non-)equality check there reports it as a conflict rather than silently
 * preferring the deletion or the edit.
 */
export function resolveThreeWay(base: unknown, left: unknown, right: unknown): Resolution {
  const changedLeft = !deepEqual(base, left);
  const changedRight = !deepEqual(base, right);
  if (!changedLeft && !changedRight) return { status: 'unchanged', resolved: base };
  if (changedLeft && !changedRight) return { status: 'take-left', resolved: left };
  if (!changedLeft && changedRight) return { status: 'take-right', resolved: right };
  if (deepEqual(left, right)) return { status: 'unchanged', resolved: left };
  return { status: 'conflict', resolved: undefined };
}

/**
 * Coverage-aware variant of `resolveTwoWay` for Profile/PermissionSet
 * entries — the one place the retrieve-pairing hazard from `diff/profiles.ts`
 * also applies to merge (see that file's header). `leftConfirmedIfAbsent` /
 * `rightConfirmedIfAbsent` answer "if this side's value is `undefined`, do we
 * actually know that means absent?" (i.e. `isCovered(...)` for that side's
 * coverage against this entry's ref). When a side is absent AND that
 * absence is NOT confirmed, this degrades to `'unchanged'` rather than risk
 * manufacturing a `take-left`/`take-right`/`conflict` from a side we simply
 * never retrieved — the same conservative direction `diffProfileLike` takes
 * (an ambiguous entry that's actually unchanged is reported correctly
 * either way; one that actually did change is under-reported, which is the
 * safe failure mode for something that can feed a deployment package).
 */
export function resolveTwoWayCoverageAware(
  left: unknown,
  right: unknown,
  leftConfirmedIfAbsent: boolean,
  rightConfirmedIfAbsent: boolean,
): Resolution {
  const leftAmbiguous = left === undefined && !leftConfirmedIfAbsent;
  const rightAmbiguous = right === undefined && !rightConfirmedIfAbsent;
  if (leftAmbiguous || rightAmbiguous) {
    return { status: 'unchanged', resolved: left !== undefined ? left : right };
  }
  return resolveTwoWay(left, right);
}

/**
 * Coverage-aware variant of `resolveThreeWay`. `base` is assumed always
 * fully known (a merge base is a complete file — a git-tracked SFDX source
 * or a full-org retrieve — never a scope-limited org comparison), so only
 * `left`/`right` take confirmation flags. A side whose absence is not
 * confirmed is treated as NOT having changed relative to base — never as
 * evidence of a deletion — which is exactly what keeps an unretrieved
 * component from ever being merged away.
 */
export function resolveThreeWayCoverageAware(
  base: unknown,
  left: unknown,
  right: unknown,
  leftConfirmedIfAbsent: boolean,
  rightConfirmedIfAbsent: boolean,
): Resolution {
  const changedLeft =
    left === undefined && !leftConfirmedIfAbsent ? false : !deepEqual(base, left);
  const changedRight =
    right === undefined && !rightConfirmedIfAbsent ? false : !deepEqual(base, right);
  if (!changedLeft && !changedRight) return { status: 'unchanged', resolved: base };
  if (changedLeft && !changedRight) return { status: 'take-left', resolved: left };
  if (!changedLeft && changedRight) return { status: 'take-right', resolved: right };
  if (deepEqual(left, right)) return { status: 'unchanged', resolved: left };
  return { status: 'conflict', resolved: undefined };
}
