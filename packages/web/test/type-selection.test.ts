import { describe, expect, it } from 'vitest';
import { resolveDefaultTypeSelection, splitTypes, splitTypesForScope } from '../src/lib/type-selection';

const ALL = ['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField', 'Flow'];

describe('splitTypes (Selected vs Available sections for the types step)', () => {
  it('with nothing selected, everything is available and nothing is selected', () => {
    const { selected, available } = splitTypes(ALL, []);
    expect(selected).toEqual([]);
    expect(available).toEqual(ALL);
  });

  it('moves a chosen type out of available and into selected, without needing to remove it from further consideration', () => {
    const { selected, available } = splitTypes(ALL, ['Flow']);
    expect(selected).toEqual(['Flow']);
    expect(available).toEqual(['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField']);
  });

  it('selecting one type does not block selecting more — every other type stays in available', () => {
    const step1 = splitTypes(ALL, ['ApexClass']);
    expect(step1.available).toContain('Flow');
    const step2 = splitTypes(ALL, ['ApexClass', 'Flow']);
    expect(step2.selected).toEqual(['ApexClass', 'Flow']);
    expect(step2.available).toEqual(['ApexTrigger', 'CustomObject', 'CustomField']);
  });

  it('preserves registry order for the selected list regardless of pick order', () => {
    const { selected } = splitTypes(ALL, ['Flow', 'ApexClass']);
    expect(selected).toEqual(['ApexClass', 'Flow']);
  });

  it('search filters only the available section, case-insensitively', () => {
    const { selected, available } = splitTypes(ALL, ['Flow'], 'apex');
    expect(selected).toEqual(['Flow']); // never filtered out by search
    expect(available).toEqual(['ApexClass', 'ApexTrigger']);
  });

  it('a search matching nothing leaves available empty without touching selected', () => {
    const { selected, available } = splitTypes(ALL, ['Flow'], 'zzz-no-match');
    expect(selected).toEqual(['Flow']);
    expect(available).toEqual([]);
  });

  it('scales to a large (Phase 2-sized) type registry without dropping entries', () => {
    const bigList = Array.from({ length: 150 }, (_, i) => `Type_${i}`);
    const chosen = bigList.filter((_, i) => i % 3 === 0);
    const { selected, available } = splitTypes(bigList, chosen);
    expect(selected).toHaveLength(chosen.length);
    expect(available).toHaveLength(bigList.length - chosen.length);
  });
});

const ALL_418 = ['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField', 'Flow', 'Territory2Model', 'WaveApplication'];
const CURATED_33 = ['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField', 'Flow'];

describe('splitTypesForScope (curated-33-vs-all-418 Available scope toggle)', () => {
  it('with scope=curated, Available is drawn from the curated list, not the full registry', () => {
    const { available } = splitTypesForScope({ allTypes: ALL_418, scopeTypes: CURATED_33, selectedTypes: [], search: '' });
    expect(available).toEqual(CURATED_33);
    expect(available).not.toContain('Territory2Model');
  });

  it('with scope=all, Available is drawn from the full registry', () => {
    const { available } = splitTypesForScope({ allTypes: ALL_418, scopeTypes: ALL_418, selectedTypes: [], search: '' });
    expect(available).toContain('Territory2Model');
    expect(available).toContain('WaveApplication');
  });

  it('Selected is always resolved against the full universe, regardless of the Available scope', () => {
    // Picked while scope was "all" (Territory2Model isn't in the curated list).
    const { selected } = splitTypesForScope({
      allTypes: ALL_418,
      scopeTypes: CURATED_33, // now back to "curated" scope
      selectedTypes: ['Territory2Model'],
      search: '',
    });
    expect(selected).toEqual(['Territory2Model']);
  });

  it('a selected type absent from allTypes (stale saved filter set) is appended, not silently dropped', () => {
    const { selected } = splitTypesForScope({
      allTypes: ALL_418,
      scopeTypes: CURATED_33,
      selectedTypes: ['ApexClass', 'SomeRetiredType'],
      search: '',
    });
    expect(selected).toEqual(['ApexClass', 'SomeRetiredType']);
  });

  it('search filters Available within whichever scope is active', () => {
    const curatedSearch = splitTypesForScope({ allTypes: ALL_418, scopeTypes: CURATED_33, selectedTypes: [], search: 'territory' });
    expect(curatedSearch.available).toEqual([]);

    const allSearch = splitTypesForScope({ allTypes: ALL_418, scopeTypes: ALL_418, selectedTypes: [], search: 'territory' });
    expect(allSearch.available).toEqual(['Territory2Model']);
  });

  it('already-selected types never reappear in Available in either scope', () => {
    const { available } = splitTypesForScope({
      allTypes: ALL_418,
      scopeTypes: ALL_418,
      selectedTypes: ['ApexClass', 'Territory2Model'],
      search: '',
    });
    expect(available).not.toContain('ApexClass');
    expect(available).not.toContain('Territory2Model');
  });
});

describe('resolveDefaultTypeSelection (auto-apply the curated default exactly once per wizard pass)', () => {
  it('returns null (do nothing) while the defaults have not loaded yet, even if uninitialized', () => {
    expect(resolveDefaultTypeSelection({ typesInitialized: false, defaultTypes: undefined })).toBeNull();
  });

  it('applies the curated default once it has loaded and the step has never been touched', () => {
    const result = resolveDefaultTypeSelection({ typesInitialized: false, defaultTypes: CURATED_33 });
    expect(result).toEqual(CURATED_33);
  });

  it('returns a fresh copy, not the same array reference (caller mutation safety)', () => {
    const result = resolveDefaultTypeSelection({ typesInitialized: false, defaultTypes: CURATED_33 });
    expect(result).not.toBe(CURATED_33);
  });

  it('never applies the default once the step has been initialized, even if the user cleared everything', () => {
    expect(resolveDefaultTypeSelection({ typesInitialized: true, defaultTypes: CURATED_33 })).toBeNull();
  });

  it('never applies the default once initialized, even across a re-render where defaultTypes changes identity', () => {
    // Simulates React Query returning a new array reference on refetch —
    // must not be mistaken for "the user's selection changed".
    expect(resolveDefaultTypeSelection({ typesInitialized: true, defaultTypes: [...CURATED_33] })).toBeNull();
  });
});
