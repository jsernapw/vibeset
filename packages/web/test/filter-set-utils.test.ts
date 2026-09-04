import { describe, expect, it } from 'vitest';
import {
  buildTypeFilter,
  computeNamespaceImpact,
  defaultScopeFilterFields,
  formatCommaList,
  parseCommaList,
  scopeFieldsFromFilter,
  summarizeTypeFilter,
  withoutNamespaceFiltering,
} from '../src/lib/filter-set-utils';

describe('parseCommaList / formatCommaList', () => {
  it('splits and trims a comma-separated field', () => {
    expect(parseCommaList('omnistudio,  gearset ,foo')).toEqual(['omnistudio', 'gearset', 'foo']);
  });

  it('drops empty entries from stray/trailing commas', () => {
    expect(parseCommaList('omnistudio,, , gearset,')).toEqual(['omnistudio', 'gearset']);
  });

  it('an empty or whitespace-only string parses to an empty list', () => {
    expect(parseCommaList('')).toEqual([]);
    expect(parseCommaList('   ')).toEqual([]);
  });

  it('formatCommaList is the inverse for display', () => {
    expect(formatCommaList(['omnistudio', 'gearset'])).toBe('omnistudio, gearset');
    expect(formatCommaList([])).toBe('');
  });
});

describe('defaultScopeFilterFields', () => {
  it('defaults excludeManagedPackages to true — visible and on by default, matching the product default', () => {
    expect(defaultScopeFilterFields()).toEqual({
      namePatterns: [],
      modifiedSince: undefined,
      excludeNamespaces: [],
      excludeManagedPackages: true,
    });
  });
});

describe('buildTypeFilter', () => {
  it('omits empty array fields rather than sending []', () => {
    const filter = buildTypeFilter([], defaultScopeFilterFields());
    expect(filter).toEqual({ excludeManagedPackages: true });
    expect(filter.types).toBeUndefined();
    expect(filter.namePatterns).toBeUndefined();
    expect(filter.excludeNamespaces).toBeUndefined();
  });

  it('includes populated fields', () => {
    const filter = buildTypeFilter(['ApexClass', 'Flow'], {
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeNamespaces: ['omnistudio'],
      excludeManagedPackages: false,
    });
    expect(filter).toEqual({
      types: ['ApexClass', 'Flow'],
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeNamespaces: ['omnistudio'],
      excludeManagedPackages: false,
    });
  });

  it('always includes excludeManagedPackages explicitly, even when true', () => {
    const filter = buildTypeFilter(['ApexClass'], defaultScopeFilterFields());
    expect(filter.excludeManagedPackages).toBe(true);
  });
});

describe('scopeFieldsFromFilter', () => {
  it('reconstructs form state from a stored TypeFilter', () => {
    expect(
      scopeFieldsFromFilter({
        types: ['ApexClass'],
        namePatterns: ['Account.*'],
        modifiedSince: '2026-01-01',
        excludeNamespaces: ['omnistudio'],
        excludeManagedPackages: false,
      }),
    ).toEqual({
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeNamespaces: ['omnistudio'],
      excludeManagedPackages: false,
    });
  });

  it('defaults excludeManagedPackages to true when the filter omits it (not read as "off")', () => {
    expect(scopeFieldsFromFilter({ types: ['ApexClass'] }).excludeManagedPackages).toBe(true);
  });

  it('handles an undefined filter (new/empty filter set) the same as {}', () => {
    expect(scopeFieldsFromFilter(undefined)).toEqual(defaultScopeFilterFields());
  });

  it('round-trips through buildTypeFilter for a populated filter', () => {
    const original = {
      types: ['ApexClass', 'Flow'],
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeNamespaces: ['omnistudio'],
      excludeManagedPackages: false,
    };
    const scope = scopeFieldsFromFilter(original);
    expect(buildTypeFilter(original.types, scope)).toEqual(original);
  });
});

describe('withoutNamespaceFiltering', () => {
  it('turns off excludeManagedPackages and drops excludeNamespaces, keeping everything else', () => {
    const filter = {
      types: ['ApexClass'],
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeNamespaces: ['omnistudio'],
      excludeManagedPackages: true,
    };
    expect(withoutNamespaceFiltering(filter)).toEqual({
      types: ['ApexClass'],
      namePatterns: ['Account.*'],
      modifiedSince: '2026-01-01',
      excludeManagedPackages: false,
    });
  });

  it('is a no-op on the namespace dimensions when neither was set', () => {
    expect(withoutNamespaceFiltering({ types: ['ApexClass'] })).toEqual({ types: ['ApexClass'], excludeManagedPackages: false });
  });
});

describe('summarizeTypeFilter', () => {
  it('summarizes an empty filter as "All types" and managed packages excluded (default)', () => {
    expect(summarizeTypeFilter({})).toEqual(['All types', 'Managed packages excluded']);
  });

  it('summarizes a fully populated filter', () => {
    expect(
      summarizeTypeFilter({
        types: ['ApexClass', 'Flow'],
        namePatterns: ['Account.*'],
        modifiedSince: '2026-01-01',
        excludeNamespaces: ['omnistudio', 'gearset'],
        excludeManagedPackages: true,
      }),
    ).toEqual([
      '2 types',
      '1 name pattern',
      'Modified since 2026-01-01',
      'Excludes omnistudio, gearset',
      'Managed packages excluded',
    ]);
  });

  it('surfaces "Managed packages included" explicitly rather than omitting the chip — never silent', () => {
    expect(summarizeTypeFilter({ excludeManagedPackages: false })).toContain('Managed packages included');
  });

  it('singular "1 type"/"1 name pattern" phrasing', () => {
    const chips = summarizeTypeFilter({ types: ['ApexClass'], namePatterns: ['Account.*'] });
    expect(chips).toContain('1 type');
    expect(chips).toContain('1 name pattern');
  });
});

describe('computeNamespaceImpact', () => {
  it('computes removed count and percent', () => {
    expect(computeNamespaceImpact(200, 1)).toEqual({ removed: 199, removedPercent: 99.5 });
  });

  it('computes the ApexClass example from the task brief', () => {
    expect(computeNamespaceImpact(408, 37)).toEqual({ removed: 371, removedPercent: 90.9 });
  });

  it('handles before === 0 without dividing by zero', () => {
    expect(computeNamespaceImpact(0, 0)).toEqual({ removed: 0, removedPercent: 0 });
  });

  it('clamps removed at 0 if after somehow exceeds before (never negative)', () => {
    expect(computeNamespaceImpact(5, 10)).toEqual({ removed: 0, removedPercent: 0 });
  });

  it('no components removed when before === after', () => {
    expect(computeNamespaceImpact(37, 37)).toEqual({ removed: 0, removedPercent: 0 });
  });
});
