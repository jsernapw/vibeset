import { describe, expect, it } from 'vitest';
import { splitTypes } from '../src/lib/type-selection';

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
