import type { ComponentKey } from '../types/metadata-source.js';
import { planMaterializeChunks, type ChunkingOptions, type MaterializeChunkPlan } from '../retrieval/chunking.js';

/**
 * Splits a deploy-ordered `components` list into Metadata API-sized chunks
 * for deployment, reusing `retrieval/chunking.ts`'s `planMaterializeChunks`
 * directly rather than duplicating the 10,000-file / 39MB limit logic (and
 * the Profile/PermissionSet pairing rule it also enforces) — per the task
 * brief. Order within each chunk is preserved from the input, so callers
 * should pass an already-`topologicalOrder`'d list (see `order.ts`) if
 * deploy ordering matters for the package being chunked.
 */
export function planDeployChunks(components: readonly ComponentKey[], options?: ChunkingOptions): MaterializeChunkPlan {
  return planMaterializeChunks(components, options);
}
