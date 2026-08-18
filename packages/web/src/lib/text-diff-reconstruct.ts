import type { TextDiffHunk } from '@vibeset/core';

/**
 * Reconstructs full "before"/"after" text from a `DiffResult.textDiff` hunk
 * list (jsdiff-shaped: `{added, removed, value}`). The real
 * `comparisons.results` route stores hunks, not two full-text blobs (jsdiff
 * hunks ARE the diff — re-deriving the two full texts from them is exact
 * and free, no reason to also persist the raw bodies redundantly).
 *
 * Added for `components/diff/DiffViewer.tsx` (owned by a parallel
 * workstream) to consume once it stops calling
 * `lib/mock/comparison-mock.ts`'s `generateMockApexSource` — see that
 * file's top-of-file doc comment and this session's final report for the
 * full context. Not wired up anywhere yet; this repo's `DiffViewer.tsx` is
 * out of this file's ownership boundary.
 *
 * Usage once wired up:
 * ```ts
 * const { before, after } = reconstructFromTextDiff(result.textDiff);
 * <LazyMonacoDiff original={before} modified={after} language="apex" height={460} />
 * ```
 */
export function reconstructFromTextDiff(hunks: readonly TextDiffHunk[] | undefined): { before: string; after: string } {
  if (!hunks || hunks.length === 0) return { before: '', after: '' };
  let before = '';
  let after = '';
  for (const hunk of hunks) {
    if (hunk.removed) before += hunk.value;
    else if (hunk.added) after += hunk.value;
    else {
      before += hunk.value;
      after += hunk.value;
    }
  }
  return { before, after };
}
