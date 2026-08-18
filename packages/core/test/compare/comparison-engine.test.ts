import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComparisonEngine } from '../../src/compare/comparison-engine.js';
import { InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import { componentKeyString } from '../../src/util/component-key.js';
import type {
  ComponentInventory,
  ComponentKey,
  MetadataSource,
  SourceTree,
  TypeFilter,
} from '../../src/types/metadata-source.js';

/**
 * A fake `org`-kind `MetadataSource` that writes real files to disk in
 * proper Salesforce source format on `materialize()` (so the comparison
 * engine's real `MetadataResolver`-based content reader exercises the same
 * code path it would against a real `OrgSource`), backed by an in-memory
 * component table for `inventory()`. No network — this is exactly the kind
 * of fake 1a/1b established for source tests (see
 * `test/sources/org-source.test.ts`).
 */
class FakeOrgSource implements MetadataSource {
  readonly kind = 'org' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly components: Map<string, { key: ComponentKey; lastModifiedDate: string; content: string }>,
  ) {}

  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const entries = [...this.components.values()]
      .filter((c) => !filter.types || filter.types.length === 0 || filter.types.includes(c.key.type))
      .map((c) => ({ key: c.key, lastModifiedDate: c.lastModifiedDate }));
    return { sourceId: this.id, entries };
  }

  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-fake-org-'));
    const files = new Map<string, string>();

    for (const key of keys) {
      const c = this.components.get(componentKeyString(key));
      if (!c) continue;

      if (key.type === 'Profile') {
        const relPath = `profiles/${key.fullName}.profile-meta.xml`;
        const abs = join(rootDir, relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, c.content);
        files.set(relPath, abs);
      } else if (key.type === 'ApexClass') {
        const clsRel = `classes/${key.fullName}.cls`;
        const metaRel = `classes/${key.fullName}.cls-meta.xml`;
        const clsAbs = join(rootDir, clsRel);
        const metaAbs = join(rootDir, metaRel);
        await mkdir(dirname(clsAbs), { recursive: true });
        await writeFile(clsAbs, c.content);
        await writeFile(
          metaAbs,
          '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
        );
        files.set(clsRel, clsAbs);
        files.set(metaRel, metaAbs);
      } else {
        throw new Error(`FakeOrgSource: unsupported type ${key.type} in test fixture`);
      }
    }

    return { sourceId: this.id, rootDir, files };
  }
}

function apexClassXml(): string {
  return 'public class Foo {}\n';
}

const withClassAccess = (name: string, enabled = 'true') => `
  <classAccesses>
    <apexClass>${name}</apexClass>
    <enabled>${enabled}</enabled>
  </classAccesses>`;

function profileXml(...body: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${body.join('')}\n</Profile>\n`;
}

describe('ComparisonEngine', () => {
  it('reports new/changed/deleted/identical across two sources for plain (non-Profile) types', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeOrgSource(
      'left',
      'Left Org',
      new Map([
        [componentKeyString({ type: 'ApexClass', fullName: 'Same' }), { key: { type: 'ApexClass', fullName: 'Same' }, lastModifiedDate: 'd1', content: 'public class Same {}\n' }],
        [componentKeyString({ type: 'ApexClass', fullName: 'Changed' }), { key: { type: 'ApexClass', fullName: 'Changed' }, lastModifiedDate: 'd1', content: 'public class Changed { Integer v = 1; }\n' }],
        [componentKeyString({ type: 'ApexClass', fullName: 'OnlyLeft' }), { key: { type: 'ApexClass', fullName: 'OnlyLeft' }, lastModifiedDate: 'd1', content: 'public class OnlyLeft {}\n' }],
      ]),
    );
    const right = new FakeOrgSource(
      'right',
      'Right Org',
      new Map([
        [componentKeyString({ type: 'ApexClass', fullName: 'Same' }), { key: { type: 'ApexClass', fullName: 'Same' }, lastModifiedDate: 'd1', content: 'public class Same {}\n' }],
        [componentKeyString({ type: 'ApexClass', fullName: 'Changed' }), { key: { type: 'ApexClass', fullName: 'Changed' }, lastModifiedDate: 'd1', content: 'public class Changed { Integer v = 2; }\n' }],
        [componentKeyString({ type: 'ApexClass', fullName: 'OnlyRight' }), { key: { type: 'ApexClass', fullName: 'OnlyRight' }, lastModifiedDate: 'd1', content: 'public class OnlyRight {}\n' }],
      ]),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-1', filter: { types: ['ApexClass'] } });

    // Per the established (1b) convention — see fixtures `new-component` /
    // `deleted-component` — left is the "before" operand and right is
    // "after": present in right only -> 'new', present in left only ->
    // 'deleted'. (For package generation, callers present
    // left=target-org/before and right=desired-source/after so that 'new'
    // + 'changed' become the add/update set and 'deleted' the destructive
    // set — see package/selection.ts.)
    const byName = new Map(result.results.map((r) => [r.key.fullName, r.status]));
    expect(byName.get('Same')).toBe('identical');
    expect(byName.get('Changed')).toBe('changed');
    expect(byName.get('OnlyLeft')).toBe('deleted');
    expect(byName.get('OnlyRight')).toBe('new');
    expect(result.summary).toEqual({ new: 1, changed: 1, deleted: 1, identical: 1 });
  });

  it('reuses the content-addressed cache on a second run: identical components resolve without re-materializing', async () => {
    const store = new InMemorySnapshotStore();
    const content = new Map([
      [componentKeyString({ type: 'ApexClass', fullName: 'A' }), { key: { type: 'ApexClass', fullName: 'A' }, lastModifiedDate: 'd1', content: apexClassXml() }],
    ]);
    const left = new FakeOrgSource('left', 'Left Org', content);
    const right = new FakeOrgSource('right', 'Right Org', content);
    const engine = new ComparisonEngine(store);

    const first = await engine.run(left, right, { comparisonId: 'cmp-a', filter: { types: ['ApexClass'] } });
    expect(first.summary.identical).toBe(1);
    const statsAfterFirst = await store.stats();
    expect(statsAfterFirst.misses).toBeGreaterThan(0); // nothing cached yet on the first run

    const second = await engine.run(left, right, { comparisonId: 'cmp-b', filter: { types: ['ApexClass'] } });
    expect(second.summary.identical).toBe(1);
    const statsAfterSecond = await store.stats();
    expect(statsAfterSecond.hits).toBeGreaterThan(statsAfterFirst.hits); // second run hit the cache
  });

  it('SCOPED ORG COMPARISON: does not report a spurious Profile permission deletion when the referenced component is outside the comparison filter', async () => {
    // The hazard this test guards against: a Profile compared with a
    // TypeFilter that does not include ApexClass never has ApexClass
    // co-retrieved with it. Per the Metadata API's own retrieve-pairing
    // behavior, a Profile fetched that way legitimately lacks entries for
    // classes outside the request — that is NOT evidence the permission was
    // removed. A naive full-coverage diff would report this as a deletion;
    // a deployment built from that diff would then strip real class access
    // from the target org with no warning. See diff/profiles.ts and
    // compare/coverage.ts for the full hazard writeup.
    const store = new InMemorySnapshotStore();
    const leftProfile = profileXml(withClassAccess('Foo'));
    // Right's Profile retrieve was never paired with ApexClass (the filter
    // below only asks for 'Profile'), so its content legitimately has no
    // classAccesses entry for Foo at all — indistinguishable, from the
    // content alone, from Foo's access having been genuinely revoked.
    const rightProfile = profileXml();

    const left = new FakeOrgSource(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'Profile', fullName: 'Admin' }), { key: { type: 'Profile', fullName: 'Admin' }, lastModifiedDate: 'd1', content: leftProfile }]]),
    );
    const right = new FakeOrgSource(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'Profile', fullName: 'Admin' }), { key: { type: 'Profile', fullName: 'Admin' }, lastModifiedDate: 'd1', content: rightProfile }]]),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-scoped', filter: { types: ['Profile'] } });

    expect(result.results).toHaveLength(1);
    const admin = result.results[0]!;
    // The whole-component status must NOT be 'changed' purely from the
    // ambiguous absence — this is the exact bug class this test exists to
    // catch. No DiffEntry anywhere in the tree may be reported 'deleted'
    // for the Foo class access.
    expect(admin.status).toBe('identical');
    const classAccesses = admin.entries?.find((e) => e.key === 'classAccesses');
    const fooEntry = classAccesses?.children?.find((e) => e.key === 'Foo');
    expect(fooEntry?.status ?? 'identical').not.toBe('deleted');
  });

  it('CONTROL CASE: the same Profile content DOES report a genuine deletion once ApexClass is included in the comparison scope and truly absent on the target', async () => {
    // Sanity check that the safety fix above isn't just suppressing all
    // Profile diffs outright — when the referenced component genuinely IS
    // in scope on both sides (both orgs' ApexClass inventories are part of
    // this comparison) and the permission entry is truly gone, it must
    // still be reported.
    const store = new InMemorySnapshotStore();
    const leftProfile = profileXml(withClassAccess('Foo'));
    const rightProfile = profileXml(); // genuinely revoked, not just narrowly-retrieved

    const leftComponents = new Map([
      [componentKeyString({ type: 'Profile', fullName: 'Admin' }), { key: { type: 'Profile', fullName: 'Admin' }, lastModifiedDate: 'd1', content: leftProfile }],
      [componentKeyString({ type: 'ApexClass', fullName: 'Foo' }), { key: { type: 'ApexClass', fullName: 'Foo' }, lastModifiedDate: 'd1', content: apexClassXml() }],
    ]);
    const rightComponents = new Map([
      [componentKeyString({ type: 'Profile', fullName: 'Admin' }), { key: { type: 'Profile', fullName: 'Admin' }, lastModifiedDate: 'd1', content: rightProfile }],
      [componentKeyString({ type: 'ApexClass', fullName: 'Foo' }), { key: { type: 'ApexClass', fullName: 'Foo' }, lastModifiedDate: 'd1', content: apexClassXml() }],
    ]);

    const left = new FakeOrgSource('left', 'Left Org', leftComponents);
    const right = new FakeOrgSource('right', 'Right Org', rightComponents);

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-control', filter: { types: ['Profile', 'ApexClass'] } });

    const admin = result.results.find((r) => r.key.type === 'Profile')!;
    expect(admin.status).toBe('changed');
    const classAccesses = admin.entries?.find((e) => e.key === 'classAccesses');
    const fooEntry = classAccesses?.children?.find((e) => e.key === 'Foo');
    expect(fooEntry?.status).toBe('deleted');
  });
});
