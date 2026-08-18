import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { sha256Hex } from '../hash.js';
import {
  computeItemKey,
  KNOWN_COLLECTION_TAGS,
  resolveCollectionKeyFields,
} from './natural-keys.js';

/**
 * The canonicalizer: turns metadata XML into a form where semantically
 * identical content always produces the same string (and therefore the
 * same sha256), regardless of superficial XML differences that carry no
 * meaning. This is the main performance lever in the whole comparison
 * engine — equal hash short-circuits a component straight to `identical`
 * with zero further work (see diff/dispatch.ts).
 *
 * Property this module must uphold, checked by property-based tests in
 * test/diff/normalize.property.test.ts: for a given semantic document,
 * arbitrary element reordering and whitespace/entity/line-ending
 * perturbation must never change the resulting hash.
 */

/** Property name fast-xml-parser stores CDATA text under. CDATA content is preserved (not merged into plain text) so `<![CDATA[...]]>` round-trips faithfully instead of being silently flattened. */
export const CDATA_PROP_NAME = '__cdata';
/** Property name fast-xml-parser stores comment text under. Comments are parsed under this name and then deliberately dropped by `stripVolatileAndSort` — see the note below. */
export const COMMENT_PROP_NAME = '__comment';

const ATTRIBUTE_PREFIX = '@_';

/**
 * Fields that are audit/provenance metadata, not configuration a user
 * authored. If Salesforce ever emits these in a metadata type's XML (they
 * are not present in the common Phase 1 types today, but the task brief
 * calls them out explicitly and future metadata types may include them),
 * they must never affect the diff or the hash: two orgs will never agree
 * on who last touched a component or when, and that disagreement carries
 * no configuration meaning. Stripping a field that never actually occurs
 * is a safe no-op; that's why this list is applied unconditionally at
 * every nesting depth rather than gated to specific types.
 *
 * Deliberately NOT included: `apiVersion`. See the judgement-call note in
 * ARCHITECTURE-adjacent docs / the final report — API version can be a
 * genuine, intentional change (recompiling against a newer API version
 * changes runtime behavior), so silently hiding it would be exactly the
 * "stripping something meaningful" correctness bug the brief warns against.
 * It is left in place and diffs normally.
 */
const VOLATILE_FIELD_NAMES = new Set([
  'createdDate',
  'createdById',
  'createdByName',
  'lastModifiedDate',
  'lastModifiedById',
  'lastModifiedByName',
]);

function isArrayTag(tagName: string): boolean {
  return KNOWN_COLLECTION_TAGS.has(tagName);
}

function buildParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    cdataPropName: CDATA_PROP_NAME,
    commentPropName: COMMENT_PROP_NAME,
    // Every value stays a string. Salesforce metadata mixes booleans,
    // numbers, and number-shaped picklist/text values in the same schema
    // position across different fields; auto-coercion (strnum) is a source
    // of subtle type mismatches between otherwise-identical documents.
    // Comparing everything as raw strings sidesteps that whole class of bug.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true, // trims insignificant whitespace around element text; never collapses internal newlines within multi-line values (formulas, descriptions) — see file header.
    processEntities: true, // decodes &#39; / &apos; / etc. uniformly so both forms parse to the same character.
    htmlEntities: false,
    ignoreDeclaration: true,
    isArray: (tagName) => isArrayTag(tagName),
  });
}

function buildBuilder(): XMLBuilder {
  return new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    cdataPropName: CDATA_PROP_NAME,
    format: true,
    indentBy: '    ',
    suppressEmptyNode: false,
    processEntities: true,
  });
}

/**
 * Parses metadata XML into fast-xml-parser's object shape. Line endings are
 * normalized to `\n` BEFORE parsing (not just around tags) because a
 * multi-line text value (a formula, a description) carries CRLF/LF as part
 * of its literal string content — normalizing only inter-tag whitespace
 * would still leave Windows-authored source producing a different hash
 * than the same content retrieved from an org.
 */
export function parseXml(xml: string): Record<string, unknown> {
  const normalized = xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return buildParser().parse(normalized) as Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Single recursive pass used by BOTH the canonicalizer (for hashing) and
 * the differ (for comparison), so they can never disagree about what
 * counts as "the same". It:
 *   1. Drops volatile audit fields and XML comments at any depth.
 *   2. Sorts every object's keys alphabetically.
 *   3. Sorts every array's items by their natural key (see natural-keys.ts).
 *
 * `rootType` is the metadata type name (e.g. `CustomObject`), constant
 * across the whole recursive walk — natural-key lookups are keyed on
 * (rootType, immediate tag name), not on full nesting depth, which is
 * sufficient because Salesforce doesn't reuse ambiguous tag names within a
 * single type's schema (only across different types — see Flow's `fields`
 * override in natural-keys.ts).
 */
export function stripVolatileAndSort(rootType: string, tagName: string, value: unknown): unknown {
  if (isPlainObject(value) && Object.keys(value).length === 1 && CDATA_PROP_NAME in value) {
    // A `<![CDATA[...]]>` leaf and an equivalent entity-escaped plain-text
    // leaf are the same semantic content with a different XML escaping
    // mechanism — CDATA is common in hand-authored source (LWC config,
    // hand-edited Flows) but Salesforce's own Metadata API retrieve does
    // not emit it. Without this, comparing an org retrieval against a
    // hand-edited local file would report a phantom diff on every
    // CDATA-wrapped field. Unwrapping to a plain string here converges
    // both forms to one canonical representation (the builder re-escapes
    // it as ordinary text either way). The differ makes the same call via
    // `unwrapCdata` in natural-keys.ts — kept in sync deliberately.
    return (value as Record<string, unknown>)[CDATA_PROP_NAME];
  }

  if (Array.isArray(value)) {
    const keyFields = resolveCollectionKeyFields(rootType, tagName);
    const cleanedItems = value.map((item) => stripVolatileAndSort(rootType, tagName, item));
    const withKeys = cleanedItems.map(
      (item) => [computeItemKey(item, keyFields).sortKey, item] as const,
    );
    withKeys.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return withKeys.map(([, item]) => item);
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => !VOLATILE_FIELD_NAMES.has(k) && k !== COMMENT_PROP_NAME)
      .sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = stripVolatileAndSort(rootType, k, value[k]);
    }
    return out;
  }

  return value;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

export interface CanonicalizeResult {
  /** Deterministic, whitespace/order/encoding-normalized XML. Semantically identical input always produces byte-identical output. This is what gets sha256'd and what `ComponentSnapshot.content` stores. */
  readonly canonicalXml: string;
  readonly sha256: string;
  /** The cleaned+sorted parse tree, exposed for callers that want it (e.g. the differ reuses `stripVolatileAndSort` directly rather than re-parsing the canonical XML string). */
  readonly tree: Record<string, unknown>;
}

/**
 * Canonicalizes one XML metadata file and hashes the result. `rootType` is
 * the Salesforce metadata type name (used only for natural-key lookups —
 * see natural-keys.ts). Equal `sha256` between two canonicalizations means
 * the two documents are semantically identical; callers should treat that
 * as license to skip the (expensive) tree differ entirely.
 */
export function canonicalizeXml(xml: string, rootType: string): CanonicalizeResult {
  const parsed = parseXml(xml);
  const cleaned = stripVolatileAndSort(rootType, '', parsed) as Record<string, unknown>;
  const body = buildBuilder().build(cleaned) as string;
  const canonicalXml = XML_DECLARATION + body.replace(/\r\n/g, '\n').trimEnd() + '\n';
  return { canonicalXml, sha256: sha256Hex(canonicalXml), tree: cleaned };
}

/**
 * Canonicalization for opaque text bodies (Apex, LWC/Aura JS/HTML/CSS, VF).
 * There is no structural schema to reorder, so this only normalizes the two
 * genuinely volatile-but-meaningless dimensions of a text file: line
 * endings, and a single trailing newline at EOF (a near-universal source of
 * noise between editors/OSes that carries no semantic weight in any of
 * these languages). Internal whitespace is left untouched deliberately —
 * indentation and blank lines can be meaningful (or at least are a real
 * authored choice) in source code in a way they never are in generated XML,
 * so this canonicalizer does not attempt to "clean up" code formatting.
 */
export function canonicalizeText(text: string): { canonicalText: string; sha256: string } {
  const canonicalText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '\n');
  return { canonicalText, sha256: sha256Hex(canonicalText) };
}
