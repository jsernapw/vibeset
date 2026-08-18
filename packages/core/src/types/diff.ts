import type { ComponentKey } from './metadata-source.js';

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
}
