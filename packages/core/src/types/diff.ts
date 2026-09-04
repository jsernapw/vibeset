import type { ComponentKey } from './metadata-source.js';
import type { SideCoverage } from '../diff/profiles.js';

export type DiffStatus = 'new' | 'changed' | 'deleted' | 'identical';

/**
 * One node in a semantic tree diff of a decomposed component (e.g. one
 * `<fields>` entry of a CustomObject, one permission of a PermissionSet).
 * Keyed on Salesforce's natural key for that node type — NOT position —
 * so a reordered XML block never registers as a change.
 */
export interface DiffEntry {
  /** Dotted path from the component root, e.g. `fields.My_Field__c.required`. */
  readonly path: string;
  /** The natural key identifying this node (fullName, field name, picklist value, permission name...). */
  readonly key: string;
  readonly status: DiffStatus;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly children?: DiffEntry[];
}

/**
 * The diff result for a single component between two sources (left/right,
 * i.e. source/target of a comparison).
 */
export interface DiffResult {
  readonly key: ComponentKey;
  readonly status: DiffStatus;
  /** sha256 of the left-side (source) canonical snapshot, if present. */
  readonly leftSha256?: string;
  /** sha256 of the right-side (target) canonical snapshot, if present. */
  readonly rightSha256?: string;
  /** Semantic tree diff, populated for decomposable XML types. */
  readonly entries?: DiffEntry[];
  /**
   * Line-level text diff (jsdiff hunks) for opaque body types: Apex, LWC/Aura
   * JS/HTML/CSS, VF pages. Mutually exclusive with `entries` in practice.
   */
  readonly textDiff?: TextDiffHunk[];
  /**
   * `true` for binary-bodied types (`StaticResource`, `Document`: zip,
   * image, or other opaque content — see `util/binary-content.ts`). These
   * are compared by content hash only, never `entries`/`textDiff`, because
   * there is no meaningful line- or element-level diff of arbitrary bytes.
   * The UI contract: render `status: 'changed'` on a binary result as
   * "binary content changed" (sha256 before/after), never attempt a
   * tree/line diff renderer for it. Omitted (not `false`) for every
   * non-binary type, matching this field's additive nature.
   */
  readonly binary?: boolean;
  /**
   * Set only for a `binary: true` result whose `status` could NOT be
   * honestly derived from a real content-hash comparison, because one or
   * both sides' bytes could not be read/materialized — e.g. SDR's
   * `StaticResourceMetadataTransformer` throwing `BadZipFile` for certain
   * `omnistudio__` StaticResources (see `sources/org-source.ts`'s
   * `convertWithIsolation` doc comment), or a race/symlink failure reading
   * the body file. `{ left: true }` / `{ right: true }` name which side(s)
   * failed; a side that materialized fine is omitted, not `false`.
   *
   * THE INVARIANT THIS FIELD EXISTS TO PROTECT: `status: 'identical'` on a
   * binary result is a claim that both sides' bytes were actually read and
   * hashed equal. Before this field existed, `diffBinaryComponent` reported
   * `'identical'` whenever both sides resolved to `undefined` — collapsing
   * "this component genuinely doesn't exist on either side" (a legitimate
   * `'identical'`) together with "it exists on both sides but neither
   * side's content could be read" (NOT identical — unknown, and reporting
   * it as identical is a silent lie that could hide a real difference or
   * mask data loss on a tool that feeds production deployments). `DiffStatus`
   * has no "unknown" member (see that type's callers throughout `diff/` and
   * `compare/`), so this case reports `status: 'changed'` — the safer of
   * the two visible options, since it prompts a human to look rather than
   * silently suppressing the discrepancy — with `unreadable` set so any
   * consumer (this comparison's own summary counts, the tRPC API, the UI)
   * can render "could not compare" instead of a normal binary-changed diff.
   * A consumer that ignores this field still lands on the safe side.
   */
  readonly unreadable?: { readonly left?: boolean; readonly right?: boolean };
}

export interface TextDiffHunk {
  readonly added: boolean;
  readonly removed: boolean;
  readonly value: string;
  /** 1-based line number in the left/before content where this hunk starts, if known. */
  readonly lineStart?: number;
}

/** Aggregate result for a whole comparison run, grouped for the UI's virtualized tree. */
export interface ComparisonResult {
  readonly comparisonId: string;
  readonly results: DiffResult[];
  readonly summary: Record<DiffStatus, number>;
  /**
   * The EXACT `SideCoverage` pair `ComparisonEngine.diffAll` computed (via
   * `compare/coverage.ts`'s `coverageForProfileLike`) for each
   * Profile/PermissionSet component in `results`, keyed by
   * `componentKeyString`. Absent for every other type.
   *
   * This exists so a later merge of the SAME component can reuse the
   * identical coverage the original diff used, rather than recomputing it
   * from a second, potentially-stale retrieval plan (the org may have
   * changed between the comparison and the merge request, or the
   * connection may no longer resolve at all) — merge and diff can then
   * never disagree about what an unretrieved permission means, and the
   * merge route never has to guess. See `merge/profile-merge.ts`'s
   * `MergeProfileCoverage`/`requireMergeProfileCoverage`: the hazard is
   * identical to `ProfileDiffContext`'s — an unretrieved entry must never
   * be treated as a deletion to merge away.
   */
  readonly profileCoverage?: Readonly<Record<string, { readonly left: SideCoverage; readonly right: SideCoverage }>>;
}
