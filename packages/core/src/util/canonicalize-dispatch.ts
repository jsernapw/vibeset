import { canonicalizeText, canonicalizeXml } from '../diff/normalize.js';
import { TEXT_BODY_TYPES } from '../diff/dispatch.js';
import { BINARY_BODY_TYPES } from './binary-content.js';

/**
 * Canonicalizes raw component content the same way `diff/dispatch.ts`
 * would for this type (text-body types get the text canonicalizer, every
 * other type the XML canonicalizer) — EXCEPT `BINARY_BODY_TYPES`
 * (`StaticResource`, `Document`), which are returned unchanged. "Canonical
 * form" for whitespace/element-order-insensitive XML or CRLF-insensitive
 * text doesn't apply to an opaque byte sequence: `compare/content-reader.ts`
 * already produces a stable, order-independent encoding for these
 * (`encodeBinaryContent`), so running it through `canonicalizeXml` would
 * both be meaningless (it isn't XML) and, in practice, throw on invalid
 * markup. Shared by `compare/` (before `SnapshotStore.put()`, which stores
 * canonical content by contract — see `store/snapshot-store.ts`) and
 * `deploy/` (pre-deploy state capture) so the dispatch rule lives in
 * exactly one place.
 */
export function canonicalizeByType(type: string, raw: string): string {
  if (BINARY_BODY_TYPES.has(type)) return raw;
  return TEXT_BODY_TYPES.has(type) ? canonicalizeText(raw).canonicalText : canonicalizeXml(raw, type).canonicalXml;
}
