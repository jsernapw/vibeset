import type { ComponentInventoryEntry, ComponentKey, MetadataSource, TypeFilter } from '../types/metadata-source.js';
import type { JobProgress } from '../types/job.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import { componentKeyString } from '../util/component-key.js';
import { type ChunkingOptions, planMaterializeChunks } from './chunking.js';

/**
 * The retrieval plan for a single `MetadataSource`: what inventory found,
 * which of those components are already cached (skip retrieval entirely —
 * their `lastModifiedDate` matches a stored ref), which must actually be
 * fetched, and how the "must fetch" set is chunked to stay under the
 * Metadata API's per-retrieve limits (with Profile/PermissionSet pairing
 * respected — see `chunking.ts`).
 */
export interface SourceRetrievalPlan {
  readonly sourceId: string;
  readonly inventoriedCount: number;
  readonly cacheHits: ComponentKey[];
  readonly toFetch: ComponentKey[];
  readonly chunks: ComponentKey[][];
  readonly warnings: string[];
  /**
   * Additive field (Phase 1c): the full inventory entries this plan was
   * built from (including `lastModifiedDate`), which `planSource` already
   * fetches internally but previously discarded once `cacheHits`/`toFetch`
   * were derived. The comparison engine needs the dates back to `put()`
   * freshly-materialized components into the `SnapshotStore` (which
   * requires `lastModifiedDate` as part of its lookup key) without a second,
   * redundant `source.inventory()` call. Existing consumers of the other
   * fields are unaffected by this addition.
   */
  readonly entries: readonly ComponentInventoryEntry[];
  /**
   * Additive field (Phase 1c): `sha256` for every cache-hit key (keyed by
   * `componentKeyString`), captured from the single `store.lookup()` pass
   * this method already performs. Lets callers fetch a cache-hit
   * component's content (`store.getBlob(sha256)`) without a second
   * `store.lookup()` call, which would otherwise double-count the
   * `SnapshotStoreStats` hit/miss/bytesSaved counters.
   */
  readonly cacheHitShas: ReadonlyMap<string, string>;
}

export interface ComparisonRetrievalPlan {
  readonly left: SourceRetrievalPlan;
  readonly right: SourceRetrievalPlan;
}

export interface PlanRetrievalOptions {
  readonly filter: TypeFilter;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: JobProgress) => void;
  /** Used to tag emitted `JobProgress` events; defaults to `plan:<source.id>`. */
  readonly jobId?: string;
  readonly chunking?: ChunkingOptions;
}

/**
 * Turns two `MetadataSource`s + a `TypeFilter` into a concrete plan of what
 * needs to be fetched, consulting the content-addressed `SnapshotStore` to
 * skip anything unchanged. Framework-free and network-free by construction:
 * it only ever calls `source.inventory()` (never `materialize()`) and the
 * injected `SnapshotStore`, so it's fully testable against fake sources with
 * no network access — see `test/retrieval/planner.test.ts`.
 *
 * Cancellation: pass an `AbortSignal` in `PlanRetrievalOptions`. Checked
 * between phases (before inventory, after inventory, per-component cache
 * lookup batches) so a cancel lands promptly on large orgs without needing
 * to interrupt an in-flight network call the planner doesn't make itself.
 */
export class RetrievalPlanner {
  constructor(private readonly store: SnapshotStore) {}

  async planSource(source: MetadataSource, options: PlanRetrievalOptions): Promise<SourceRetrievalPlan> {
    const jobId = options.jobId ?? `plan:${source.id}`;
    const emit = (percent: number, message: string): void => {
      options.onProgress?.({ jobId, status: 'running', percent, message, at: new Date().toISOString() });
    };

    options.signal?.throwIfAborted();
    emit(0, `Inventorying ${source.label}...`);

    const inventory = await source.inventory(options.filter);
    options.signal?.throwIfAborted();
    emit(40, `Inventoried ${inventory.entries.length} components from ${source.label}; checking cache...`);

    const cacheHits: ComponentKey[] = [];
    const toFetch: ComponentKey[] = [];
    const cacheHitShas = new Map<string, string>();

    for (let i = 0; i < inventory.entries.length; i += 1) {
      const entry = inventory.entries[i]!;
      // Components whose source can't supply a real lastModifiedDate must
      // always be treated as changed — there's no timestamp to compare, so
      // a cache hit here would risk silently serving stale content forever.
      if (!entry.lastModifiedDateUnknown) {
        const cached = await this.store.lookup({
          sourceId: source.id,
          key: entry.key,
          lastModifiedDate: entry.lastModifiedDate,
        });
        if (cached) {
          cacheHits.push(entry.key);
          cacheHitShas.set(componentKeyString(entry.key), cached);
          continue;
        }
      }
      toFetch.push(entry.key);

      if (i % 500 === 0) {
        options.signal?.throwIfAborted();
        const pct = 40 + Math.round((i / Math.max(inventory.entries.length, 1)) * 40);
        emit(pct, `Checked cache for ${i}/${inventory.entries.length}...`);
      }
    }

    options.signal?.throwIfAborted();
    emit(85, `${cacheHits.length} cache hits, ${toFetch.length} to fetch; chunking retrieve plan...`);

    const { chunks, warnings } = planMaterializeChunks(toFetch, options.chunking);

    emit(100, `Plan ready: ${chunks.length} chunk(s) for ${source.label}.`);

    return {
      sourceId: source.id,
      inventoriedCount: inventory.entries.length,
      cacheHits,
      toFetch,
      chunks,
      warnings,
      entries: inventory.entries,
      cacheHitShas,
    };
  }

  /**
   * Plans both sides of a comparison. Sequential rather than
   * `Promise.all`-parallel on purpose: progress percentages are easy to
   * reason about (0-50 left, 50-100 right) and it keeps concurrent load on
   * two potentially-different orgs predictable. The chunked *materialize*
   * step (not implemented here — that's each `MetadataSource`'s job) is
   * where real parallelism matters and happens.
   */
  async planComparison(
    left: MetadataSource,
    right: MetadataSource,
    options: PlanRetrievalOptions,
  ): Promise<ComparisonRetrievalPlan> {
    const scale = (from: number, to: number) => (progress: JobProgress): void => {
      const scaled = from + (progress.percent / 100) * (to - from);
      options.onProgress?.({ ...progress, jobId: options.jobId ?? 'plan:comparison', percent: Math.round(scaled) });
    };

    const leftPlan = await this.planSource(left, { ...options, onProgress: scale(0, 50) });
    options.signal?.throwIfAborted();
    const rightPlan = await this.planSource(right, { ...options, onProgress: scale(50, 100) });

    return { left: leftPlan, right: rightPlan };
  }
}
