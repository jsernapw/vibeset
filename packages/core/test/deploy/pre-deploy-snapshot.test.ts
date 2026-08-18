import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capturePreDeployState } from '../../src/deploy/pre-deploy-snapshot.js';
import { InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import { componentKeyString } from '../../src/util/component-key.js';
import type { ComponentInventory, ComponentKey, MetadataSource, SourceTree, TypeFilter } from '../../src/types/metadata-source.js';

/** Same fixture-writing convention as the other org-source fakes in this suite. */
class FakeTargetOrgSource implements MetadataSource {
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
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-predeploy-test-'));
    const files = new Map<string, string>();
    for (const key of keys) {
      const c = this.components.get(componentKeyString(key));
      if (!c) continue;
      const clsRel = `classes/${key.fullName}.cls`;
      const metaRel = `classes/${key.fullName}.cls-meta.xml`;
      const clsAbs = join(rootDir, clsRel);
      await mkdir(dirname(clsAbs), { recursive: true });
      await writeFile(clsAbs, c.content);
      await writeFile(
        join(rootDir, metaRel),
        '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
      );
      files.set(clsRel, clsAbs);
      files.set(metaRel, join(rootDir, metaRel));
    }
    return { sourceId: this.id, rootDir, files };
  }
}

describe('capturePreDeployState', () => {
  it('records existed: true with a real sha256 for a component present in the target, and stores it in the SnapshotStore', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'Existing' };
    const target = new FakeTargetOrgSource(
      'target',
      'Target Org',
      new Map([[componentKeyString(key), { key, lastModifiedDate: 'd1', content: 'public class Existing { Integer v = 1; }' }]]),
    );

    const state = await capturePreDeployState({ targetSource: target, keys: [key], store });

    const entry = state.get(componentKeyString(key))!;
    expect(entry.existed).toBe(true);
    expect(entry.sha256).toBeDefined();

    const blob = await store.getBlob(entry.sha256!);
    expect(blob?.content).toContain('Integer v = 1');
  });

  it('records existed: false for a component absent from the target, without materializing it', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'DoesNotExistYet' };
    const target = new FakeTargetOrgSource('target', 'Target Org', new Map());

    const state = await capturePreDeployState({ targetSource: target, keys: [key], store });

    const entry = state.get(componentKeyString(key))!;
    expect(entry.existed).toBe(false);
    expect(entry.sha256).toBeUndefined();
  });

  it('handles a mix of existing and absent components in one call', async () => {
    const store = new InMemorySnapshotStore();
    const existingKey = { type: 'ApexClass', fullName: 'Existing' };
    const absentKey = { type: 'ApexClass', fullName: 'Absent' };
    const target = new FakeTargetOrgSource(
      'target',
      'Target Org',
      new Map([[componentKeyString(existingKey), { key: existingKey, lastModifiedDate: 'd1', content: 'public class Existing {}' }]]),
    );

    const state = await capturePreDeployState({ targetSource: target, keys: [existingKey, absentKey], store });

    expect(state.get(componentKeyString(existingKey))!.existed).toBe(true);
    expect(state.get(componentKeyString(absentKey))!.existed).toBe(false);
  });

  it('returns an empty map for an empty keys list without touching the source at all', async () => {
    const store = new InMemorySnapshotStore();
    const target = new FakeTargetOrgSource('target', 'Target Org', new Map());
    const state = await capturePreDeployState({ targetSource: target, keys: [], store });
    expect(state.size).toBe(0);
  });
});
