/**
 * Pure helper behind the "Select types" step's Selected/Available split.
 * Kept dependency-free so it scales the same way whether `allTypes` has
 * Phase 1's 11 entries or Phase 2's 100+.
 */
export interface TypeSelectionSplit {
  readonly selected: string[];
  readonly available: string[];
}

export function splitTypes(allTypes: readonly string[], selectedTypes: readonly string[], search = ''): TypeSelectionSplit {
  const selectedSet = new Set(selectedTypes);
  const query = search.trim().toLowerCase();

  // Preserve `allTypes` ordering for "selected" (so the list doesn't jump
  // around as items are added), and apply the search filter to "available"
  // only — searching is for finding something to add, not for hiding what's
  // already committed.
  const selected = allTypes.filter((t) => selectedSet.has(t));
  const available = allTypes.filter((t) => !selectedSet.has(t) && (!query || t.toLowerCase().includes(query)));
  return { selected, available };
}
