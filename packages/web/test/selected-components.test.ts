import { describe, expect, it } from 'vitest';
import type { DiffResult } from '@vibeset/core';
import { buildSelectedRows, countByStatus, filterAndSortSelected, pickSelected } from '../src/lib/selected-components';
import { componentKeyToString } from '../src/lib/selection-store';

function makeResults(): DiffResult[] {
  return [
    { key: { type: 'ApexClass', fullName: 'FooService' }, status: 'changed' },
    { key: { type: 'ApexClass', fullName: 'BarHandler' }, status: 'new' },
    { key: { type: 'Flow', fullName: 'Onboarding_Flow' }, status: 'deleted' },
    { key: { type: 'Flow', fullName: 'Approval_Flow' }, status: 'identical' },
    { key: { type: 'CustomField', fullName: 'Account__c.Region__c' }, status: 'changed' },
  ];
}

describe('pickSelected (cross-type selection filtering)', () => {
  it('returns only the results whose key string is in the selected set, across every type', () => {
    const results = makeResults();
    const selected = new Set([componentKeyToString(results[0]!.key), componentKeyToString(results[2]!.key)]);
    const picked = pickSelected(results, selected);
    expect(picked.map((r) => r.key.fullName)).toEqual(['FooService', 'Onboarding_Flow']);
  });

  it('returns an empty array when nothing is selected', () => {
    expect(pickSelected(makeResults(), new Set())).toEqual([]);
  });
});

describe('filterAndSortSelected', () => {
  const results = makeResults();

  it('sorts by type then name by default', () => {
    const sorted = filterAndSortSelected(results);
    expect(sorted.map((r) => r.key.fullName)).toEqual([
      'BarHandler',
      'FooService',
      'Account__c.Region__c',
      'Approval_Flow',
      'Onboarding_Flow',
    ]);
  });

  it('sorts by name across types when sortKey is "name"', () => {
    const sorted = filterAndSortSelected(results, { sortKey: 'name' });
    expect(sorted.map((r) => r.key.fullName)).toEqual([
      'Account__c.Region__c',
      'Approval_Flow',
      'BarHandler',
      'FooService',
      'Onboarding_Flow',
    ]);
  });

  it('sorts by status when sortKey is "status"', () => {
    const sorted = filterAndSortSelected(results, { sortKey: 'status' });
    expect(sorted.map((r) => r.status)).toEqual(['changed', 'changed', 'deleted', 'identical', 'new']);
  });

  it('filters by case-insensitive substring across both name and type', () => {
    const byName = filterAndSortSelected(results, { search: 'flow' });
    expect(byName.map((r) => r.key.fullName).sort()).toEqual(['Approval_Flow', 'Onboarding_Flow']);

    const byType = filterAndSortSelected(results, { search: 'apexclass' });
    expect(byType).toHaveLength(2);
  });
});

describe('buildSelectedRows (grouped vs flattened cross-type view)', () => {
  const results = makeResults();

  it('groups by type with headers, sorted alphabetically, members expanded by default', () => {
    const rows = buildSelectedRows(filterAndSortSelected(results));
    const groupTypes = rows.filter((r) => r.kind === 'group').map((r) => (r.kind === 'group' ? r.type : ''));
    expect(groupTypes).toEqual(['ApexClass', 'CustomField', 'Flow']);
    // 3 group headers + 5 leaves.
    expect(rows).toHaveLength(8);
  });

  it('collapsing a type via collapsedTypes hides its members but keeps the header', () => {
    const rows = buildSelectedRows(filterAndSortSelected(results), { collapsedTypes: new Set(['ApexClass']) });
    const apexGroup = rows.find((r) => r.kind === 'group' && r.type === 'ApexClass');
    expect(apexGroup).toBeDefined();
    const apexLeaves = rows.filter((r) => r.kind === 'leaf' && r.result.key.type === 'ApexClass');
    expect(apexLeaves).toHaveLength(0);
    // Other groups stay expanded.
    const flowLeaves = rows.filter((r) => r.kind === 'leaf' && r.result.key.type === 'Flow');
    expect(flowLeaves).toHaveLength(2);
  });

  it('flatten emits a single sorted list with no group headers at all', () => {
    const rows = buildSelectedRows(filterAndSortSelected(results, { sortKey: 'name' }), { flatten: true });
    expect(rows.every((r) => r.kind === 'leaf')).toBe(true);
    expect(rows).toHaveLength(5);
    expect((rows[0] as { kind: 'leaf'; result: DiffResult }).result.key.fullName).toBe('Account__c.Region__c');
  });

  it('produces no rows for an empty selection', () => {
    expect(buildSelectedRows([])).toEqual([]);
  });
});

describe('countByStatus', () => {
  it('tallies each status across the selected set', () => {
    expect(countByStatus(makeResults())).toEqual({ new: 1, changed: 2, deleted: 1, identical: 1 });
  });
});
