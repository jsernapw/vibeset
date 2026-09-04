import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * End-to-end coverage of the binary-type comparison path (StaticResource):
 * `ComparisonEngine.diffAll` must route these through content-hash
 * comparison (`diffBinaryComponent`), never `diff/dispatch.ts`'s XML/text
 * differ, and the resulting `DiffResult` must carry `binary: true` with no
 * `entries`/`textDiff` — the "sensible UI contract for binary, changed"
 * the task calls for.
 */
class FakeBinaryOrgSource implements MetadataSource {
  readonly kind = 'org' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly resources: Map<string, { key: ComponentKey; lastModifiedDate: string; body: Buffer }>,
  ) {}

  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const entries = [...this.resources.values()]
      .filter((c) => !filter.types || filter.types.length === 0 || filter.types.includes(c.key.type))
      .map((c) => ({ key: c.key, lastModifiedDate: c.lastModifiedDate }));
    return { sourceId: this.id, entries };
  }

  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-fake-binary-org-'));
    const files = new Map<string, string>();
    const dir = join(rootDir, 'staticresources');
    await mkdir(dir, { recursive: true });

    for (const key of keys) {
      const c = this.resources.get(componentKeyString(key));
      if (!c) continue;
      const bodyRel = `staticresources/${key.fullName}.resource`;
      const metaRel = `staticresources/${key.fullName}.resource-meta.xml`;
      const bodyAbs = join(rootDir, bodyRel);
      const metaAbs = join(rootDir, metaRel);
      await writeFile(bodyAbs, c.body);
      await writeFile(
        metaAbs,
        '<?xml version="1.0" encoding="UTF-8"?>\n<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl><contentType>application/zip</contentType></StaticResource>\n',
      );
      files.set(bodyRel, bodyAbs);
      files.set(metaRel, metaAbs);
    }

    return { sourceId: this.id, rootDir, files };
  }
}

function resourceEntry(fullName: string, body: Buffer) {
  return {
    key: { type: 'StaticResource', fullName },
    lastModifiedDate: 'd1',
    body,
  };
}

/**
 * Simulates the confirmed ARM DEV `BadZipFile` failure mode (see
 * `sources/org-source.ts`'s `convertWithIsolation` doc comment and
 * `test/sources/org-source.test.ts`'s BadZipFile-style tests): a component
 * IS listed by `inventory()` — Salesforce genuinely has it — but its local
 * conversion fails, so `materialize()` writes NO files for it at all (the
 * real `OrgSource` records this in `SourceTree.missing` instead). This is
 * exactly the "present in inventory, unreadable content" state that used
 * to collapse into `left === undefined && right === undefined` and get
 * misreported as `'identical'`.
 */
class FakeBinaryOrgSourceWithUnreadable implements MetadataSource {
  readonly kind = 'org' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly resources: Map<string, { key: ComponentKey; lastModifiedDate: string; body: Buffer }>,
    private readonly unreadableFullNames: ReadonlySet<string>,
  ) {}

  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const entries = [...this.resources.values()]
      .filter((c) => !filter.types || filter.types.length === 0 || filter.types.includes(c.key.type))
      .map((c) => ({ key: c.key, lastModifiedDate: c.lastModifiedDate }));
    return { sourceId: this.id, entries };
  }

  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-fake-binary-org-unreadable-'));
    const files = new Map<string, string>();
    const dir = join(rootDir, 'staticresources');
    await mkdir(dir, { recursive: true });
    const missing: { key: ComponentKey; reason: string }[] = [];

    for (const key of keys) {
      if (this.unreadableFullNames.has(key.fullName)) {
        // Real conversion failure: retrieve succeeded but SDR's
        // MetadataConverter threw for this component, so nothing was ever
        // written for it — matches `convertWithIsolation`'s behavior.
        missing.push({ key, reason: 'BadZipFile: Unable to open zip file' });
        continue;
      }
      const c = this.resources.get(componentKeyString(key));
      if (!c) continue;
      const bodyRel = `staticresources/${key.fullName}.resource`;
      const metaRel = `staticresources/${key.fullName}.resource-meta.xml`;
      const bodyAbs = join(rootDir, bodyRel);
      const metaAbs = join(rootDir, metaRel);
      await writeFile(bodyAbs, c.body);
      await writeFile(
        metaAbs,
        '<?xml version="1.0" encoding="UTF-8"?>\n<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl><contentType>application/zip</contentType></StaticResource>\n',
      );
      files.set(bodyRel, bodyAbs);
      files.set(metaRel, metaAbs);
    }

    return { sourceId: this.id, rootDir, files, missing };
  }
}

describe('ComparisonEngine — binary types (StaticResource)', () => {
  it('reports status "changed" with binary:true and no entries/textDiff when body bytes differ', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeBinaryOrgSource(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'Widget' }), resourceEntry('Widget', Buffer.from([0x01, 0x02, 0x03]))]]),
    );
    const right = new FakeBinaryOrgSource(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'Widget' }), resourceEntry('Widget', Buffer.from([0x01, 0x02, 0xff]))]]),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-1', filter: { types: ['StaticResource'] } });

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).toBe('changed');
    expect(r.binary).toBe(true);
    expect(r.entries).toBeUndefined();
    expect(r.textDiff).toBeUndefined();
    expect(r.leftSha256).toBeDefined();
    expect(r.rightSha256).toBeDefined();
    expect(r.leftSha256).not.toBe(r.rightSha256);
  });

  it('reports status "identical" with binary:true when body bytes match exactly', async () => {
    const store = new InMemorySnapshotStore();
    const body = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const left = new FakeBinaryOrgSource(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'Widget' }), resourceEntry('Widget', body)]]),
    );
    const right = new FakeBinaryOrgSource(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'Widget' }), resourceEntry('Widget', Buffer.from(body))]]),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-2', filter: { types: ['StaticResource'] } });

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).toBe('identical');
    expect(r.binary).toBe(true);
    expect(r.leftSha256).toBe(r.rightSha256);
  });

  it('reports status "new"/"deleted" (with binary:true) when a StaticResource exists on only one side', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeBinaryOrgSource(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'OnlyLeft' }), resourceEntry('OnlyLeft', Buffer.from([0x01]))]]),
    );
    const right = new FakeBinaryOrgSource(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'OnlyRight' }), resourceEntry('OnlyRight', Buffer.from([0x02]))]]),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-3', filter: { types: ['StaticResource'] } });

    const byName = new Map(result.results.map((r) => [r.key.fullName, r]));
    expect(byName.get('OnlyLeft')?.status).toBe('deleted');
    expect(byName.get('OnlyLeft')?.binary).toBe(true);
    expect(byName.get('OnlyRight')?.status).toBe('new');
    expect(byName.get('OnlyRight')?.binary).toBe(true);
  });

  /**
   * THE BUG FIXED BY THIS PR (flagged in PR #9's review of `diffBinaryComponent`):
   * a StaticResource that genuinely exists on BOTH sides (present in both
   * inventories) but whose content fails to convert/read on BOTH sides
   * (the ARM DEV `omnistudio__` `BadZipFile` scenario) used to be reported
   * as `status: 'identical'` — the worst failure mode on a comparison
   * tool, since it tells the user two things match when neither side could
   * even be examined. It must now be reported as `'changed'` (the closest
   * honest answer in the fixed `DiffStatus` vocabulary) with
   * `unreadable: { left: true, right: true }` so a consumer can render
   * "could not compare" instead of either a false match or a normal binary
   * diff.
   */
  it('never reports "identical" when content is unreadable on BOTH sides — reports changed + unreadable instead', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeBinaryOrgSourceWithUnreadable(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'omnistudio__Bad' }), resourceEntry('omnistudio__Bad', Buffer.from([0x01]))]]),
      new Set(['omnistudio__Bad']),
    );
    const right = new FakeBinaryOrgSourceWithUnreadable(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'omnistudio__Bad' }), resourceEntry('omnistudio__Bad', Buffer.from([0x02]))]]),
      new Set(['omnistudio__Bad']),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-unreadable-both', filter: { types: ['StaticResource'] } });

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).not.toBe('identical');
    expect(r.status).toBe('changed');
    expect(r.binary).toBe(true);
    expect(r.unreadable).toEqual({ left: true, right: true });
    expect(r.leftSha256).toBeUndefined();
    expect(r.rightSha256).toBeUndefined();
  });

  it('reports unreadable + changed (not new/deleted) when content is unreadable on only ONE side but the component exists on both', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeBinaryOrgSourceWithUnreadable(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'HalfBad' }), resourceEntry('HalfBad', Buffer.from([0x01]))]]),
      new Set(['HalfBad']),
    );
    const right = new FakeBinaryOrgSourceWithUnreadable(
      'right',
      'Right Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'HalfBad' }), resourceEntry('HalfBad', Buffer.from([0x02]))]]),
      new Set(),
    );

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-unreadable-one', filter: { types: ['StaticResource'] } });

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).toBe('changed');
    expect(r.binary).toBe(true);
    expect(r.unreadable).toEqual({ left: true, right: undefined });
    expect(r.leftSha256).toBeUndefined();
    expect(r.rightSha256).toBeDefined();
  });

  it('does not fabricate unreadable when a component genuinely exists on only one side (no false new/deleted regression)', async () => {
    const store = new InMemorySnapshotStore();
    const left = new FakeBinaryOrgSourceWithUnreadable(
      'left',
      'Left Org',
      new Map([[componentKeyString({ type: 'StaticResource', fullName: 'OnlyLeft2' }), resourceEntry('OnlyLeft2', Buffer.from([0x01]))]]),
      new Set(),
    );
    const right = new FakeBinaryOrgSourceWithUnreadable('right', 'Right Org', new Map(), new Set());

    const engine = new ComparisonEngine(store);
    const result = await engine.run(left, right, { comparisonId: 'cmp-bin-genuine-onlyleft', filter: { types: ['StaticResource'] } });

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).toBe('deleted');
    expect(r.unreadable).toBeUndefined();
    expect(r.leftSha256).toBeDefined();
  });
});
