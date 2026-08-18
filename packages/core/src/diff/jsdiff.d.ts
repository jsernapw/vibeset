/**
 * `diff` (jsdiff) 7.0.0 ships no bundled `.d.ts` and `@types/diff` 8.x is a
 * stub ("diff provides its own types now") that doesn't apply to this
 * older installed version. This is a minimal ambient declaration for only
 * the surface `text.ts` actually uses, scoped to this package rather than
 * touching the shared root dependency versions.
 */
declare module 'diff' {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }

  export function diffLines(
    oldStr: string,
    newStr: string,
    options?: Record<string, unknown>,
  ): Change[];
}
