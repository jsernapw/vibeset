import { create } from 'zustand';
import type { ComponentKey } from '@vibeset/core';

export function componentKeyToString(key: ComponentKey): string {
  return key.parentFullName ? `${key.type}::${key.parentFullName}::${key.fullName}` : `${key.type}::${key.fullName}`;
}

export type TriState = 'checked' | 'unchecked' | 'indeterminate';

interface SelectionState {
  /** Selected leaf (component) keys, as `componentKeyToString` strings. */
  selected: Set<string>;
  /** The comparisonId this selection currently belongs to, if any — see `ensureComparison`. */
  activeComparisonId: string | null;
  toggleLeaf: (keyStr: string) => void;
  setLeaf: (keyStr: string, checked: boolean) => void;
  /** Sets every key in `keyStrs` to `checked` in one update — used for group (type-header) checkbox clicks. */
  setGroup: (keyStrs: string[], checked: boolean) => void;
  clear: () => void;
  replaceAll: (keyStrs: string[]) => void;
  /**
   * Call on mount of the comparison results page with the current
   * comparisonId. Clears the selection only when it's genuinely a
   * *different* comparison than last time — NOT on every remount of the
   * same comparisonId. Without this guard, navigating away (e.g. to the
   * deploy step) and back with the browser's Back button remounts the
   * results page and would silently wipe a large in-progress selection,
   * which is exactly the "lost my 50k-component selection" bug this store
   * exists to avoid.
   */
  ensureComparison: (comparisonId: string) => void;
}

/**
 * Selection state over the comparison results tree. Deliberately a lean
 * Zustand store rather than React context: comparisons routinely exceed
 * 50k components, and re-rendering a context-subscribed tree on every
 * checkbox click would be a real perf problem at that scale. Components
 * read via the `useSelected(keyStr)` / `useGroupTriState(keyStrs)`
 * selector hooks below so only the rows that actually changed re-render.
 */
export const useSelectionStore = create<SelectionState>((set, get) => ({
  selected: new Set(),
  activeComparisonId: null,
  ensureComparison: (comparisonId) => {
    if (get().activeComparisonId === comparisonId) return;
    set({ selected: new Set(), activeComparisonId: comparisonId });
  },
  toggleLeaf: (keyStr) => {
    const next = new Set(get().selected);
    if (next.has(keyStr)) next.delete(keyStr);
    else next.add(keyStr);
    set({ selected: next });
  },
  setLeaf: (keyStr, checked) => {
    const next = new Set(get().selected);
    if (checked) next.add(keyStr);
    else next.delete(keyStr);
    set({ selected: next });
  },
  setGroup: (keyStrs, checked) => {
    const next = new Set(get().selected);
    for (const k of keyStrs) {
      if (checked) next.add(k);
      else next.delete(k);
    }
    set({ selected: next });
  },
  clear: () => set({ selected: new Set() }),
  replaceAll: (keyStrs) => set({ selected: new Set(keyStrs) }),
}));

/** Subscribes only to whether one specific leaf is selected. */
export function useIsSelected(keyStr: string): boolean {
  return useSelectionStore((s) => s.selected.has(keyStr));
}

/** Subscribes only to the selected count — cheap to recompute, fine to run on every store change. */
export function useSelectedCount(): number {
  return useSelectionStore((s) => s.selected.size);
}

/** Tri-state for a group (e.g. a metadata-type header) given its full member list. Not a hook — call from a memoized selector or component body with useMemo/useSelectionStore as needed. */
export function computeGroupTriState(selected: ReadonlySet<string>, keyStrs: readonly string[]): TriState {
  if (keyStrs.length === 0) return 'unchecked';
  let selectedCount = 0;
  for (const k of keyStrs) if (selected.has(k)) selectedCount++;
  if (selectedCount === 0) return 'unchecked';
  if (selectedCount === keyStrs.length) return 'checked';
  return 'indeterminate';
}
