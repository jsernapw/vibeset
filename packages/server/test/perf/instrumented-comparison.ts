import {
  RetrievalPlanner,
  buildSideCoverageContext,
  coverageForProfileLike,
  resolveComponentContents,
  cleanupSourceTree,
  diffComponent,
  canonicalizeXml,
  canonicalizeText,
  TEXT_BODY_TYPES,
  componentKeyString,
  type ChunkingOptions,
  type ComponentKey,
  type DiffResult,
  type DiffStatus,
  type MetadataSource,
  type SnapshotStore,
  type SourceRetrievalPlan,
  type TypeFilter,
  type ProfileDiffContext,
} from '@vibeset/core';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { PhaseTimer } from './phase-timer.js';

const PROFILE_LIKE_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

/** Same dispatch rule `packages/core/src/util/canonicalize-dispatch.ts` uses — that helper isn't part of `@vibeset/core`'s public export surface, so this one-line rule is reproduced here rather than reaching into core's internal src path from a different package. */
function canonicalizeByType(type: string, raw: string): string {
  return TEXT_BODY_TYPES.has(type) ? canonicalizeText(raw).canonicalText : canonicalizeXml(raw, type).canonicalXml;
}

export interface InstrumentedComparisonResult {
  readonly results: DiffResult[];
  readonly summary: Record<DiffStatus, number>;
  readonly timer: PhaseTimer;
  readonly leftPlan: SourceRetrievalPlan;
  readonly rightPlan: SourceRetrievalPlan;
}

/**
 * A from-scratch reimplementation of `ComparisonEngine.run()`'s algorithm
 * (see `packages/core/src/compare/comparison-engine.ts`, read in full
 * before writing this), instrumented with a `PhaseTimer` at each of the
 * boundaries the perf brief asks for: inventory, cache planning, retrieve,
 * (convert — via `instrumented-org-source.ts`'s injected dep, folded into
 * `timer` by the caller), resolve+canonicalize+hash, diff, and persist.
 *
 * This is NOT a production code path — it exists only so Livia can measure
 * without modifying `comparison-engine.ts`, which she does not own and was
 * asked not to touch silently. It is built entirely from that file's own
 * PUBLIC building blocks (`RetrievalPlanner`, `MetadataSource.materialize`,
 * `resolveComponentContents`, `canonicalizeXml`/`canonicalizeText`,
 * `diffComponent`, `SnapshotStore`) — same algorithm, same content-addressing
 * fast path, same Profile/PermissionSet coverage handling — with
 * `performance.now()` wrapped around each step instead of the terse 0-100
 * progress percentage `ComparisonEngine` reports to the UI.
 *
 * Concurrency note: like `ComparisonEngine.fetchAndCache`, this loops
 * sequentially across `RetrievalPlanner`-level chunks — that matches
 * production exactly (`comparison-engine.ts` does the same outer-loop
 * sequencing). `OrgSource.materialize()` itself is called as a whole per
 * chunk, so its OWN internal bounded concurrency (`retrieveConcurrency`,
 * default 3, across its own sub-chunking) still applies unmodified. The one
 * timing artifact worth naming: `performance.now()` around an `await`
 * measures wall time for THAT call only — if a future change makes
 * `ComparisonEngine` fan out across `plan.chunks` themselves (it does not
 * today), this harness's phase numbers would need re-checking against it.
 */
export async function runInstrumentedComparison(
  left: MetadataSource,
  right: MetadataSource,
  store: SnapshotStore,
  options: { filter: TypeFilter; chunking?: ChunkingOptions; timer?: PhaseTimer },
): Promise<InstrumentedComparisonResult> {
  const timer = options.timer ?? new PhaseTimer();
  const planner = new RetrievalPlanner(store);

  const leftPlan = await planSide(planner, left, options.filter, options.chunking, timer);
  const rightPlan = await planSide(planner, right, options.filter, options.chunking, timer);

  const leftFresh = await fetchAndCache(left, leftPlan, store, timer);
  const rightFresh = await fetchAndCache(right, rightPlan, store, timer);

  const { results, summary } = await diffAll(left.kind, right.kind, leftPlan, rightPlan, leftFresh, rightFresh, store, timer);

  return { results, summary, timer, leftPlan, rightPlan };
}

/**
 * Splits `RetrievalPlanner.planSource`'s single call into "inventory" vs.
 * "cache planning" using the SAME progress-message boundaries
 * `RetrievalPlanner` already emits for its own UI progress bar (`emit(0,
 * 'Inventorying...')` before `source.inventory()`, `emit(40, 'Inventoried
 * N...; checking cache...')` right after it returns, `emit(100, 'Plan
 * ready...')` at the end) — a designed, public extension point
 * (`PlanRetrievalOptions.onProgress`), not a hack. The gap between the 0%
 * and 40% messages is pure `source.inventory()` wall time; the gap between
 * 40% and 100% is the cache-lookup loop (`store.lookup()` per component,
 * which `persistSnapshots`'s store-wrapping in `fetchAndCache` below does
 * NOT cover — this is genuinely separate work) plus chunk planning.
 */
async function planSide(
  planner: RetrievalPlanner,
  source: MetadataSource,
  filter: TypeFilter,
  chunking: ChunkingOptions | undefined,
  timer: PhaseTimer,
): Promise<SourceRetrievalPlan> {
  let inventoryStart = 0;
  let cachePlanningStart = 0;
  let inventoryDone = false;
  let cachePlanningDone = false;
  return planner.planSource(source, {
    filter,
    chunking,
    onProgress: (p) => {
      const now = performance.now();
      // Disambiguate by MESSAGE, not percent: `planSource`'s own cache-check
      // loop can coincidentally emit percent===40 again at i=0 (its formula
      // is `40 + round(i/total*40)`, which is exactly 40 when i===0) — the
      // same percent `planSource` uses for its real "inventory done, now
      // checking cache" transition. Percent alone is ambiguous whenever the
      // very first inventoried entry is a fresh miss; the message text
      // ("Inventoried N...checking cache" vs. "Checked cache for i/N...")
      // is not. Each transition is also guarded to fire exactly once, since
      // `planSource` may reach percent 40 or 100 more than once in principle.
      if (!inventoryDone && p.percent === 0) {
        inventoryStart = now;
      } else if (!inventoryDone && p.message.startsWith('Inventoried ')) {
        timer.add('inventory', now - inventoryStart);
        cachePlanningStart = now;
        inventoryDone = true;
      } else if (inventoryDone && !cachePlanningDone && p.percent === 100) {
        timer.add('cachePlanning', now - cachePlanningStart);
        cachePlanningDone = true;
      }
    },
  });
}

async function fetchAndCache(
  source: MetadataSource,
  plan: SourceRetrievalPlan,
  store: SnapshotStore,
  timer: PhaseTimer,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (plan.toFetch.length === 0) return contents;

  const dateByKey = new Map(plan.entries.map((e) => [componentKeyString(e.key), e] as const));
  const orgId = source.kind === 'org' ? source.id : undefined;

  for (const chunkKeys of plan.chunks) {
    // For OrgSource, `materialize()` internally calls the harness's
    // injected `retrieveAndConvert` (see instrumented-org-source.ts), which
    // records 'retrieve'/'convert' into THIS SAME timer directly — so for
    // org sources the wrapping below double-counts into a generic
    // 'retrieve' bucket only when the source is NOT an instrumented
    // OrgSource (e.g. SfdxProjectSource, which has no separate convert
    // step: it is already source format on disk, so 'retrieve' here IS the
    // whole materialize cost for that source kind).
    const tree =
      source.kind === 'org'
        ? await source.materialize(chunkKeys)
        : await timer.time('retrieve', () => source.materialize(chunkKeys));
    try {
      const resolved = await timer.time('resolveContent', () =>
        resolveComponentContents(tree, chunkKeys, getRegistryFor(source)),
      );
      for (const [ks, raw] of resolved) {
        contents.set(ks, raw);
        const entry = dateByKey.get(ks);
        if (entry && !entry.lastModifiedDateUnknown) {
          const canonical = await timer.time('canonicalizeHash', () => canonicalizeByType(entry.key.type, raw));
          await timer.time('persistSnapshots', () =>
            store.put({ sourceId: source.id, key: entry.key, lastModifiedDate: entry.lastModifiedDate, content: canonical, orgId }),
          );
        }
      }
    } finally {
      await cleanupSourceTree(tree);
    }
  }

  return contents;
}

// resolveComponentContents needs a RegistryAccess; @vibeset/core doesn't
// expose one per-source (it's private to each MetadataSource), and building
// a second RegistryAccess instance is deliberately cheap/side-effect-free
// (SDR itself does this per-call in several places) — cheaper than plumbing
// one through every call site just for this harness.
const sharedRegistry = new RegistryAccess();
function getRegistryFor(_source: MetadataSource): RegistryAccess {
  return sharedRegistry;
}

async function diffAll(
  leftKind: MetadataSource['kind'],
  rightKind: MetadataSource['kind'],
  leftPlan: SourceRetrievalPlan,
  rightPlan: SourceRetrievalPlan,
  leftFresh: ReadonlyMap<string, string>,
  rightFresh: ReadonlyMap<string, string>,
  store: SnapshotStore,
  timer: PhaseTimer,
): Promise<{ results: DiffResult[]; summary: Record<DiffStatus, number> }> {
  const leftKeys = new Map<string, ComponentKey>();
  for (const e of leftPlan.entries) leftKeys.set(componentKeyString(e.key), e.key);
  const rightKeys = new Map<string, ComponentKey>();
  for (const e of rightPlan.entries) rightKeys.set(componentKeyString(e.key), e.key);

  const allKeyStrings = new Set<string>([...leftKeys.keys(), ...rightKeys.keys()]);

  const leftCoverage = buildSideCoverageContext(leftKind, leftPlan);
  const rightCoverage = buildSideCoverageContext(rightKind, rightPlan);

  const results: DiffResult[] = [];
  for (const ks of allKeyStrings) {
    const key = leftKeys.get(ks) ?? rightKeys.get(ks)!;
    const leftSha = leftPlan.cacheHitShas.get(ks);
    const rightSha = rightPlan.cacheHitShas.get(ks);

    if (leftSha && rightSha && leftSha === rightSha) {
      results.push({ key, status: 'identical', leftSha256: leftSha, rightSha256: rightSha });
      continue;
    }

    const left = leftKeys.has(ks) ? await resolveContent(ks, leftFresh, leftSha, store) : undefined;
    const right = rightKeys.has(ks) ? await resolveContent(ks, rightFresh, rightSha, store) : undefined;

    const profileContext: ProfileDiffContext | undefined = PROFILE_LIKE_TYPES.has(key.type)
      ? { left: coverageForProfileLike(leftCoverage, key), right: coverageForProfileLike(rightCoverage, key) }
      : undefined;

    const result = await timer.time('diff', () => diffComponent(key, left, right, profileContext));
    results.push(result);
  }

  const summary: Record<DiffStatus, number> = { new: 0, changed: 0, deleted: 0, identical: 0 };
  for (const r of results) summary[r.status] += 1;

  return { results, summary };
}

async function resolveContent(
  keyString: string,
  fresh: ReadonlyMap<string, string>,
  cacheHitSha: string | undefined,
  store: SnapshotStore,
): Promise<string | undefined> {
  const freshContent = fresh.get(keyString);
  if (freshContent !== undefined) return freshContent;
  if (cacheHitSha) {
    const blob = await store.getBlob(cacheHitSha);
    return blob?.content;
  }
  return undefined;
}
