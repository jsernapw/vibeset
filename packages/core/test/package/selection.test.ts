import { describe, expect, it } from 'vitest';
import {
  buildSelectionTree,
  selectionToPackageComponents,
  TriStateSelection,
  type SelectionTreeNode,
} from '../../src/package/selection.js';
import { componentKeyString } from '../../src/util/component-key.js';
import type { DiffResult } from '../../src/types/diff.js';

describe('TriStateSelection — tri-state parent/child propagation', () => {
  const tree: SelectionTreeNode[] = [
    {
      id: 'CustomObject#Account',
      children: [
        { id: 'CustomField#Account.A' },
        { id: 'CustomField#Account.B' },
        { id: 'CustomField#Account.C' },
      ],
    },
    { id: 'ApexClass#Foo' },
  ];

  it('starts fully unchecked', () => {
    const sel = new TriStateSelection(tree);
    expect(sel.stateOf('CustomObject#Account')).toBe('unchecked');
    expect(sel.stateOf('CustomField#Account.A')).toBe('unchecked');
    expect(sel.selectedLeafIds()).toEqual([]);
  });

  it('checking a parent checks every child (downward propagation)', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('CustomObject#Account', true);
    expect(sel.stateOf('CustomObject#Account')).toBe('checked');
    expect(sel.stateOf('CustomField#Account.A')).toBe('checked');
    expect(sel.stateOf('CustomField#Account.B')).toBe('checked');
    expect(sel.stateOf('CustomField#Account.C')).toBe('checked');
    expect(sel.selectedLeafIds().sort()).toEqual(
      ['CustomField#Account.A', 'CustomField#Account.B', 'CustomField#Account.C'].sort(),
    );
  });

  it('checking some but not all children makes the parent indeterminate (upward propagation)', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('CustomField#Account.A', true);
    expect(sel.stateOf('CustomField#Account.A')).toBe('checked');
    expect(sel.stateOf('CustomField#Account.B')).toBe('unchecked');
    expect(sel.stateOf('CustomObject#Account')).toBe('indeterminate');
  });

  it('checking every child individually makes the parent fully checked, not indeterminate', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('CustomField#Account.A', true);
    sel.setChecked('CustomField#Account.B', true);
    sel.setChecked('CustomField#Account.C', true);
    expect(sel.stateOf('CustomObject#Account')).toBe('checked');
  });

  it('unchecking a parent that was fully checked unchecks every child', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('CustomObject#Account', true);
    sel.setChecked('CustomObject#Account', false);
    expect(sel.stateOf('CustomObject#Account')).toBe('unchecked');
    expect(sel.stateOf('CustomField#Account.A')).toBe('unchecked');
    expect(sel.selectedLeafIds()).toEqual([]);
  });

  it('a leaf with no children behaves as its own leaf (checking ApexClass#Foo does not affect Account)', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('ApexClass#Foo', true);
    expect(sel.stateOf('ApexClass#Foo')).toBe('checked');
    expect(sel.stateOf('CustomObject#Account')).toBe('unchecked');
    expect(sel.selectedLeafIds()).toEqual(['ApexClass#Foo']);
  });

  it('reset() clears every explicit flag back to unchecked', () => {
    const sel = new TriStateSelection(tree);
    sel.setChecked('CustomObject#Account', true);
    sel.reset();
    expect(sel.stateOf('CustomObject#Account')).toBe('unchecked');
    expect(sel.selectedLeafIds()).toEqual([]);
  });
});

function diffResult(overrides: Partial<DiffResult> & Pick<DiffResult, 'key' | 'status'>): DiffResult {
  return overrides;
}

describe('buildSelectionTree', () => {
  it('groups a CustomField under its parent CustomObject when the parent is also in the result set', () => {
    const results: DiffResult[] = [
      diffResult({ key: { type: 'CustomObject', fullName: 'Account' }, status: 'changed' }),
      diffResult({ key: { type: 'CustomField', fullName: 'Account.A', parentFullName: 'Account' }, status: 'new' }),
      diffResult({ key: { type: 'CustomField', fullName: 'Account.B', parentFullName: 'Account' }, status: 'new' }),
    ];
    const tree = buildSelectionTree(results);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe(componentKeyString({ type: 'CustomObject', fullName: 'Account' }));
    expect(tree[0]!.children?.map((c) => c.id).sort()).toEqual(
      [
        componentKeyString({ type: 'CustomField', fullName: 'Account.A' }),
        componentKeyString({ type: 'CustomField', fullName: 'Account.B' }),
      ].sort(),
    );
  });

  it('makes a child a top-level node when its parent is not in the result set (out of comparison scope)', () => {
    const results: DiffResult[] = [
      diffResult({ key: { type: 'CustomField', fullName: 'Account.A', parentFullName: 'Account' }, status: 'new' }),
    ];
    const tree = buildSelectionTree(results);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toBeUndefined();
  });

  it('excludes identical components — nothing to select for an unchanged component', () => {
    const results: DiffResult[] = [
      diffResult({ key: { type: 'ApexClass', fullName: 'Unchanged' }, status: 'identical' }),
      diffResult({ key: { type: 'ApexClass', fullName: 'Changed' }, status: 'changed' }),
    ];
    const tree = buildSelectionTree(results);
    expect(tree.map((n) => n.id)).toEqual([componentKeyString({ type: 'ApexClass', fullName: 'Changed' })]);
  });
});

describe('selectionToPackageComponents', () => {
  it('routes new/changed to components and deleted to destructiveComponents, skipping unselected keys', () => {
    const results: DiffResult[] = [
      diffResult({ key: { type: 'ApexClass', fullName: 'AddMe' }, status: 'new' }),
      diffResult({ key: { type: 'ApexClass', fullName: 'ChangeMe' }, status: 'changed' }),
      diffResult({ key: { type: 'ApexClass', fullName: 'RemoveMe' }, status: 'deleted' }),
      diffResult({ key: { type: 'ApexClass', fullName: 'NotSelected' }, status: 'new' }),
    ];
    const resultsByKeyString = new Map(results.map((r) => [componentKeyString(r.key), r]));
    const tree = buildSelectionTree(results);
    const selection = new TriStateSelection(tree);
    selection.setChecked(componentKeyString({ type: 'ApexClass', fullName: 'AddMe' }), true);
    selection.setChecked(componentKeyString({ type: 'ApexClass', fullName: 'ChangeMe' }), true);
    selection.setChecked(componentKeyString({ type: 'ApexClass', fullName: 'RemoveMe' }), true);
    // 'NotSelected' deliberately left unchecked.

    const { components, destructiveComponents } = selectionToPackageComponents(selection, resultsByKeyString);
    expect(components.map((k) => k.fullName).sort()).toEqual(['AddMe', 'ChangeMe']);
    expect(destructiveComponents.map((k) => k.fullName)).toEqual(['RemoveMe']);
  });
});
