import type { ComponentKey } from './metadata-source.js';

/**
 * Entry-level merge — Phase 2 Workstream B, the headline differentiator over
 * Gearset's "stops at every conflict for manual resolution" behavior.
 *
 * THE CONSTRAINT THAT MUST NOT BE FUDGED:
 *
 * A true 3-way merge requires a common ancestor. Org<->Org comparisons have
 * none — you only ever have two states and no record of who changed what,
 * so the best that's honestly possible is a TWO-WAY merge: every entry that
 * differs between the two sides needs an explicit human resolution decision,
 * because there is no base to say which side "changed" it. Only when a
 * `GitRefSource` supplies a merge base does a genuine THREE-WAY merge become
 * possible, where "changed on one side only" can be auto-resolved and a
 * conflict is reported only when BOTH sides changed the same entry.
 *
 * `MergeMode` is a required, explicit field on both the input and the result
 * of every merge call in this module — never an inference the caller (or,
 * worse, the UI) has to make from whether a `base` happens to be present.
 * Silently presenting a two-way merge as if it were 3-way would imply a
 * safety guarantee ("only genuine conflicts need attention") that does not
 * hold without a base, on an operation that writes to production orgs.
 */
export type MergeMode = 'two-way' | 'three-way';

/**
 * Resolution state of one merged entry:
 *  - `unchanged`   — nothing to do. Two-way: both sides already agree.
 *                    Three-way: neither side changed it relative to base, OR
 *                    both sides changed it but converged on the same value.
 *  - `take-left`   — auto-resolves to the left value. Two-way: only left has
 *                    this entry (a non-overlapping addition/deletion — no
 *                    ambiguity, nothing for a human to decide). Three-way:
 *                    left changed it relative to base and right did not.
 *  - `take-right`  — the mirror of `take-left`.
 *  - `conflict`     — requires an explicit human decision. Two-way: the entry
 *                    exists on both sides with genuinely different content
 *                    (no base to say who's "right"). Three-way: BOTH sides
 *                    changed the entry relative to base, to DIFFERENT final
 *                    values (includes the deletion-vs-edit case: one side
 *                    deleted, the other edited).
 */
export type MergeEntryStatus = 'unchanged' | 'take-left' | 'take-right' | 'conflict';

/**
 * One keyed, individually-resolvable unit of a merge — a single permission
 * grid row (`path: "fieldPermissions.Account.My_Field__c"`), a single
 * CustomObject field/listView/recordType/validationRule
 * (`path: "fields.My_Field__c"`), or a top-level scalar property
 * (`path: "description"`). Mirrors the granularity `diff/natural-keys.ts`
 * already establishes for the differ; merge does not invent a second
 * decomposition. `MergeResult.entries` is a FLAT list — the group a keyed
 * entry belongs to (`fieldPermissions`, `fields`, ...) is the first path
 * segment, not a separate parent node; there is no group-level aggregate
 * status, deliberately, because a mix of clean and conflicting children has
 * no honest single-value summary among the four `MergeEntryStatus` values.
 */
export interface MergeEntry {
  readonly path: string;
  readonly key: string;
  readonly status: MergeEntryStatus;
  /**
   * Populated only when `MergeResult.mode === 'three-way'`. `undefined` both
   * when the mode is two-way AND when the entry genuinely did not exist at
   * the base — callers must gate on `mode`, not on this field's presence,
   * to tell those two cases apart.
   */
  readonly base?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  /**
   * The value the merge would apply when `status !== 'conflict'`.
   * `undefined` with `status !== 'conflict'` means "the merged result has no
   * entry here" (both sides agree it's deleted, or the entry never existed
   * on any covered side). Always `undefined` for `status === 'conflict'` —
   * by construction there is no auto-resolvable value.
   */
  readonly resolved?: unknown;
}

export interface MergeSummary {
  readonly unchanged: number;
  readonly 'take-left': number;
  readonly 'take-right': number;
  readonly conflict: number;
}

interface MergeResultCommon {
  readonly key: ComponentKey;
  readonly entries: MergeEntry[];
  readonly summary: MergeSummary;
}

/** Discriminated on `mode` — see the file header. Do not collapse this back into one shape with an optional `mode`; the two branches exist so a caller (and, transitively, the UI) is forced to look at `mode` before treating a result as carrying 3-way safety guarantees. */
export type MergeResult =
  | (MergeResultCommon & { readonly mode: 'two-way' })
  | (MergeResultCommon & { readonly mode: 'three-way' });

/**
 * Input to a merge call. Discriminated on `mode` the same way as the result:
 * three-way requires a `base` key (its value may still be `undefined`,
 * meaning the component did not exist at the merge base at all — a valid
 * 3-way scenario, e.g. both sides independently created it). Two-way has no
 * `base` key at all — it is a compile-time error to supply one, so a caller
 * cannot accidentally compute a two-way merge while holding a base and
 * forget to use it.
 */
export type MergeInput =
  | {
      readonly mode: 'two-way';
      readonly left: string | undefined;
      readonly right: string | undefined;
    }
  | {
      readonly mode: 'three-way';
      readonly base: string | undefined;
      readonly left: string | undefined;
      readonly right: string | undefined;
    };
