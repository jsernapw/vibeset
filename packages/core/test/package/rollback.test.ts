import { describe, expect, it } from 'vitest';
import { generateRollbackPlan, type PreDeployComponentState } from '../../src/package/rollback.js';
import { InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import { componentKeyString } from '../../src/util/component-key.js';

describe('generateRollbackPlan — inverse-package generation', () => {
  it('restores prior content for an originally-changed component', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'Foo' };
    const priorSnapshot = await store.put({ sourceId: 'target', key, lastModifiedDate: 'd1', content: 'public class Foo { /* old */ }' });

    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(key), { key, existed: true, sha256: priorSnapshot.sha256 }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [key], destructiveComponents: [], preDeployState },
      store,
    );

    expect(plan.destructiveComponents).toEqual([]);
    expect(plan.components).toEqual([key]);
    expect(plan.restoreContent.get(componentKeyString(key))).toBe('public class Foo { /* old */ }');
    expect(plan.skipped).toEqual([]);
  });

  it('deletes an originally-ADDED component that did not exist before the deploy (undoes the add)', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'BrandNew' };
    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(key), { key, existed: false }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [key], destructiveComponents: [], preDeployState },
      store,
    );

    expect(plan.components).toEqual([]);
    expect(plan.destructiveComponents).toEqual([key]);
    expect(plan.restoreContent.has(componentKeyString(key))).toBe(false);
  });

  it('recreates an originally-DELETED component that existed before the deploy', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'DeletedByDeploy' };
    const priorSnapshot = await store.put({ sourceId: 'target', key, lastModifiedDate: 'd1', content: 'public class DeletedByDeploy {}' });
    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(key), { key, existed: true, sha256: priorSnapshot.sha256 }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [], destructiveComponents: [key], preDeployState },
      store,
    );

    expect(plan.destructiveComponents).toEqual([]);
    expect(plan.components).toEqual([key]);
    expect(plan.restoreContent.get(componentKeyString(key))).toBe('public class DeletedByDeploy {}');
  });

  it('EDGE CASE: a destructive delete of a component that never existed pre-deploy is a no-op, recorded in skipped (not an error, not silently dropped)', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'NeverExisted' };
    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(key), { key, existed: false }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [], destructiveComponents: [key], preDeployState },
      store,
    );

    expect(plan.components).toEqual([]);
    expect(plan.destructiveComponents).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.key).toEqual(key);
    expect(plan.skipped[0]!.reason).toMatch(/no pre-deploy content/i);
  });

  it('EDGE CASE: missing pre-deploy state entirely for a key is treated the same as "did not exist" (fail safe, not a crash)', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'Untracked' };

    const plan = await generateRollbackPlan(
      { components: [key], destructiveComponents: [], preDeployState: new Map() },
      store,
    );

    expect(plan.destructiveComponents).toEqual([key]);
    expect(plan.components).toEqual([]);
  });

  it('EDGE CASE: pre-deploy state claims existed=true but the snapshot blob is no longer in the store — skipped with a clear reason, not a crash', async () => {
    const store = new InMemorySnapshotStore();
    const key = { type: 'ApexClass', fullName: 'GoneBlob' };
    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(key), { key, existed: true, sha256: 'deadbeef'.repeat(8) }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [key], destructiveComponents: [], preDeployState },
      store,
    );

    expect(plan.components).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toMatch(/no longer present/i);
  });

  it('handles a mixed rollback (add/update + destructive originals) in one call, producing the correct inverse for each', async () => {
    const store = new InMemorySnapshotStore();
    const changed = { type: 'ApexClass', fullName: 'Changed' };
    const added = { type: 'ApexClass', fullName: 'Added' };
    const deleted = { type: 'ApexClass', fullName: 'Deleted' };

    const changedPrior = await store.put({ sourceId: 't', key: changed, lastModifiedDate: 'd', content: 'old changed body' });
    const deletedPrior = await store.put({ sourceId: 't', key: deleted, lastModifiedDate: 'd', content: 'old deleted body' });

    const preDeployState = new Map<string, PreDeployComponentState>([
      [componentKeyString(changed), { key: changed, existed: true, sha256: changedPrior.sha256 }],
      [componentKeyString(added), { key: added, existed: false }],
      [componentKeyString(deleted), { key: deleted, existed: true, sha256: deletedPrior.sha256 }],
    ]);

    const plan = await generateRollbackPlan(
      { components: [changed, added], destructiveComponents: [deleted], preDeployState },
      store,
    );

    expect(plan.components.map((k) => k.fullName).sort()).toEqual(['Changed', 'Deleted']);
    expect(plan.destructiveComponents.map((k) => k.fullName)).toEqual(['Added']);
    expect(plan.restoreContent.get(componentKeyString(changed))).toBe('old changed body');
    expect(plan.restoreContent.get(componentKeyString(deleted))).toBe('old deleted body');
  });
});
