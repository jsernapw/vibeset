import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SnapshotContentSource } from '../../src/deploy/rollback-source.js';
import { componentKeyString } from '../../src/util/component-key.js';

describe('SnapshotContentSource — materializes in-memory rollback content into real source-format files', () => {
  it('writes an ApexClass body + a synthesized meta.xml sidecar (matchingContentFile convention)', async () => {
    const key = { type: 'ApexClass', fullName: 'RestoredClass' };
    const source = new SnapshotContentSource('rollback', 'Rollback', new Map([[componentKeyString(key), 'public class RestoredClass { Integer v = 42; }']]));

    const tree = await source.materialize([key]);
    expect(tree.missing).toBeUndefined();

    const clsPath = [...tree.files.keys()].find((p) => p.endsWith('.cls'))!;
    const metaPath = [...tree.files.keys()].find((p) => p.endsWith('.cls-meta.xml'))!;
    expect(clsPath).toBeDefined();
    expect(metaPath).toBeDefined();

    const body = await readFile(tree.files.get(clsPath)!, 'utf8');
    expect(body).toContain('Integer v = 42');
    const meta = await readFile(tree.files.get(metaPath)!, 'utf8');
    expect(meta).toContain('<apiVersion>');
  });

  it('writes a structural XML type (Profile) directly as its metadata file', async () => {
    const key = { type: 'Profile', fullName: 'Admin' };
    const content = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"></Profile>\n';
    const source = new SnapshotContentSource('rollback', 'Rollback', new Map([[componentKeyString(key), content]]));

    const tree = await source.materialize([key]);
    expect(tree.files.size).toBe(1);
    const [relPath, absPath] = [...tree.files.entries()][0]!;
    expect(relPath).toContain('profiles');
    expect(relPath).toContain('Admin.profile-meta.xml');
    expect(await readFile(absPath, 'utf8')).toBe(content);
  });

  it('reports a key with no available content as missing rather than throwing', async () => {
    const key = { type: 'ApexClass', fullName: 'NoContent' };
    const source = new SnapshotContentSource('rollback', 'Rollback', new Map());
    const tree = await source.materialize([key]);
    expect(tree.missing).toEqual([{ key, reason: 'No pre-deploy content available for this component.' }]);
    expect(tree.files.size).toBe(0);
  });

  it('reports a bundle-type component (LightningComponentBundle) as missing rather than writing something wrong', async () => {
    const key = { type: 'LightningComponentBundle', fullName: 'myComponent' };
    const source = new SnapshotContentSource('rollback', 'Rollback', new Map([[componentKeyString(key), 'irrelevant']]));
    const tree = await source.materialize([key]);
    expect(tree.missing).toHaveLength(1);
    expect(tree.missing![0]!.reason).toMatch(/bundle/i);
  });

  it('returns an empty tree for an empty keys list', async () => {
    const source = new SnapshotContentSource('rollback', 'Rollback', new Map());
    const tree = await source.materialize([]);
    expect(tree.rootDir).toBe('');
    expect(tree.files.size).toBe(0);
  });
});
