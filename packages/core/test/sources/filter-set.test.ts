import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteFilterSet,
  FILTER_SET_SCHEMA_VERSION,
  filterSetFilePath,
  filterSetFromYaml,
  filterSetToYaml,
  listFilterSets,
  loadFilterSet,
  saveFilterSet,
  type FilterSet,
} from '../../src/sources/filter-set.js';

const sampleFilterSet: FilterSet = {
  vibesetFilterSetVersion: FILTER_SET_SCHEMA_VERSION,
  id: 'fs_abc123',
  name: 'Exclude OmniStudio',
  description: 'Hide the omnistudio managed package from every comparison.',
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z',
  filter: { excludeManagedPackages: true, excludeNamespaces: ['omnistudio'] },
};

describe('filter set — YAML schema round-trip', () => {
  it('filterSetToYaml -> filterSetFromYaml is lossless', () => {
    const yaml = filterSetToYaml(sampleFilterSet);
    expect(yaml).toContain('vibesetFilterSetVersion: 1');
    expect(yaml).toContain('id: fs_abc123');
    expect(yaml).toContain('excludeManagedPackages: true');
    expect(yaml).toContain('omnistudio');

    const revived = filterSetFromYaml(yaml);
    expect(revived).toEqual(sampleFilterSet);
  });

  it('rejects a filter set with an unsupported schema version', () => {
    const yaml = 'vibesetFilterSetVersion: 999\nid: x\nname: y\ncreatedAt: z\nupdatedAt: z\n';
    expect(() => filterSetFromYaml(yaml)).toThrow(/version/i);
  });

  it('rejects a filter set missing required fields', () => {
    expect(() => filterSetFromYaml('vibesetFilterSetVersion: 1\n')).toThrow(/missing required field/i);
  });

  it('defaults filter to {} when absent from the YAML', () => {
    const yaml =
      'vibesetFilterSetVersion: 1\nid: x\nname: y\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n';
    expect(filterSetFromYaml(yaml).filter).toEqual({});
  });
});

describe('filter set — filesystem save/load/list/delete under .vibeset/', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibeset-filterset-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves to <dir>/filter-sets/<id>.yml and loads back an equal filter set', async () => {
    const filePath = await saveFilterSet(sampleFilterSet, dir);
    expect(filePath).toBe(filterSetFilePath(dir, sampleFilterSet.id));
    expect(filePath).toBe(join(dir, 'filter-sets', 'fs_abc123.yml'));

    const loaded = await loadFilterSet(filePath);
    expect(loaded).toEqual(sampleFilterSet);
  });

  it('returns an empty array from listFilterSets when the directory has never been created', async () => {
    expect(await listFilterSets(dir)).toEqual([]);
  });

  it('lists saved filter sets newest-updatedAt-first', async () => {
    const older: FilterSet = { ...sampleFilterSet, id: 'fs_older', updatedAt: '2026-01-01T00:00:00.000Z' };
    const newer: FilterSet = { ...sampleFilterSet, id: 'fs_newer', updatedAt: '2026-06-01T00:00:00.000Z' };
    await saveFilterSet(older, dir);
    await saveFilterSet(newer, dir);

    const list = await listFilterSets(dir);
    expect(list.map((f) => f.id)).toEqual(['fs_newer', 'fs_older']);
  });

  it('deleteFilterSet removes the file; deleting a nonexistent id is a no-op', async () => {
    await saveFilterSet(sampleFilterSet, dir);
    await deleteFilterSet(dir, sampleFilterSet.id);
    expect(await listFilterSets(dir)).toEqual([]);

    // Second delete of the same (already-gone) id must not throw.
    await expect(deleteFilterSet(dir, sampleFilterSet.id)).resolves.toBeUndefined();
  });
});
