import type { Component, ComponentFile } from '../types/analyzer.js';
import { parseXml } from '../diff/normalize.js';
import { unwrapRoot } from '../diff/differ.js';
import { unwrapCdata } from '../diff/natural-keys.js';

/** Every file materialized for `c` — the primary file plus any `auxFiles`. */
export function allFiles(c: Component): readonly ComponentFile[] {
  return [{ path: c.path, content: c.content }, ...(c.auxFiles ?? [])];
}

/** The first file (primary or aux) whose path ends with `suffix`, e.g. `'-meta.xml'`. */
export function fileWithSuffix(c: Component, suffix: string): ComponentFile | undefined {
  return allFiles(c).find((f) => f.path.endsWith(suffix));
}

/**
 * Best-effort XML parse of a component file, unwrapped past the root tag
 * (`{ApexClass: {...}} -> {...}`) so rule code reads fields directly.
 * Returns `undefined` for content that isn't well-formed XML (an Apex
 * `.cls` body, an LWC `.js` file) rather than throwing — callers that only
 * care about XML-shaped types should already be filtering via `appliesTo`,
 * but this stays defensive so one malformed file can't crash a whole run.
 */
export function parseComponentXml(content: string): Record<string, unknown> | undefined {
  try {
    return unwrapRoot(parseXml(content));
  } catch {
    return undefined;
  }
}

/** Normalizes a possibly-single, possibly-array, possibly-absent field into an array. Mirrors the shape `fast-xml-parser` produces for repeated elements (see `diff/natural-keys.ts`'s `KNOWN_COLLECTION_TAGS`), so callers don't need an `Array.isArray` check at every call site. */
export function arrayOf<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}

/** Unwraps CDATA (`{__cdata: "..."}`) and stringifies a leaf XML value, or `undefined` if absent. */
export function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const unwrapped = unwrapCdata(value);
  if (unwrapped === undefined || unwrapped === null) return undefined;
  if (typeof unwrapped === 'object') return undefined;
  return String(unwrapped);
}

/** `textOf`, defaulting to `''` — convenient for `.includes`/regex scanning where "absent" and "empty" are handled identically. */
export function textOfOr(value: unknown, fallback = ''): string {
  return textOf(value) ?? fallback;
}
