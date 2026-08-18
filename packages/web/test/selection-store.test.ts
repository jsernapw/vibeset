import { beforeEach, describe, expect, it } from 'vitest';
import { componentKeyToString, computeGroupTriState, useSelectionStore } from '../src/lib/selection-store';

describe('selection-store', () => {
  beforeEach(() => {
    useSelectionStore.setState({ selected: new Set(), activeComparisonId: null });
  });

  it('componentKeyToString includes parentFullName when present, for disambiguating child components', () => {
    expect(componentKeyToString({ type: 'CustomField', fullName: 'Name' })).toBe('CustomField::Name');
    expect(componentKeyToString({ type: 'CustomField', fullName: 'Name', parentFullName: 'Account' })).toBe(
      'CustomField::Account::Name',
    );
  });

  it('toggleLeaf flips a single leaf in and out of the selected set', () => {
    const { toggleLeaf } = useSelectionStore.getState();
    toggleLeaf('ApexClass::Foo');
    expect(useSelectionStore.getState().selected.has('ApexClass::Foo')).toBe(true);
    toggleLeaf('ApexClass::Foo');
    expect(useSelectionStore.getState().selected.has('ApexClass::Foo')).toBe(false);
  });

  it('setGroup selects/deselects every key in one update (parent -> children propagation)', () => {
    const keys = ['ApexClass::A', 'ApexClass::B', 'ApexClass::C'];
    useSelectionStore.getState().setGroup(keys, true);
    expect([...useSelectionStore.getState().selected].sort()).toEqual(keys);

    useSelectionStore.getState().setGroup(['ApexClass::B'], false);
    expect(computeGroupTriState(useSelectionStore.getState().selected, keys)).toBe('indeterminate');

    useSelectionStore.getState().setGroup(keys, false);
    expect(useSelectionStore.getState().selected.size).toBe(0);
  });

  it('computeGroupTriState reports unchecked, indeterminate, and checked correctly (children -> parent propagation)', () => {
    const keys = ['Flow::A', 'Flow::B'];
    expect(computeGroupTriState(new Set(), keys)).toBe('unchecked');

    const partial = new Set(['Flow::A']);
    expect(computeGroupTriState(partial, keys)).toBe('indeterminate');

    const full = new Set(keys);
    expect(computeGroupTriState(full, keys)).toBe('checked');
  });

  it('computeGroupTriState treats an empty group as unchecked, never indeterminate', () => {
    expect(computeGroupTriState(new Set(['anything']), [])).toBe('unchecked');
  });

  it('setLeaf is idempotent and independent of the current toggle state', () => {
    const { setLeaf } = useSelectionStore.getState();
    setLeaf('Layout::X', true);
    setLeaf('Layout::X', true);
    expect(useSelectionStore.getState().selected.size).toBe(1);
    setLeaf('Layout::X', false);
    setLeaf('Layout::X', false);
    expect(useSelectionStore.getState().selected.size).toBe(0);
  });

  describe('ensureComparison (Back-navigation must not lose a large selection)', () => {
    it('clears the selection the first time it is called for a comparisonId', () => {
      useSelectionStore.getState().setLeaf('ApexClass::Foo', true);
      useSelectionStore.getState().ensureComparison('cmp-1');
      expect(useSelectionStore.getState().selected.size).toBe(0);
      expect(useSelectionStore.getState().activeComparisonId).toBe('cmp-1');
    });

    it('does NOT clear the selection on a repeat call for the SAME comparisonId — this is the remount-on-Back case', () => {
      useSelectionStore.getState().ensureComparison('cmp-1');
      useSelectionStore.getState().setLeaf('ApexClass::Foo', true);
      useSelectionStore.getState().setLeaf('Flow::Bar', true);

      // Simulate the results page unmounting (navigating to the deploy step)
      // and remounting (browser Back) for the SAME comparison.
      useSelectionStore.getState().ensureComparison('cmp-1');

      expect(useSelectionStore.getState().selected.size).toBe(2);
      expect(useSelectionStore.getState().selected.has('ApexClass::Foo')).toBe(true);
    });

    it('DOES clear the selection when switching to a genuinely different comparisonId', () => {
      useSelectionStore.getState().ensureComparison('cmp-1');
      useSelectionStore.getState().setLeaf('ApexClass::Foo', true);

      useSelectionStore.getState().ensureComparison('cmp-2');

      expect(useSelectionStore.getState().selected.size).toBe(0);
      expect(useSelectionStore.getState().activeComparisonId).toBe('cmp-2');
    });
  });
});
