import { describe, expect, it } from 'vitest';
import type { DiffResult } from '@vibeset/core';
import { filterResults, flattenGroups, groupByType } from '../src/lib/comparison-tree';

function makeResults(count: number): DiffResult[] {
  const types = ['ApexClass', 'CustomField', 'Flow'];
  const statuses = ['new', 'changed', 'deleted', 'identical'] as const;
  return Array.from({ length: count }, (_, i) => ({
    key: { type: types[i % types.length]!, fullName: `Component_${i}` },
    status: statuses[i % statuses.length]!,
  }));
}

describe('groupByType', () => {
  it('groups results under their metadata type and counts each status', () => {
    const results = makeResults(12); // 4 per type, one of each status per type
    const groups = groupByType(results);
    expect(groups.map((g) => g.type)).toEqual(['ApexClass', 'CustomField', 'Flow']);
    for (const g of groups) {
      expect(g.results).toHaveLength(4);
      expect(g.counts).toEqual({ new: 1, changed: 1, deleted: 1, identical: 1 });
    }
  });

  it('scales to a large (50k+) dataset without losing any rows', () => {
    const results = makeResults(54000);
    const groups = groupByType(results);
    const total = groups.reduce((sum, g) => sum + g.results.length, 0);
    expect(total).toBe(54000);
  });
});

describe('filterResults', () => {
  const results = makeResults(12);

  it('with no filters, returns everything', () => {
    expect(filterResults(results, {})).toHaveLength(12);
  });

  it('filters by status set', () => {
    const filtered = filterResults(results, { statuses: new Set(['new']) });
    expect(filtered.every((r) => r.status === 'new')).toBe(true);
    expect(filtered).toHaveLength(3);
  });

  it('filters by case-insensitive name substring search', () => {
    const filtered = filterResults(results, { search: 'component_1' });
    // Component_1, Component_10, Component_11 all match the substring.
    expect(filtered.map((r) => r.key.fullName).sort()).toEqual(['Component_1', 'Component_10', 'Component_11']);
  });

  it('combines status and search filters', () => {
    const filtered = filterResults(results, { statuses: new Set(['changed']), search: 'Component_5' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.key.fullName).toBe('Component_5');
  });
});

describe('flattenGroups', () => {
  const groups = groupByType(makeResults(9)); // 3 types x 3 each

  it('emits only group headers when nothing is expanded', () => {
    const rows = flattenGroups(groups, new Set());
    expect(rows).toHaveLength(groups.length);
    expect(rows.every((r) => r.kind === 'group')).toBe(true);
  });

  it('emits header + every leaf for expanded groups only', () => {
    const rows = flattenGroups(groups, new Set(['ApexClass']));
    // 3 group headers + 3 leaves for the one expanded group.
    expect(rows).toHaveLength(groups.length + 3);
    const leafTypes = rows.filter((r) => r.kind === 'leaf').map((r) => r.type);
    expect(new Set(leafTypes)).toEqual(new Set(['ApexClass']));
  });

  it('expanding every group is what feeds the virtualizer the full 50k+ row list', () => {
    const bigGroups = groupByType(makeResults(54000));
    const expanded = new Set(bigGroups.map((g) => g.type));
    const rows = flattenGroups(bigGroups, expanded);
    const leafCount = rows.filter((r) => r.kind === 'leaf').length;
    const headerCount = rows.filter((r) => r.kind === 'group').length;
    expect(leafCount).toBe(54000);
    expect(headerCount).toBe(bigGroups.length);
    expect(rows).toHaveLength(54000 + bigGroups.length);
  });
});
