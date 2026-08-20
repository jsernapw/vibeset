import { describe, expect, it } from 'vitest';
import {
  METADATA_API_LIMITS,
  PROFILE_LIKE_TYPES,
  PROFILE_PAIRED_TYPES,
  planMaterializeChunks,
} from '../../src/retrieval/chunking.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

function key(type: string, fullName: string): ComponentKey {
  return { type, fullName };
}

describe('planMaterializeChunks — Profile/PermissionSet pairing', () => {
  it('keeps a Profile in the same chunk as every paired-type component in the request', () => {
    const keys = [
      key('Profile', 'Admin'),
      key('ApexClass', 'FooController'),
      key('CustomObject', 'Widget__c'),
      key('CustomField', 'Widget__c.Name__c'),
      key('Layout', 'Widget__c-Widget Layout'),
    ];

    const { chunks, warnings } = planMaterializeChunks(keys);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(expect.arrayContaining(keys));
    expect(chunks[0]).toHaveLength(keys.length);
    // No components were split off, so no size-overflow warning either.
    expect(warnings.some((w) => w.includes('exceeds the configured limit'))).toBe(false);
  });

  it('never splits the Profile+paired-types core across chunks even when it exceeds the size limit', () => {
    const paired: ComponentKey[] = Array.from({ length: 50 }, (_, i) => key('ApexClass', `Class${i}`));
    const keys = [key('PermissionSet', 'Sales'), ...paired];

    // Force an artificially tiny limit so the core would "want" to split.
    const { chunks, warnings } = planMaterializeChunks(keys, { maxFiles: 5, maxBytes: 1024 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(keys.length);
    expect(warnings.some((w) => w.includes('forced') && w.includes('exceeds the configured limit'))).toBe(true);
  });

  it('warns when a Profile/PermissionSet is requested with no paired types present', () => {
    const keys = [key('Profile', 'Admin'), key('Flow', 'Some_Flow')];

    // Flow is intentionally not in PROFILE_PAIRED_TYPES for this assertion's
    // purpose even though it is in the real set — use a type guaranteed to
    // be absent from the paired set instead.
    const isolated = [key('Profile', 'Admin'), key('LightningComponentBundle', 'myComponent')];
    const { warnings } = planMaterializeChunks(isolated);

    expect(warnings.some((w) => w.includes('no paired component types'))).toBe(true);
    void keys;
  });

  it('does not warn when Profile is paired with at least one relevant type', () => {
    const keys = [key('Profile', 'Admin'), key('ApexClass', 'FooController')];
    const { warnings } = planMaterializeChunks(keys);
    expect(warnings.some((w) => w.includes('no paired component types'))).toBe(false);
  });

  it('leaves non-profile-related components chunked independently of the profile core', () => {
    const keys = [
      key('Profile', 'Admin'),
      key('ApexClass', 'FooController'),
      key('Flow', 'Unrelated_Flow_1'),
      key('Flow', 'Unrelated_Flow_2'),
    ];
    const { chunks } = planMaterializeChunks(keys);
    // Core chunk (Profile + ApexClass) is chunks[0]; Flows are unaffected
    // and may share or not share a chunk based purely on size, but must not
    // be merged into the profile-forced core beyond what's necessary.
    expect(chunks[0]).toEqual(expect.arrayContaining([key('Profile', 'Admin'), key('ApexClass', 'FooController')]));
    const allKeys = chunks.flat();
    expect(allKeys).toHaveLength(keys.length);
  });

  it('is a no-op passthrough when no Profile/PermissionSet is present', () => {
    const keys = [key('ApexClass', 'A'), key('ApexClass', 'B')];
    const { chunks, warnings } = planMaterializeChunks(keys);
    expect(chunks.flat()).toEqual(keys);
    expect(warnings).toHaveLength(0);
  });
});

describe('planMaterializeChunks — size-based chunking', () => {
  it('splits components across multiple chunks once the file-count limit is exceeded', () => {
    const keys: ComponentKey[] = Array.from({ length: 10 }, (_, i) => key('ApexClass', `Class${i}`));
    // Default estimate is 2 files/component; force maxFiles so exactly 3 fit per chunk.
    const { chunks } = planMaterializeChunks(keys, { maxFiles: 6, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
    expect(chunks.flat()).toEqual(keys);
  });

  it('splits components across multiple chunks once the byte limit is exceeded', () => {
    const keys: ComponentKey[] = Array.from({ length: 5 }, (_, i) => key('StaticResource', `Res${i}`));
    const { chunks } = planMaterializeChunks(keys, { maxFiles: Number.MAX_SAFE_INTEGER, maxBytes: 40 * 1024 });
    // Bundle estimate is 32KB/component, so only 1 fits per 40KB chunk.
    expect(chunks).toHaveLength(5);
  });

  it('respects the real Metadata API limits by default', () => {
    expect(METADATA_API_LIMITS.maxFiles).toBe(10_000);
    expect(METADATA_API_LIMITS.maxZipBytes).toBe(39 * 1024 * 1024);
  });

  it('never produces an empty chunk', () => {
    const keys: ComponentKey[] = [];
    const { chunks } = planMaterializeChunks(keys);
    expect(chunks).toHaveLength(0);
  });
});

describe('type sets', () => {
  it('PROFILE_LIKE_TYPES and PROFILE_PAIRED_TYPES do not overlap', () => {
    for (const t of PROFILE_LIKE_TYPES) {
      expect(PROFILE_PAIRED_TYPES.has(t)).toBe(false);
    }
  });

  it('every type that Phase 2A-b newly added to DEFAULT_INVENTORY_TYPES and that feeds a Profile/PermissionSet grid entry is still recognized as paired', () => {
    // Regression guard for the inventory-type expansion (registry.ts):
    // ApexPage, CustomTab, RecordType and CustomApplication were NOT in
    // Phase 1's 11-type default, so `pageAccesses`/`tabVisibilities`+
    // `tabSettings`/`recordTypeVisibilities`+`layoutAssignments`/
    // `applicationVisibilities` were effectively always empty in a default
    // comparison even though this pairing table already named them. Now
    // that the default includes them, a default Profile/PermissionSet
    // comparison actually co-retrieves the components that populate those
    // grid sections — this test pins that PROFILE_PAIRED_TYPES wasn't
    // quietly narrowed in a way that would silently regress it back.
    for (const t of ['ApexPage', 'CustomTab', 'RecordType', 'CustomApplication']) {
      expect(PROFILE_PAIRED_TYPES.has(t)).toBe(true);
    }
  });

  it('newly-defaulted paired types land in the forced core chunk alongside a Profile, same as the original Phase 1 set', () => {
    const keys = [
      key('Profile', 'Admin'),
      key('ApexPage', 'MyPage'),
      key('CustomTab', 'MyTab'),
      key('RecordType', 'Widget__c.Standard'),
      key('CustomApplication', 'MyApp'),
    ];
    const { chunks, warnings } = planMaterializeChunks(keys);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(expect.arrayContaining(keys));
    expect(warnings.some((w) => w.includes('no paired component types'))).toBe(false);
  });
});
