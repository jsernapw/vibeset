import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey, MetadataSource } from '../types/metadata-source.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import type { PreDeployComponentState } from '../package/rollback.js';
import { componentKeyString } from '../util/component-key.js';
import { canonicalizeByType } from '../util/canonicalize-dispatch.js';
import { planMaterializeChunks, type ChunkingOptions } from '../retrieval/chunking.js';
import { cleanupSourceTree, resolveComponentContents } from '../compare/content-reader.js';

export interface CapturePreDeployStateParams {
  /** A `MetadataSource` (normally an `OrgSource`) pointed at the deploy TARGET — the org about to receive the deployment. */
  readonly targetSource: MetadataSource;
  /** Every key about to be touched by the deployment: `DeploymentPackage.components` ∪ `.destructiveComponents`. */
  readonly keys: readonly ComponentKey[];
  readonly store: SnapshotStore;
  readonly registry?: RegistryAccess;
  readonly chunking?: ChunkingOptions;
  readonly signal?: AbortSignal;
}

/**
 * Snapshots the deploy target's CURRENT (pre-deploy) content for every
 * component about to be touched, via the content-addressed `SnapshotStore`
 * — this is what makes rollback-package generation "nearly free" later
 * (see `ARCHITECTURE.md`): the inverse package (`package/rollback.ts`) is
 * then built purely from already-stored blobs, no re-retrieve needed.
 *
 * Must be called BEFORE the deploy actually runs. Confirms existence via a
 * cheap `inventory()` call (narrowed to the touched types) before paying
 * for a `materialize()`, so components that are genuinely new to the
 * target (no pre-deploy state to capture) are identified without an
 * unnecessary fetch.
 */
export async function capturePreDeployState(
  params: CapturePreDeployStateParams,
): Promise<Map<string, PreDeployComponentState>> {
  const registry = params.registry ?? new RegistryAccess();
  const result = new Map<string, PreDeployComponentState>();
  if (params.keys.length === 0) return result;

  const types = [...new Set(params.keys.map((k) => k.type))];
  const inventory = await params.targetSource.inventory({ types });
  params.signal?.throwIfAborted();
  const inventoryByKey = new Map(inventory.entries.map((e) => [componentKeyString(e.key), e] as const));

  const toMaterialize: ComponentKey[] = [];
  for (const key of params.keys) {
    const ks = componentKeyString(key);
    const entry = inventoryByKey.get(ks);
    if (!entry) {
      result.set(ks, { key, existed: false });
    } else {
      toMaterialize.push(entry.key);
    }
  }

  if (toMaterialize.length === 0) return result;

  const { chunks } = planMaterializeChunks(toMaterialize, params.chunking);
  const orgId = params.targetSource.kind === 'org' ? params.targetSource.id : undefined;

  for (const chunkKeys of chunks) {
    params.signal?.throwIfAborted();
    const tree = await params.targetSource.materialize(chunkKeys);
    try {
      const contents = await resolveComponentContents(tree, chunkKeys, registry);
      for (const key of chunkKeys) {
        const ks = componentKeyString(key);
        const raw = contents.get(ks);
        if (raw === undefined) {
          // Inventoried but couldn't be materialized (retrieve failure,
          // race with an out-of-band deletion) — treat as "no usable
          // pre-deploy state" rather than failing the whole capture.
          result.set(ks, { key, existed: false });
          continue;
        }
        const entry = inventoryByKey.get(ks)!;
        const canonical = canonicalizeByType(key.type, raw);
        // Always store, even for `lastModifiedDateUnknown` components
        // (Settings, CustomLabels, StandardValueSet — see
        // sources/registry.ts): rollback needs a real content-addressed
        // `sha256` regardless of whether that ref is later reusable as a
        // cache hit. Reusing the entry's own `lastModifiedDate` ('' for
        // those types) keeps the ref consistent with how the retrieval
        // planner already represents them.
        const snapshot = await params.store.put({
          sourceId: params.targetSource.id,
          key,
          lastModifiedDate: entry.lastModifiedDate,
          content: canonical,
          orgId,
        });
        result.set(ks, { key, existed: true, sha256: snapshot.sha256 });
      }
    } finally {
      await cleanupSourceTree(tree);
    }
  }

  return result;
}
