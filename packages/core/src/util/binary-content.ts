/**
 * Binary-bodied metadata types: their real "content" is an arbitrary byte
 * sequence (zip, image, PDF, ...), not text/XML. Reading that with
 * `readFile(path, 'utf8')` — what the rest of the compare pipeline does for
 * every other type — corrupts it (multi-byte sequences get replaced/merged
 * on decode) and produces a meaningless diff and a hash that doesn't
 * actually identify the content. See `compare/content-reader.ts` (which
 * resolves the raw bytes for these types instead) and
 * `compare/comparison-engine.ts` (which compares them by content hash
 * rather than routing them through the XML/text differ).
 *
 * Both are `mixedContent`-strategy types in SDR's registry: a body file of
 * arbitrary extension (`StaticResource`: `.resource`/`.zip`/`.png`/...;
 * `Document`: whatever extension the uploaded file had) plus a
 * `-meta.xml` sidecar (contentType, cacheControl, folder, ...).
 */
export const BINARY_BODY_TYPES: ReadonlySet<string> = new Set(['StaticResource', 'Document']);

/**
 * The stable string representation used to store and hash a binary
 * component's content: the exact body bytes (base64-encoded, so they
 * survive the string-keyed `Map<string, string>` contract the rest of the
 * pipeline already uses) plus its metadata sidecar as plain text, so a
 * contentType-only change (body identical, sidecar different) and a
 * body-only change are both detected — hashing the body alone would miss
 * the former.
 *
 * Property order is fixed (`bodyBase64` then `metaXml`) so identical inputs
 * always produce an identical string, and therefore an identical sha256 —
 * required for the content-addressed `SnapshotStore` to dedupe correctly.
 */
export function encodeBinaryContent(bodyBase64: string, metaXml: string): string {
  return JSON.stringify({ bodyBase64, metaXml });
}
