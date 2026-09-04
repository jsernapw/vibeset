import type { MergeEntry, MergeInput, MergeResult, MergeSummary } from '../types/merge.js';
import type { ComponentKey } from '../types/metadata-source.js';
import { decomposeGeneric } from './decompose.js';
import { resolveThreeWay, resolveTwoWay } from './resolve.js';

/**
 * Entry-level merge for any decomposable XML type OTHER than
 * Profile/PermissionSet — CustomObject (`fields`, `listViews`,
 * `recordTypes`, `validationRules`, ...) is the Workstream B priority, but
 * this is generic over anything `diff/natural-keys.ts` already knows how to
 * key, exactly like the differ itself. No retrieve-pairing coverage concept
 * applies here (see decompose.ts) — a CustomObject/Layout/etc. retrieve is
 * always a complete file for that one component, unlike Profile/
 * PermissionSet which is retrieved paired with whatever else was requested.
 */
export function mergeGeneric(key: ComponentKey, input: MergeInput): MergeResult {
  const rootType = key.type;

  if (input.mode === 'two-way') {
    const leftMap = decomposeGeneric(rootType, input.left);
    const rightMap = decomposeGeneric(rootType, input.right);
    const allKeys = new Set([...leftMap.keys(), ...rightMap.keys()]);
    const entries = [...allKeys].sort().map((compositeKey) => {
      const l = leftMap.get(compositeKey);
      const r = rightMap.get(compositeKey);
      const { path, itemKey } = (l ?? r)!;
      const { status, resolved } = resolveTwoWay(l?.value, r?.value);
      return buildEntry(path, itemKey, status, resolved, undefined, l?.value, r?.value);
    });
    return { mode: 'two-way', key, entries, summary: summarize(entries) };
  }

  const baseMap = decomposeGeneric(rootType, input.base);
  const leftMap = decomposeGeneric(rootType, input.left);
  const rightMap = decomposeGeneric(rootType, input.right);
  const allKeys = new Set([...baseMap.keys(), ...leftMap.keys(), ...rightMap.keys()]);
  const entries = [...allKeys].sort().map((compositeKey) => {
    const b = baseMap.get(compositeKey);
    const l = leftMap.get(compositeKey);
    const r = rightMap.get(compositeKey);
    const { path, itemKey } = (b ?? l ?? r)!;
    const { status, resolved } = resolveThreeWay(b?.value, l?.value, r?.value);
    return buildEntry(path, itemKey, status, resolved, b?.value, l?.value, r?.value);
  });
  return { mode: 'three-way', key, entries, summary: summarize(entries) };
}

function buildEntry(
  path: string,
  itemKey: string,
  status: MergeEntry['status'],
  resolved: unknown,
  base: unknown,
  left: unknown,
  right: unknown,
): MergeEntry {
  return { path, key: itemKey, status, base, left, right, resolved };
}

function summarize(entries: readonly MergeEntry[]): MergeSummary {
  const summary: MergeSummary = { unchanged: 0, 'take-left': 0, 'take-right': 0, conflict: 0 };
  const mutable = summary as Record<MergeEntry['status'], number>;
  for (const e of entries) mutable[e.status] += 1;
  return summary;
}
