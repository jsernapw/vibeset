import { beforeEach, describe, expect, it } from 'vitest';
import { deleteFilterSet, loadFilterSets, saveFilterSet } from '../src/lib/filter-sets';

describe('filter-sets (saveable comparison filter sets)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(loadFilterSets()).toEqual([]);
  });

  it('saves and reloads a filter set, sorted by name', () => {
    saveFilterSet('Zebra set', { types: ['Flow'] });
    saveFilterSet('Apex only', { types: ['ApexClass', 'ApexTrigger'] });
    const sets = loadFilterSets();
    expect(sets.map((s) => s.name)).toEqual(['Apex only', 'Zebra set']);
    expect(sets.find((s) => s.name === 'Apex only')?.filter.types).toEqual(['ApexClass', 'ApexTrigger']);
  });

  it('saving under an existing name overwrites it rather than duplicating', () => {
    saveFilterSet('My filter', { types: ['Flow'] });
    saveFilterSet('My filter', { types: ['Layout'] });
    const sets = loadFilterSets();
    expect(sets).toHaveLength(1);
    expect(sets[0]!.filter.types).toEqual(['Layout']);
  });

  it('deleteFilterSet removes exactly the targeted set', () => {
    const a = saveFilterSet('Set A', {});
    saveFilterSet('Set B', {});
    deleteFilterSet(a.id);
    expect(loadFilterSets().map((s) => s.name)).toEqual(['Set B']);
  });
});
