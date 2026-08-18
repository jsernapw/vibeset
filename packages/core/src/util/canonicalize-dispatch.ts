import { canonicalizeText, canonicalizeXml } from '../diff/normalize.js';
import { TEXT_BODY_TYPES } from '../diff/dispatch.js';

/**
 * Canonicalizes raw component content the same way `diff/dispatch.ts`
 * would for this type (text-body types get the text canonicalizer, every
 * other type the XML canonicalizer). Shared by `compare/` (before
 * `SnapshotStore.put()`, which stores canonical content by contract — see
 * `store/snapshot-store.ts`) and `deploy/` (pre-deploy state capture) so
 * the dispatch rule lives in exactly one place.
 */
export function canonicalizeByType(type: string, raw: string): string {
  return TEXT_BODY_TYPES.has(type) ? canonicalizeText(raw).canonicalText : canonicalizeXml(raw, type).canonicalXml;
}
