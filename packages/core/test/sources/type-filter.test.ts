import { describe, expect, it } from 'vitest';
import { matchesTypeFilter, withManagedPackageDefault } from '../../src/sources/type-filter.js';

describe('matchesTypeFilter — types / namePatterns / modifiedSince / modifiedBy', () => {
  it('applies no restriction for an empty/omitted filter', () => {
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo' }, {})).toBe(true);
  });

  it('filters by type', () => {
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo' }, { types: ['ApexTrigger'] })).toBe(false);
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo' }, { types: ['ApexClass'] })).toBe(true);
  });

  it('filters by namePatterns (glob)', () => {
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'FooController' }, { namePatterns: ['Foo*'] })).toBe(true);
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'BarController' }, { namePatterns: ['Foo*'] })).toBe(false);
  });

  it('filters by modifiedSince', () => {
    const params = { type: 'ApexClass', fullName: 'Foo', lastModifiedDate: '2026-01-01T00:00:00.000Z' };
    expect(matchesTypeFilter(params, { modifiedSince: '2026-06-01T00:00:00.000Z' })).toBe(false);
    expect(matchesTypeFilter(params, { modifiedSince: '2025-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('modifiedSince never excludes an entry with no lastModifiedDate (unknown-date entries always refetch)', () => {
    expect(matchesTypeFilter({ type: 'Settings', fullName: 'Settings' }, { modifiedSince: '2026-06-01T00:00:00.000Z' })).toBe(
      true,
    );
  });

  it('filters by modifiedBy when the source supplied a signal', () => {
    const params = { type: 'ApexClass', fullName: 'Foo', modifiedBy: 'alice@example.com' };
    expect(matchesTypeFilter(params, { modifiedBy: ['bob@example.com'] })).toBe(false);
    expect(matchesTypeFilter(params, { modifiedBy: ['alice@example.com'] })).toBe(true);
  });

  it('modifiedBy excludes everything when the source has no authorship signal at all (SfdxProjectSource behavior)', () => {
    expect(matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo' }, { modifiedBy: ['alice@example.com'] })).toBe(false);
  });
});

describe('matchesTypeFilter — namespace resolution and excludeNamespaces', () => {
  it('falls back to the fullName heuristic when no namespacePrefix signal is supplied (SfdxProjectSource/GitRefSource)', () => {
    // Single "__" — an ordinary custom field, not namespaced.
    expect(matchesTypeFilter({ type: 'CustomField', fullName: 'Name__c' }, { excludeNamespaces: ['Name'] })).toBe(true);
    // Double "__" — namespaced.
    expect(
      matchesTypeFilter({ type: 'CustomField', fullName: 'omnistudio__Field__c' }, { excludeNamespaces: ['omnistudio'] }),
    ).toBe(false);
  });

  it('prefers the authoritative namespacePrefix signal over fullName parsing when both are present and disagree', () => {
    // fullName LOOKS namespaced (two "__") but the API says there is no namespace — API wins.
    expect(
      matchesTypeFilter(
        { type: 'ApexClass', fullName: 'omnistudio__Foo', namespacePrefix: '' },
        { excludeNamespaces: ['omnistudio'] },
      ),
    ).toBe(true);
    // fullName looks unnamespaced but the API says it IS namespaced — API wins.
    expect(
      matchesTypeFilter(
        { type: 'ApexClass', fullName: 'PlainLookingName', namespacePrefix: 'omnistudio' },
        { excludeNamespaces: ['omnistudio'] },
      ),
    ).toBe(false);
  });

  it('excludeNamespaces only excludes the specific namespace(s) named', () => {
    expect(
      matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo', namespacePrefix: 'other' }, { excludeNamespaces: ['omnistudio'] }),
    ).toBe(true);
  });
});

describe('matchesTypeFilter — excludeManagedPackages', () => {
  it('excludes a namespaced component with no manageableState signal (filesystem heuristic path)', () => {
    expect(matchesTypeFilter({ type: 'StaticResource', fullName: 'omnistudio__Res' }, { excludeManagedPackages: true })).toBe(
      false,
    );
  });

  it('excludes an org-sourced component whose manageableState is NOT "unmanaged" (a genuinely installed managed package)', () => {
    expect(
      matchesTypeFilter(
        { type: 'StaticResource', fullName: 'omnistudio__Res', namespacePrefix: 'omnistudio', manageableState: 'installed' },
        { excludeManagedPackages: true },
      ),
    ).toBe(false);
  });

  it('does NOT exclude a namespaced component whose manageableState is "unmanaged" — the org is its own dev/packaging namespace, not someone else\'s package', () => {
    expect(
      matchesTypeFilter(
        { type: 'ApexClass', fullName: 'myns__Foo', namespacePrefix: 'myns', manageableState: 'unmanaged' },
        { excludeManagedPackages: true },
      ),
    ).toBe(true);
  });

  it('never excludes an unnamespaced component', () => {
    expect(
      matchesTypeFilter({ type: 'ApexClass', fullName: 'Foo', namespacePrefix: '' }, { excludeManagedPackages: true }),
    ).toBe(true);
  });

  it('is independent of excludeNamespaces — both can apply at once', () => {
    // excludeManagedPackages catches an installed package even if the
    // caller only named a DIFFERENT namespace in excludeNamespaces.
    expect(
      matchesTypeFilter(
        { type: 'StaticResource', fullName: 'other__Res', namespacePrefix: 'other', manageableState: 'installed' },
        { excludeNamespaces: ['omnistudio'], excludeManagedPackages: true },
      ),
    ).toBe(false);
  });
});

describe('withManagedPackageDefault', () => {
  it('defaults excludeManagedPackages to true when unspecified', () => {
    expect(withManagedPackageDefault({}).excludeManagedPackages).toBe(true);
  });

  it('preserves an explicit opt-out (excludeManagedPackages: false)', () => {
    expect(withManagedPackageDefault({ excludeManagedPackages: false }).excludeManagedPackages).toBe(false);
  });

  it('preserves an explicit true and every other field untouched', () => {
    const filter = { types: ['ApexClass'], excludeManagedPackages: true };
    expect(withManagedPackageDefault(filter)).toEqual(filter);
  });
});
