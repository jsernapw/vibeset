import type { ComponentKey } from '../types/metadata-source.js';
import type { MergeInput, MergeResult } from '../types/merge.js';
import { mergeGeneric } from './generic-merge.js';
import { mergeProfileLike, requireMergeProfileCoverage, type MergeProfileCoverage } from './profile-merge.js';

/**
 * The single entry point that ties the generic and Profile-like merge paths
 * together — the merge-side counterpart of `diff/dispatch.ts`. Dispatch on
 * type mirrors that file's `PROFILE_LIKE_TYPES` split exactly, for the same
 * reason: Profile/PermissionSet is the one place retrieve-pairing coverage
 * has to be threaded through, and everything else goes through the generic
 * natural-key decomposition unmodified.
 *
 * `mode` on `input` (see `types/merge.ts`) is REQUIRED and drives both paths
 * identically — there is no inference from whether a `base` happens to be
 * present, and the returned `MergeResult.mode` echoes it back verbatim so a
 * caller (or the UI, several layers downstream) can never lose track of
 * which safety guarantees actually apply to a given result.
 */
const PROFILE_LIKE_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

export function mergeComponent(
  key: ComponentKey,
  input: MergeInput,
  profileCoverage?: MergeProfileCoverage,
): MergeResult {
  if (PROFILE_LIKE_TYPES.has(key.type)) {
    return mergeProfileLike(key, input, requireMergeProfileCoverage(key, profileCoverage));
  }
  return mergeGeneric(key, input);
}

export { PROFILE_LIKE_TYPES as MERGE_PROFILE_LIKE_TYPES };
