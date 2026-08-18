import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey, MetadataSource, TypeFilter } from '../types/metadata-source.js';
import type { ComparisonResult, DiffResult, DiffStatus } from '../types/diff.js';
import type { JobProgress } from '../types/job.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import { RetrievalPlanner, type SourceRetrievalPlan } from '../retrieval/planner.js';
import type { ChunkingOptions } from '../retrieval/chunking.js';
import { diffComponent } from '../diff/dispatch.js';
import type { ProfileDiffContext } from '../diff/profiles.js';
import { componentKeyString } from '../util/component-key.js';
import { canonicalizeByType } from '../util/canonicalize-dispatch.js';
import { BINARY_BODY_TYPES } from '../util/binary-content.js';
import { sha256Hex } from '../hash.js';
import { cleanupSourceTree, resolveComponentContents } from './content-reader.js';
import { buildSideCoverageContext, coverageForProfileLike } from './coverage.js';

const PROFILE_LIKE_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

export interface RunComparisonOptions {
  /** Caller-supplied comparison id, echoed back on `ComparisonResult.comparisonId` and used to namespace progress events. */
  readonly comparisonId: string;
  readonly filter: TypeFilter;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: JobProgress) => void;
  readonly jobId?: string;
  readonly chunking?: ChunkingOptions;
  readonly registry?: RegistryAccess;
}

/**
 * Orchestrates a full comparison between two `MetadataSource`s: inventory
 * both sides, resolve cache hits via the `SnapshotStore`, materialize only
 * what's actually needed (honouring the Profile/PermissionSet pairing rule
 * end to end — see `compare/coverage.ts`), canonicalize, short-circuit on
 * equal `sha256`, and produce a `ComparisonResult`.
 *
 * Framework-free by construction (no Fastify/Drizzle/tRPC): `server` wraps
 * this in a `JobHandler` (see `packages/server/src/trpc/routers/comparisons.ts`)
 * and persists the result to the `comparisons`/`diff_results` tables; `core`
 * itself only needs a `SnapshotStore` (any implementation) and two
 * `MetadataSource`s.
 */
export class ComparisonEngine {
  private readonly registry: RegistryAccess;

  constructor(
    private readonly store: SnapshotStore,
    options: { readonly registry?: RegistryAccess } = {},
  ) {
    this.registry = options.registry ?? new RegistryAccess();
  }

  async run(left: MetadataSource, right: MetadataSource, options: RunComparisonOptions): Promise<ComparisonResult> {
    const jobId = options.jobId ?? `compare:${options.comparisonId}`;
    const emit = (percent: number, message: string): void => {
      options.onProgress?.({ jobId, status: 'running', percent, message, at: new Date().toISOString() });
    };

    const planner = new RetrievalPlanner(this.store);
    emit(0, `Planning retrieval for ${left.label} vs ${right.label}...`);
    const plan = await planner.planComparison(left, right, {
      filter: options.filter,
      signal: options.signal,
      chunking: options.chunking,
      onProgress: (p) => emit(Math.round(p.percent * 0.3), p.message ?? ''),
    });
    options.signal?.throwIfAborted();

    emit(30, `Materializing ${plan.left.toFetch.length} component(s) from ${left.label}...`);
    const leftContents = await this.fetchAndCache(left, plan.left, options.signal, (pct, msg) =>
      emit(30 + Math.round(pct * 0.3), msg),
    );
    options.signal?.throwIfAborted();

    emit(60, `Materializing ${plan.right.toFetch.length} component(s) from ${right.label}...`);
    const rightContents = await this.fetchAndCache(right, plan.right, options.signal, (pct, msg) =>
      emit(60 + Math.round(pct * 0.3), msg),
    );
    options.signal?.throwIfAborted();

    emit(90, 'Diffing components...');
    const results = await this.diffAll(left.kind, right.kind, plan, leftContents, rightContents, options.signal);

    const summary: Record<DiffStatus, number> = { new: 0, changed: 0, deleted: 0, identical: 0 };
    for (const r of results) summary[r.status] += 1;

    emit(100, `Comparison complete: ${results.length} component(s) (${summary.new} new, ${summary.changed} changed, ${summary.deleted} deleted, ${summary.identical} identical).`);

    return { comparisonId: options.comparisonId, results, summary };
  }

  /**
   * Materializes `plan.chunks` (already Profile-paired and size-limited by
   * `planMaterializeChunks`), reads each component's raw content, and
   * `put()`s the canonicalized content into the `SnapshotStore` keyed by the
   * `lastModifiedDate` recorded in `plan.entries` — the write half of the
   * content-addressed cache. Returns raw content keyed by
   * `componentKeyString`, for freshly-fetched components only (cache hits
   * are resolved separately in `diffAll`, from the store).
   */
  private async fetchAndCache(
    source: MetadataSource,
    plan: SourceRetrievalPlan,
    signal: AbortSignal | undefined,
    onProgress: (percent: number, message: string) => void,
  ): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    if (plan.toFetch.length === 0) return contents;

    const dateByKey = new Map(plan.entries.map((e) => [componentKeyString(e.key), e] as const));
    const orgId = source.kind === 'org' ? source.id : undefined;

    for (let i = 0; i < plan.chunks.length; i += 1) {
      signal?.throwIfAborted();
      const chunkKeys = plan.chunks[i]!;
      const tree = await source.materialize(chunkKeys);
      try {
        const resolved = await resolveComponentContents(tree, chunkKeys, this.registry);
        for (const [ks, raw] of resolved) {
          contents.set(ks, raw);
          const entry = dateByKey.get(ks);
          if (entry && !entry.lastModifiedDateUnknown) {
            await this.store.put({
              sourceId: source.id,
              key: entry.key,
              lastModifiedDate: entry.lastModifiedDate,
              content: canonicalizeByType(entry.key.type, raw),
              orgId,
            });
          }
        }
      } finally {
        await cleanupSourceTree(tree);
      }
      onProgress(Math.round(((i + 1) / plan.chunks.length) * 100), `Materialized chunk ${i + 1}/${plan.chunks.length} from ${source.label}.`);
    }

    return contents;
  }

  /**
   * Assembles the union of both sides' full inventory, resolves content for
   * every key (fresh content from `fetchAndCache`'s output, cache-hit
   * content from the `SnapshotStore`), and dispatches each to
   * `diffComponent` — with a fast path that skips content resolution
   * entirely when both sides are cache hits pointing at the SAME `sha256`
   * (the actual point of content addressing: no blob read, no diff, just an
   * equality check on two hashes already known from the retrieval plan).
   */
  private async diffAll(
    leftKind: MetadataSource['kind'],
    rightKind: MetadataSource['kind'],
    plan: { readonly left: SourceRetrievalPlan; readonly right: SourceRetrievalPlan },
    leftFresh: ReadonlyMap<string, string>,
    rightFresh: ReadonlyMap<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<DiffResult[]> {
    const leftKeys = new Map<string, ComponentKey>();
    for (const e of plan.left.entries) leftKeys.set(componentKeyString(e.key), e.key);
    const rightKeys = new Map<string, ComponentKey>();
    for (const e of plan.right.entries) rightKeys.set(componentKeyString(e.key), e.key);

    const allKeyStrings = new Set<string>([...leftKeys.keys(), ...rightKeys.keys()]);

    const leftCoverage = buildSideCoverageContext(leftKind, plan.left);
    const rightCoverage = buildSideCoverageContext(rightKind, plan.right);

    const results: DiffResult[] = [];
    let i = 0;
    for (const ks of allKeyStrings) {
      if (i % 200 === 0) signal?.throwIfAborted();
      i += 1;

      const key = leftKeys.get(ks) ?? rightKeys.get(ks)!;
      const leftSha = plan.left.cacheHitShas.get(ks);
      const rightSha = plan.right.cacheHitShas.get(ks);

      // Content-addressing fast path: both sides are cache hits pointing at
      // literally the same stored blob — guaranteed identical, no need to
      // even read the blob content or invoke the differ.
      if (leftSha && rightSha && leftSha === rightSha) {
        results.push({ key, status: 'identical', leftSha256: leftSha, rightSha256: rightSha });
        continue;
      }

      const left = leftKeys.has(ks) ? await this.resolveContent(ks, leftFresh, leftSha) : undefined;
      const right = rightKeys.has(ks) ? await this.resolveContent(ks, rightFresh, rightSha) : undefined;

      // Binary-bodied types (StaticResource, Document) never go through
      // `diffComponent` — that dispatch's non-text-body branch assumes XML
      // and would either throw or produce a meaningless parse of arbitrary
      // bytes. `resolveComponentContents` already encoded these as a
      // stable, order-independent string (see `util/binary-content.ts`), so
      // "diffing" them is exactly a hash comparison — see
      // `diffBinaryComponent` below.
      if (BINARY_BODY_TYPES.has(key.type)) {
        results.push(diffBinaryComponent(key, left, right));
        continue;
      }

      const profileContext: ProfileDiffContext | undefined = PROFILE_LIKE_TYPES.has(key.type)
        ? {
            left: coverageForProfileLike(leftCoverage, key),
            right: coverageForProfileLike(rightCoverage, key),
          }
        : undefined;

      results.push(diffComponent(key, left, right, profileContext));
    }

    return results;
  }

  private async resolveContent(
    keyString: string,
    fresh: ReadonlyMap<string, string>,
    cacheHitSha: string | undefined,
  ): Promise<string | undefined> {
    const freshContent = fresh.get(keyString);
    if (freshContent !== undefined) return freshContent;
    if (cacheHitSha) {
      const blob = await this.store.getBlob(cacheHitSha);
      return blob?.content;
    }
    return undefined;
  }
}

/**
 * The binary-type counterpart to `diff/dispatch.ts`'s `diffComponent`:
 * same four-way new/deleted/changed/identical status derivation, but by
 * content-hash equality rather than a semantic tree or line diff, since
 * `left`/`right` here are `encodeBinaryContent`'s opaque encoding (base64
 * body + metadata sidecar), not something a differ can meaningfully render
 * hunks or entries for. `binary: true` is the signal the UI needs to
 * render "binary content changed" instead of attempting a tree/line diff —
 * see the doc comment on `DiffResult.binary`.
 */
function diffBinaryComponent(key: ComponentKey, left: string | undefined, right: string | undefined): DiffResult {
  if (left === undefined && right === undefined) {
    return { key, status: 'identical', binary: true };
  }
  if (left !== undefined && right === undefined) {
    return { key, status: 'deleted', binary: true, leftSha256: sha256Hex(left) };
  }
  if (left === undefined && right !== undefined) {
    return { key, status: 'new', binary: true, rightSha256: sha256Hex(right) };
  }

  const leftSha256 = sha256Hex(left as string);
  const rightSha256 = sha256Hex(right as string);
  return {
    key,
    status: leftSha256 === rightSha256 ? 'identical' : 'changed',
    binary: true,
    leftSha256,
    rightSha256,
  };
}
