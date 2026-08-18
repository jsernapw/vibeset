import { describe, expect, it } from 'vitest';
import { InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import { sha256Hex } from '../../src/hash.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

const key: ComponentKey = { type: 'ApexClass', fullName: 'Foo' };

describe('InMemorySnapshotStore', () => {
  it('misses on an unknown key', async () => {
    const store = new InMemorySnapshotStore();
    expect(await store.lookup({ sourceId: 's1', key, lastModifiedDate: '2026-01-01' })).toBeUndefined();
    const stats = await store.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it('hits after a put with the same (sourceId, key, lastModifiedDate)', async () => {
    const store = new InMemorySnapshotStore();
    await store.put({ sourceId: 's1', key, lastModifiedDate: '2026-01-01', content: 'public class Foo {}' });
    const sha = await store.lookup({ sourceId: 's1', key, lastModifiedDate: '2026-01-01' });
    expect(sha).toBe(sha256Hex('public class Foo {}'));
    const stats = await store.stats();
    expect(stats.hits).toBe(1);
  });

  it('dedupes identical content across different refs into a single blob', async () => {
    const store = new InMemorySnapshotStore();
    const content = 'public class Foo {}';
    await store.put({ sourceId: 'org-a', key, lastModifiedDate: '2026-01-01', content });
    await store.put({ sourceId: 'org-b', key, lastModifiedDate: '2026-06-01', content });

    const stats = await store.stats();
    expect(stats.blobCount).toBe(1);
    expect(stats.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('stores distinct blobs for distinct content and accumulates bytesSaved only on hits', async () => {
    const store = new InMemorySnapshotStore();
    await store.put({ sourceId: 's1', key, lastModifiedDate: 'v1', content: 'aaaa' });
    await store.put({ sourceId: 's1', key, lastModifiedDate: 'v2', content: 'bbbbbbbb' });

    let stats = await store.stats();
    expect(stats.blobCount).toBe(2);
    expect(stats.bytesSaved).toBe(0);

    // A hit against v1 should add its 4 bytes to bytesSaved.
    await store.lookup({ sourceId: 's1', key, lastModifiedDate: 'v1' });
    stats = await store.stats();
    expect(stats.bytesSaved).toBe(4);
  });

  it('retrieves a blob directly by sha256', async () => {
    const store = new InMemorySnapshotStore();
    const snap = await store.put({ sourceId: 's1', key, lastModifiedDate: '2026-01-01', content: 'x' });
    const blob = await store.getBlob(snap.sha256);
    expect(blob?.content).toBe('x');
    expect(await store.getBlob('deadbeef')).toBeUndefined();
  });

  it('treats a changed lastModifiedDate as a distinct cache entry (miss)', async () => {
    const store = new InMemorySnapshotStore();
    await store.put({ sourceId: 's1', key, lastModifiedDate: '2026-01-01', content: 'v1' });
    expect(await store.lookup({ sourceId: 's1', key, lastModifiedDate: '2026-02-01' })).toBeUndefined();
  });
});
