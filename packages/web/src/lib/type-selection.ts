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

/**
 * Phase 2 variant of `splitTypes` for the curated-33-vs-all-418 picker
 * (`TypeFilterPanel`): "Selected" is always resolved against the FULL
 * universe (`allTypes`), never the narrower curated/scope list — so a
 * component picked while browsing "All types" still shows up in Selected
 * after switching back to the default "Common" scope, exactly like search
 * never hides an already-selected item in the original `splitTypes`.
 * "Available" is resolved against whichever list (`scopeTypes`) is
 * currently active — the curated ~33 by default, or the full ~418 when the
 * user has explicitly asked to browse everything.
 *
 * `unknown` handles the edge case where `selectedTypes` (from the wizard's
 * persisted flow state) contains a name that isn't in `allTypes` — e.g. a
 * saved filter set from before a registry change. Rather than silently
 * dropping it from "Selected" (which would understate what a comparison is
 * actually about to run), it's appended at the end so it stays visible and
 * removable.
 */
export function splitTypesForScope(params: {
  readonly allTypes: readonly string[];
  readonly scopeTypes: readonly string[];
  readonly selectedTypes: readonly string[];
  readonly search?: string;
}): TypeSelectionSplit {
  const { allTypes, scopeTypes, selectedTypes, search = '' } = params;
  const allSet = new Set(allTypes);
  const selectedSet = new Set(selectedTypes);
  const query = search.trim().toLowerCase();

  const known = allTypes.filter((t) => selectedSet.has(t));
  const unknown = selectedTypes.filter((t) => !allSet.has(t));
  const selected = [...known, ...unknown];
  const available = scopeTypes.filter((t) => !selectedSet.has(t) && (!query || t.toLowerCase().includes(query)));
  return { selected, available };
}

/**
 * Decides whether the types step should auto-apply the curated default
 * selection, pulled out of `routes/comparisons.new.types.tsx` so the
 * decision is testable without React/TanStack Router. Returns the types to
 * apply, or `null` for "do nothing" — kept as a distinct case from
 * "apply an empty array" so the caller never confuses "not ready yet" /
 * "already initialized" with "apply zero types".
 *
 * Rules, in order:
 *  1. Already initialized this wizard pass (the user has set — possibly to
 *     empty via "Clear all" — a selection already) -> never override it.
 *  2. `defaultTypes` not loaded yet (`availableTypes` query still pending)
 *     -> nothing to apply yet.
 *  3. Otherwise -> apply the curated default, verbatim.
 */
export function resolveDefaultTypeSelection(params: {
  readonly typesInitialized: boolean;
  readonly defaultTypes: readonly string[] | undefined;
}): string[] | null {
  if (params.typesInitialized) return null;
  if (!params.defaultTypes) return null;
  return [...params.defaultTypes];
}
