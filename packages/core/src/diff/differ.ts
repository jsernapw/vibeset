import type { DiffEntry, DiffStatus } from '../types/diff.js';
import { COMMENT_PROP_NAME, parseXml, stripVolatileAndSort } from './normalize.js';
import { computeItemKey, resolveCollectionKeyFields, unwrapCdata } from './natural-keys.js';

/**
 * The semantic tree differ. Produces `DiffEntry` trees keyed on Salesforce's
 * natural keys (see natural-keys.ts) — never array position — so a
 * reordered collection registers as no change.
 *
 * Both sides are run through the exact same `stripVolatileAndSort` pass
 * `normalize.ts` uses for hashing, which guarantees an important invariant
 * the fixture suite checks directly: if two documents hash equal, this
 * differ finds zero changes for them, and if they hash different, this
 * differ finds at least one. They cannot disagree, because they share the
 * one cleaning function.
 *
 * `entries` returned here include identical nodes, not just changed ones.
 * That's deliberate: `DiffEntry.status` explicitly allows `'identical'`,
 * and profiles.ts (built on top of this file) needs a full, individually
 * addressable grid — including unchanged rows — so the UI can render every
 * permission as its own selectable line rather than only the deltas.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSemanticKey(k: string): boolean {
  return !k.startsWith('@_') && k !== COMMENT_PROP_NAME;
}

function joinPath(parent: string, segment: string): string {
  return parent ? `${parent}.${segment}` : segment;
}

function semanticKeys(left: unknown, right: unknown): string[] {
  const keys = new Set<string>();
  if (isPlainObject(left)) for (const k of Object.keys(left)) if (isSemanticKey(k)) keys.add(k);
  if (isPlainObject(right)) for (const k of Object.keys(right)) if (isSemanticKey(k)) keys.add(k);
  return [...keys].sort();
}

function aggregateStatus(children: readonly DiffEntry[]): DiffStatus {
  if (children.length === 0) return 'identical';
  return children.every((c) => c.status === 'identical') ? 'identical' : 'changed';
}

/** True when a value should be treated as a keyed collection: either the tag is a table-known collection, or the runtime shape is an array on either side. The runtime-shape check is a safety net for collections outside the natural-keys table (or a single-vs-multi-element shape mismatch the parser's `isArray` forcing didn't cover). */
function isCollectionLike(left: unknown, right: unknown): boolean {
  return Array.isArray(left) || Array.isArray(right);
}

/** Normalizes a possibly-absent, possibly-singular value into an array for collection matching — the same single-element XML gotcha the canonicalizer's `isArray` option guards against, handled again here defensively. */
function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarValueOf(v: unknown): unknown {
  return unwrapCdata(v);
}

function isScalar(v: unknown): boolean {
  const u = scalarValueOf(v);
  return !isPlainObject(u) && !Array.isArray(u);
}

function diffScalar(path: string, key: string, left: unknown, right: unknown): DiffEntry {
  const l = scalarValueOf(left);
  const r = scalarValueOf(right);
  if (l === undefined && r !== undefined)
    return { path, key, status: 'new', before: undefined, after: r };
  if (r === undefined && l !== undefined)
    return { path, key, status: 'deleted', before: l, after: undefined };
  const status: DiffStatus = l === r ? 'identical' : 'changed';
  return { path, key, status, before: l, after: r };
}

/** Diffs a structural (non-collection) object node — either a nested property, or one already-key-matched collection item. */
function diffObject(
  path: string,
  key: string,
  left: unknown,
  right: unknown,
  rootType: string,
): DiffEntry {
  if (left === undefined && right !== undefined)
    return { path, key, status: 'new', before: undefined, after: right };
  if (right === undefined && left !== undefined)
    return { path, key, status: 'deleted', before: left, after: undefined };

  const props = semanticKeys(left, right);
  const leftObj = isPlainObject(left) ? left : {};
  const rightObj = isPlainObject(right) ? right : {};
  const children = props.map((p) => diffNode(path, p, leftObj[p], rightObj[p], rootType));
  const status = aggregateStatus(children);
  return status === 'identical'
    ? { path, key, status, before: left, after: right }
    : { path, key, status, children };
}

function diffCollection(
  path: string,
  tagName: string,
  left: unknown,
  right: unknown,
  rootType: string,
): DiffEntry {
  const keyFields = resolveCollectionKeyFields(rootType, tagName);
  const leftArr = asArray(left);
  const rightArr = asArray(right);

  // sortKey namespaces by kind (never collides across a "key:"/"hash:"/"scalar:"
  // match) and is stable for ordering; displayKey is the human-meaningful
  // natural key used for `DiffEntry.key` / `path` — see natural-keys.ts.
  const leftByKey = new Map<string, { value: unknown; displayKey: string }>();
  for (const item of leftArr) {
    const k = computeItemKey(item, keyFields);
    leftByKey.set(k.sortKey, { value: item, displayKey: k.displayKey });
  }
  const rightByKey = new Map<string, { value: unknown; displayKey: string }>();
  for (const item of rightArr) {
    const k = computeItemKey(item, keyFields);
    rightByKey.set(k.sortKey, { value: item, displayKey: k.displayKey });
  }

  const allSortKeys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const children = allSortKeys.map((sortKey) => {
    const l = leftByKey.get(sortKey);
    const r = rightByKey.get(sortKey);
    const itemKey = (l ?? r)!.displayKey;
    const itemPath = joinPath(path, itemKey);
    const lv = l?.value;
    const rv = r?.value;
    if (isScalar(lv) && isScalar(rv)) {
      return diffScalar(itemPath, itemKey, lv, rv);
    }
    return diffObject(itemPath, itemKey, lv, rv, rootType);
  });

  const status = aggregateStatus(children);
  return { path, key: tagName, status, children };
}

function diffNode(
  parentPath: string,
  tagName: string,
  left: unknown,
  right: unknown,
  rootType: string,
): DiffEntry {
  const path = joinPath(parentPath, tagName);
  if (isCollectionLike(left, right)) {
    return diffCollection(path, tagName, left, right, rootType);
  }
  if (isScalar(left) && isScalar(right)) {
    return diffScalar(path, tagName, left, right);
  }
  return diffObject(path, tagName, left, right, rootType);
}

/**
 * Diffs two already-parsed component roots (the value under the single
 * root-tag key fast-xml-parser produces — see `unwrapRoot`) and returns the
 * top-level `DiffEntry[]` for `DiffResult.entries`. `rootType` drives
 * natural-key resolution (see natural-keys.ts).
 */
export function diffComponentTree(
  rootType: string,
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): DiffEntry[] {
  const props = semanticKeys(left ?? {}, right ?? {});
  const l = left ?? {};
  const r = right ?? {};
  return props.map((p) => diffNode('', p, l[p], r[p], rootType));
}

/** Unwraps fast-xml-parser's `{ [rootTag]: {...} }` shape to the inner component object. Falls back to the parsed value itself if it doesn't have exactly the expected single-key wrapper shape (defensive; should not happen for well-formed metadata XML). */
export function unwrapRoot(parsed: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(parsed);
  if (keys.length === 1 && isPlainObject(parsed[keys[0]!])) {
    return parsed[keys[0]!] as Record<string, unknown>;
  }
  return parsed;
}

/**
 * Full XML-string-to-XML-string diff for one component: parses, strips
 * volatile fields (same pass the canonicalizer uses), and diffs. Returns
 * `undefined` entries when both sides are absent.
 */
export function diffXml(
  rootType: string,
  leftXml: string | undefined,
  rightXml: string | undefined,
): DiffEntry[] {
  const leftClean =
    leftXml === undefined
      ? undefined
      : (stripVolatileAndSort(rootType, '', parseXml(leftXml)) as Record<string, unknown>);
  const rightClean =
    rightXml === undefined
      ? undefined
      : (stripVolatileAndSort(rootType, '', parseXml(rightXml)) as Record<string, unknown>);
  return diffComponentTree(
    rootType,
    leftClean === undefined ? undefined : unwrapRoot(leftClean),
    rightClean === undefined ? undefined : unwrapRoot(rightClean),
  );
}

/** True if every entry in a tree (recursively) is `identical`. Used to sanity-check the hash-equality short-circuit invariant in tests. */
export function isAllIdentical(entries: readonly DiffEntry[]): boolean {
  return entries.every(
    (e) => e.status === 'identical' && (!e.children || isAllIdentical(e.children)),
  );
}
