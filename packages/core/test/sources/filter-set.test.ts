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
  toFilterSet,
  type FilterSet,
  type FilterSetDraft,
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
    const filePath = await saveFilterSet(dir, sampleFilterSet);
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
    await saveFilterSet(dir, older);
    await saveFilterSet(dir, newer);

    const list = await listFilterSets(dir);
    expect(list.map((f) => f.id)).toEqual(['fs_newer', 'fs_older']);
  });

  it('deleteFilterSet removes the file; deleting a nonexistent id is a no-op', async () => {
    await saveFilterSet(dir, sampleFilterSet);
    await deleteFilterSet(dir, sampleFilterSet.id);
    expect(await listFilterSets(dir)).toEqual([]);

    // Second delete of the same (already-gone) id must not throw.
    await expect(deleteFilterSet(dir, sampleFilterSet.id)).resolves.toBeUndefined();
  });

  /**
   * Regression coverage for the version-stamping footgun: previously
   * `saveFilterSet` trusted its caller to have set
   * `vibesetFilterSetVersion` and would happily write a file without one,
   * which `loadFilterSet` then refused to read back ("Unsupported filter
   * set version undefined") — reachable within two minutes of a caller
   * constructing a `FilterSet`-shaped object by hand instead of going
   * through a version-stamping builder. `saveFilterSet` now takes a
   * `FilterSetDraft` (the `FilterSet` shape minus the version field, so
   * there is no field to omit or get wrong) and stamps the version itself
   * via `toFilterSet`, mirroring `package/manifest.ts`'s `toManifest`.
   */
  it('saveFilterSet stamps the schema version itself — the caller cannot omit it, and loadFilterSet reads the result back without throwing', async () => {
    const draft: FilterSetDraft = {
      id: 'fs_no_version_supplied',
      name: 'No version field at all',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      filter: { types: ['ApexClass'] },
    };
    // `draft` has no `vibesetFilterSetVersion` key whatsoever — this is
    // exactly the shape a caller who forgot to stamp one would produce,
    // and `FilterSetDraft`'s type is what makes that the ONLY shape
    // `saveFilterSet` accepts, not an accident of this particular object.
    expect('vibesetFilterSetVersion' in draft).toBe(false);

    const filePath = await saveFilterSet(dir, draft);

    // The actual bug, reproduced and fixed: this used to throw
    // "Unsupported filter set version undefined".
    const loaded = await loadFilterSet(filePath);
    expect(loaded.vibesetFilterSetVersion).toBe(FILTER_SET_SCHEMA_VERSION);
    expect(loaded).toEqual(toFilterSet(draft));
  });

  it('toFilterSet is the single sanctioned builder — always stamps the current schema version regardless of what (if anything) the draft carries', () => {
    const draft: FilterSetDraft = {
      id: 'fs_builder',
      name: 'Built via toFilterSet',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      filter: {},
    };
    expect(toFilterSet(draft)).toEqual({ ...draft, vibesetFilterSetVersion: FILTER_SET_SCHEMA_VERSION });
  });
});
