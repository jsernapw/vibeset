import { describe, expect, it } from 'vitest';
import type { MergeEntry } from '@vibeset/core';
import {
  applyResolution,
  categoryLabel,
  categoryOf,
  clearResolution,
  computeResolutionCounts,
  effectiveValue,
  filterMergeEntries,
  formatMergeValue,
  groupMergeEntriesByCategory,
  modeBannerCopy,
} from '../src/lib/merge-resolution';

function entry(overrides: Partial<MergeEntry> & Pick<MergeEntry, 'path' | 'key' | 'status'>): MergeEntry {
  return { ...overrides };
}

function makeEntries(): MergeEntry[] {
  return [
    entry({ path: 'classAccesses.FooController', key: 'FooController', status: 'conflict', left: { apexClass: 'FooController', enabled: 'false' }, right: { apexClass: 'FooController', enabled: 'true' } }),
    entry({ path: 'description', key: 'description', status: 'conflict', left: 'Left edit', right: 'Right edit' }),
    entry({ path: 'fieldPermissions.Account.Name', key: 'Account.Name', status: 'take-left', left: { field: 'Account.Name', editable: 'true' }, resolved: { field: 'Account.Name', editable: 'true' } }),
    entry({ path: 'fieldPermissions.Contact.Email', key: 'Contact.Email', status: 'take-right', right: { field: 'Contact.Email', editable: 'false' }, resolved: { field: 'Contact.Email', editable: 'false' } }),
    entry({ path: 'userPermissions.ApiEnabled', key: 'ApiEnabled', status: 'unchanged', left: { enabled: 'true' }, right: { enabled: 'true' }, resolved: { enabled: 'true' } }),
  ];
}

describe('categoryOf / categoryLabel', () => {
  it('takes the first dotted segment of the path as the category', () => {
    expect(categoryOf('fieldPermissions.Account.Name')).toBe('fieldPermissions');
    expect(categoryOf('description')).toBe('description');
  });

  it('maps known categories to friendly labels and falls back to the raw name otherwise', () => {
    expect(categoryLabel('fieldPermissions')).toBe('Field permissions');
    expect(categoryLabel('somethingUnknown')).toBe('somethingUnknown');
  });
});

describe('groupMergeEntriesByCategory', () => {
  it('groups by category and sorts categories alphabetically', () => {
    const groups = groupMergeEntriesByCategory(makeEntries());
    expect(groups.map(([cat]) => cat)).toEqual(['classAccesses', 'description', 'fieldPermissions', 'userPermissions']);
    const fieldPerms = groups.find(([cat]) => cat === 'fieldPermissions')?.[1] ?? [];
    expect(fieldPerms).toHaveLength(2);
  });

  it('returns an empty array for no entries', () => {
    expect(groupMergeEntriesByCategory([])).toEqual([]);
  });
});

describe('filterMergeEntries', () => {
  const entries = makeEntries();

  it('filters by status', () => {
    const conflicts = filterMergeEntries(entries, { statusFilter: 'conflict' });
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((e) => e.status === 'conflict')).toBe(true);
  });

  it('"all" status passes everything through', () => {
    expect(filterMergeEntries(entries, { statusFilter: 'all' })).toHaveLength(entries.length);
  });

  it('filters by case-insensitive substring on key or path', () => {
    const matched = filterMergeEntries(entries, { search: 'foocontroller' });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.key).toBe('FooController');
  });

  it('onlyUnresolvedConflicts excludes conflicts the user already picked a side for', () => {
    const resolutions = new Map([['description', 'left' as const]]);
    const open = filterMergeEntries(entries, { onlyUnresolvedConflicts: true, resolutions });
    expect(open).toHaveLength(1);
    expect(open[0]?.path).toBe('classAccesses.FooController');
  });

  it('combines status and search filters', () => {
    const result = filterMergeEntries(entries, { statusFilter: 'conflict', search: 'description' });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('description');
  });
});

describe('applyResolution / clearResolution', () => {
  it('applyResolution records a choice without mutating the input map', () => {
    const original = new Map<string, 'left' | 'right'>();
    const next = applyResolution(original, 'description', 'right');
    expect(original.size).toBe(0);
    expect(next.get('description')).toBe('right');
  });

  it('applyResolution overwrites a previous choice for the same path', () => {
    const first = applyResolution(new Map(), 'description', 'left');
    const second = applyResolution(first, 'description', 'right');
    expect(second.get('description')).toBe('right');
  });

  it('clearResolution removes an entry without mutating the input map', () => {
    const resolved = applyResolution(new Map(), 'description', 'left');
    const cleared = clearResolution(resolved, 'description');
    expect(resolved.has('description')).toBe(true);
    expect(cleared.has('description')).toBe(false);
  });

  it('clearResolution on an unresolved path is a no-op that still returns a fresh map', () => {
    const empty = new Map<string, 'left' | 'right'>();
    const result = clearResolution(empty, 'nope');
    expect(result).not.toBe(empty);
    expect(result.size).toBe(0);
  });
});

describe('computeResolutionCounts', () => {
  it('tallies unchanged, auto-resolved, and conflict entries, splitting conflicts by whether the user has picked a side', () => {
    const entries = makeEntries();
    const noResolutions = computeResolutionCounts(entries, new Map());
    expect(noResolutions).toEqual({ unchanged: 1, autoResolved: 2, conflictsTotal: 2, conflictsResolved: 0, conflictsOpen: 2 });

    const oneResolved = computeResolutionCounts(entries, new Map([['description', 'left' as const]]));
    expect(oneResolved).toEqual({ unchanged: 1, autoResolved: 2, conflictsTotal: 2, conflictsResolved: 1, conflictsOpen: 1 });
  });

  it('a resolution recorded for a non-conflict path does not inflate conflictsResolved', () => {
    const entries = makeEntries();
    const stray = computeResolutionCounts(entries, new Map([['fieldPermissions.Account.Name', 'left' as const]]));
    expect(stray.conflictsResolved).toBe(0);
  });
});

describe('effectiveValue', () => {
  it('returns the already-resolved value for non-conflict entries regardless of any user resolution', () => {
    const e = makeEntries().find((x) => x.path === 'fieldPermissions.Account.Name')!;
    expect(effectiveValue(e, 'right')).toEqual(e.resolved);
  });

  it('returns left/right based on the user resolution for a conflict', () => {
    const e = makeEntries().find((x) => x.path === 'description')!;
    expect(effectiveValue(e, 'left')).toBe('Left edit');
    expect(effectiveValue(e, 'right')).toBe('Right edit');
  });

  it('returns undefined for a still-open conflict', () => {
    const e = makeEntries().find((x) => x.path === 'description')!;
    expect(effectiveValue(e, undefined)).toBeUndefined();
  });
});

describe('formatMergeValue', () => {
  it('renders undefined as an em dash', () => {
    expect(formatMergeValue(undefined)).toBe('—');
  });

  it('renders scalars as-is, translating "true"/"false" strings to check/cross marks', () => {
    expect(formatMergeValue('Right edited this')).toBe('Right edited this');
    expect(formatMergeValue('true')).toBe('✓');
    expect(formatMergeValue('false')).toBe('✗');
  });

  it('renders a plain object as key: value pairs, skipping attribute keys and comments', () => {
    expect(formatMergeValue({ apexClass: 'FooController', enabled: 'true', '@_xsi:type': 'x', '#comment': 'hi' })).toBe(
      'apexClass: FooController  ·  enabled: ✓',
    );
  });

  it('renders an empty object as an em dash', () => {
    expect(formatMergeValue({})).toBe('—');
  });

  it('collapses arrays to an item count instead of dumping contents', () => {
    expect(formatMergeValue([1, 2, 3])).toBe('[3 items]');
    expect(formatMergeValue([1])).toBe('[1 item]');
    expect(formatMergeValue([])).toBe('[0 items]');
  });
});

describe('modeBannerCopy', () => {
  it('two-way mode reads as a warning, not a calm confirmation, and explains the lack of a common ancestor', () => {
    const copy = modeBannerCopy('two-way');
    expect(copy.tone).toBe('warning');
    expect(copy.title).toMatch(/two-way/i);
    expect(copy.body).toMatch(/no shared history|no notion of/i);
  });

  it('three-way mode reads as informational and names the base when given a label', () => {
    const copy = modeBannerCopy('three-way', 'main @ origin');
    expect(copy.tone).toBe('info');
    expect(copy.title).toContain('main @ origin');
    expect(copy.body).toMatch(/common ancestor|auto/i);
  });

  it('three-way mode falls back to a generic base description without a label', () => {
    const copy = modeBannerCopy('three-way');
    expect(copy.title).toMatch(/git ref/i);
  });
});
