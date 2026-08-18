import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SfdxProjectSource } from '../../src/sources/sfdx-project-source.js';

let projectDir: string;

async function writeFileDeep(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'vibeset-sfdx-project-test-'));

  await writeFileDeep(
    join(projectDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }),
  );

  await writeFileDeep(
    join(projectDir, 'force-app/main/default/classes/FooController.cls'),
    'public class FooController {}',
  );
  await writeFileDeep(
    join(projectDir, 'force-app/main/default/classes/FooController.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );

  await writeFileDeep(
    join(projectDir, 'force-app/main/default/objects/Widget__c/Widget__c.object-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Widget</label></CustomObject>\n',
  );
  await writeFileDeep(
    join(projectDir, 'force-app/main/default/objects/Widget__c/fields/Name__c.field-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Name__c</fullName><type>Text</type></CustomField>\n',
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('SfdxProjectSource.inventory', () => {
  it('resolves components from the package directories declared in sfdx-project.json', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const inventory = await source.inventory({});

    const byType = new Map(inventory.entries.map((e) => [`${e.key.type}#${e.key.fullName}`, e]));
    expect(byType.has('ApexClass#FooController')).toBe(true);
    expect(byType.has('CustomObject#Widget__c')).toBe(true);
    expect(byType.has('CustomField#Widget__c.Name__c')).toBe(true);
  });

  it('sets a real lastModifiedDate from filesystem mtime', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const inventory = await source.inventory({ types: ['ApexClass'] });
    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]!.lastModifiedDateUnknown).toBeFalsy();
    expect(new Date(inventory.entries[0]!.lastModifiedDate).getTime()).not.toBeNaN();
  });

  it('honors TypeFilter.types as "no restriction" when omitted, unlike OrgSource', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const all = await source.inventory({});
    const restricted = await source.inventory({ types: ['ApexClass'] });
    expect(all.entries.length).toBeGreaterThan(restricted.entries.length);
  });

  it('honors namePatterns and excludeNamespaces filters', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const byPattern = await source.inventory({ namePatterns: ['Foo*'] });
    expect(byPattern.entries.map((e) => e.key.fullName)).toEqual(['FooController']);

    const excluded = await source.inventory({ types: ['ApexClass'], excludeNamespaces: ['Foo'] });
    // FooController has only one `__`-free name, so the namespace heuristic
    // should NOT treat it as namespaced — it must still be included.
    expect(excluded.entries).toHaveLength(1);
  });
});

describe('SfdxProjectSource.materialize', () => {
  it('copies only the requested components into a fresh temp directory', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const tree = await source.materialize([{ type: 'ApexClass', fullName: 'FooController' }]);

    expect(tree.rootDir).not.toBe(projectDir);
    expect(tree.files.size).toBe(2); // .cls + .cls-meta.xml
    for (const abs of tree.files.values()) {
      const content = await readFile(abs, 'utf8');
      expect(content.length).toBeGreaterThan(0);
    }

    await rm(tree.rootDir, { recursive: true, force: true });
  });

  it('reports missing for keys that do not resolve to a component', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const tree = await source.materialize([{ type: 'ApexClass', fullName: 'DoesNotExist' }]);
    expect(tree.missing).toEqual([
      { key: { type: 'ApexClass', fullName: 'DoesNotExist' }, reason: expect.any(String) },
    ]);
    await rm(tree.rootDir, { recursive: true, force: true });
  });

  it('returns an empty tree for an empty key list', async () => {
    const source = new SfdxProjectSource('proj-1', 'My Project', projectDir);
    const tree = await source.materialize([]);
    expect(tree.files.size).toBe(0);
  });
});
