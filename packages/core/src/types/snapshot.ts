import type { ComponentKey } from './metadata-source.js';

/**
 * A content-addressed snapshot of a single component's canonicalized body.
 * The primary key is `sha256` of the canonical content (see the normalizer
 * in `diff/`), NOT `(sourceId, key)` — identical content from different
 * orgs/comparisons collapses to one stored blob. This is what makes
 * rollback packages and incremental backups nearly free later on.
 */
export interface ComponentSnapshot {
  /** sha256 hex digest of the canonicalized content. Primary key. */
  readonly sha256: string;
  readonly key: ComponentKey;
  /** Canonicalized content (whitespace/order-normalized XML, or raw text for code files). */
  readonly content: string;
  /** Byte length of `content`, stored redundantly for quick size reporting. */
  readonly size: number;
  /** When this exact blob was first observed. */
  readonly firstSeenAt: string;
}

/**
 * Join-table-shaped record: which source, at which point in time, produced
 * a given snapshot for a given component. Many of these can point at the
 * same `sha256`.
 */
export interface ComponentSnapshotRef {
  readonly sourceId: string;
  readonly orgId?: string;
  readonly key: ComponentKey;
  readonly sha256: string;
  readonly lastModifiedDate: string;
  readonly capturedAt: string;
}
