import type { MergeEntry, MergeEntryStatus, MergeMode } from '@vibeset/core';

/**
 * Pure, framework-free logic behind the merge conflict-resolution surface
 * (`components/merge/**`) — grouping, filtering, value formatting, and the
 * user's per-conflict resolution state. Kept separate from the React layer
 * so the trickiest part (which entries still need a human decision, and
 * what happens when they pick one) is unit-testable without rendering
 * anything, mirroring `lib/selected-components.ts`'s split for the
 * selection view.
 */

/** A user's explicit pick for one `conflict` entry. There is deliberately no third value for "auto" — auto-resolved entries (`take-left`/`take-right`/`unchanged`) never go through this map at all. */
export type UserResolution = 'left' | 'right';

/**
 * `MergeEntry.path` groups by its first dotted segment exactly the way
 * `merge/decompose.ts` (`@vibeset/core`) builds it — `fieldPermissions`,
 * `classAccesses`, `fields`, `description`, etc. This is the same
 * granularity `PermissionGrid.tsx`'s `categoryOf` uses for diffs; merge
 * doesn't invent a second grouping scheme.
 */
export function categoryOf(path: string): string {
  const idx = path.indexOf('.');
  return idx === -1 ? path : path.slice(0, idx);
}

const CATEGORY_LABELS: Record<string, string> = {
  fieldPermissions: 'Field permissions',
  objectPermissions: 'Object permissions',
  classAccesses: 'Class access',
  pageAccesses: 'Page access',
  recordTypeVisibilities: 'Record types',
  tabVisibilities: 'Tabs',
  tabSettings: 'Tabs',
  userPermissions: 'User permissions',
  fields: 'Fields',
  listViews: 'List views',
  validationRules: 'Validation rules',
  recordTypes: 'Record types',
  webLinks: 'Buttons & links',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Groups entries by category, sorted alphabetically by category name — stable tab order regardless of the order the engine returned entries in. */
export function groupMergeEntriesByCategory(entries: readonly MergeEntry[]): Array<[string, MergeEntry[]]> {
  const map = new Map<string, MergeEntry[]>();
  for (const entry of entries) {
    const cat = categoryOf(entry.path);
    const list = map.get(cat);
    if (list) list.push(entry);
    else map.set(cat, [entry]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export type MergeStatusFilter = 'all' | MergeEntryStatus;

export interface FilterMergeEntriesOptions {
  readonly search?: string;
  readonly statusFilter?: MergeStatusFilter;
  readonly resolutions?: ReadonlyMap<string, UserResolution>;
  /** "Needs attention" view: only conflicts the user hasn't picked a side for yet. */
  readonly onlyUnresolvedConflicts?: boolean;
}

/** Search + status filtering shared by every category tab's entry list. */
export function filterMergeEntries(entries: readonly MergeEntry[], opts: FilterMergeEntriesOptions = {}): MergeEntry[] {
  const query = opts.search?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (opts.statusFilter && opts.statusFilter !== 'all' && entry.status !== opts.statusFilter) return false;
    if (opts.onlyUnresolvedConflicts && (entry.status !== 'conflict' || opts.resolutions?.has(entry.path))) return false;
    if (query && !entry.key.toLowerCase().includes(query) && !entry.path.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** Records (or overwrites) the user's choice for one conflicting entry. Returns a new map — callers own their own state (a React `useState` setter, typically). */
export function applyResolution(
  resolutions: ReadonlyMap<string, UserResolution>,
  path: string,
  choice: UserResolution,
): Map<string, UserResolution> {
  const next = new Map(resolutions);
  next.set(path, choice);
  return next;
}

/** Reverts one entry back to "unresolved" — the explicit "leave unresolved" control. */
export function clearResolution(resolutions: ReadonlyMap<string, UserResolution>, path: string): Map<string, UserResolution> {
  if (!resolutions.has(path)) return new Map(resolutions);
  const next = new Map(resolutions);
  next.delete(path);
  return next;
}

export interface ResolutionCounts {
  readonly unchanged: number;
  readonly autoResolved: number;
  readonly conflictsTotal: number;
  readonly conflictsResolved: number;
  readonly conflictsOpen: number;
}

/**
 * Rolls entry statuses plus the user's local resolution picks into the
 * counts the summary strip and mode banner show. `conflictsOpen` is the
 * number that should still read as "needs you" — the whole point of this
 * feature is that this number is normally small.
 */
export function computeResolutionCounts(
  entries: readonly MergeEntry[],
  resolutions: ReadonlyMap<string, UserResolution>,
): ResolutionCounts {
  let unchanged = 0;
  let autoResolved = 0;
  let conflictsTotal = 0;
  let conflictsResolved = 0;
  for (const entry of entries) {
    if (entry.status === 'unchanged') unchanged += 1;
    else if (entry.status === 'take-left' || entry.status === 'take-right') autoResolved += 1;
    else if (entry.status === 'conflict') {
      conflictsTotal += 1;
      if (resolutions.has(entry.path)) conflictsResolved += 1;
    }
  }
  return { unchanged, autoResolved, conflictsTotal, conflictsResolved, conflictsOpen: conflictsTotal - conflictsResolved };
}

/**
 * The value a deploy would actually use for one entry, folding in the
 * user's local resolution for conflicts. `undefined` for a still-open
 * conflict — there is nothing honest to show as "the" value yet.
 */
export function effectiveValue(entry: MergeEntry, resolution: UserResolution | undefined): unknown {
  if (entry.status !== 'conflict') return entry.resolved;
  if (resolution === 'left') return entry.left;
  if (resolution === 'right') return entry.right;
  return undefined;
}

function formatScalar(value: unknown): string {
  if (value === 'true') return '✓';
  if (value === 'false') return '✗';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Renders one entry's left/right/base/resolved value as a compact single line for the entry table. Objects (the common case — a permission row, a field definition) render as `key: value` pairs; arrays collapse to a count rather than dumping their contents. */
export function formatMergeValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value !== 'object') return formatScalar(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => !k.startsWith('@_') && k !== '#comment');
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${formatScalar(v)}`).join('  ·  ');
}

export interface ModeBannerCopy {
  readonly tone: 'warning' | 'info';
  readonly title: string;
  readonly body: string;
}

/**
 * The one place the two-way/three-way distinction gets translated into
 * user-facing language — see `types/merge.ts` (`@vibeset/core`) for why
 * this distinction exists at all. Two-way is `warning`-toned deliberately:
 * it is always safe to USE (every differing entry gets a human decision),
 * but it does not carry the "only genuine conflicts need attention"
 * guarantee three-way does, and presenting it as calmly as three-way would
 * be exactly the false-safety framing that file warns against.
 */
export function modeBannerCopy(mode: MergeMode, baseLabel?: string): ModeBannerCopy {
  if (mode === 'three-way') {
    return {
      tone: 'info',
      title: `Three-way merge, base: ${baseLabel ?? 'git ref'}`,
      body:
        'A git ref supplies the common ancestor, so entries changed on only one side resolve automatically. ' +
        'A decision is required only where both sides changed the same entry to different values.',
    };
  }
  return {
    tone: 'warning',
    title: 'Two-way merge — no common ancestor',
    body:
      'These two sides have no shared history (an org has no notion of "who changed what"), so VibeSet cannot tell ' +
      'which side is the intended change. Every entry that differs between them needs your explicit decision below. ' +
      'Only entries present on just one side auto-resolve — that is not a safety guarantee about the other entries, ' +
      'just the absence of ambiguity for that one.',
  };
}
