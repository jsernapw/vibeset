import { cp, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { describe, expect, it } from 'vitest';
import {
  cleanupSourceTree,
  decomposedChildTypeNames,
  resolveAnalyzerComponents,
  resolveComponentContents,
} from '../../src/compare/content-reader.js';
import { componentKeyString } from '../../src/util/component-key.js';
import type { SourceTree } from '../../src/types/metadata-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Regression coverage for the StaticResource/Document binary-corruption fix
 * (see `util/binary-content.ts`, `compare/content-reader.ts`). Before the
 * fix, `resolveComponentContents` read every component's content via
 * `readFile(path, 'utf8')` — safe for text/XML types, but for a binary
 * body (a zip, a PNG, ...) that decode is lossy: invalid UTF-8 byte
 * sequences get replaced with U+FFFD, so two genuinely different binaries
 * can come back byte-different-but-corrupted-identically, or a real
 * single-byte difference can vanish. These tests build a real on-disk
 * Salesforce source-format StaticResource (the same shape `OrgSource`'s
 * `MetadataConverter` output takes) with a body containing invalid UTF-8
 * byte sequences, and assert round-trip byte fidelity and change
 * detection survive the fix.
 */

async function writeStaticResource(rootDir: string, name: string, body: Buffer, contentType = 'application/zip'): Promise<SourceTree> {
  const dir = join(rootDir, 'staticresources');
  await mkdir(dir, { recursive: true });
  const bodyPath = join(dir, `${name}.resource`);
  const metaPath = join(dir, `${name}.resource-meta.xml`);
  await writeFile(bodyPath, body);
  await writeFile(
    metaPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl><contentType>${contentType}</contentType></StaticResource>\n`,
  );
  const files = new Map<string, string>([
    [`staticresources/${name}.resource`, bodyPath],
    [`staticresources/${name}.resource-meta.xml`, metaPath],
  ]);
  return { sourceId: 'test', rootDir, files };
}

describe('resolveComponentContents — binary types (StaticResource)', () => {
  it('round-trips arbitrary binary bytes (including invalid UTF-8 sequences) without corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-binary-content-'));
    try {
      // Bytes deliberately chosen to be invalid as UTF-8 on their own (a
      // lone continuation byte, an overlong-looking lead byte, and a raw
      // 0xFF) — `readFile(path, 'utf8')` would mangle these into U+FFFD
      // replacement characters, silently losing information.
      const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x80, 0xc3, 0x28, 0x00, 0x00]);
      const tree = await writeStaticResource(root, 'Widget', body);
      const key = { type: 'StaticResource', fullName: 'Widget' };

      const resolved = await resolveComponentContents(tree, [key], new RegistryAccess());
      const encoded = resolved.get(componentKeyString(key));
      expect(encoded).toBeDefined();

      const parsed = JSON.parse(encoded!) as { bodyBase64: string; metaXml: string };
      const roundTripped = Buffer.from(parsed.bodyBase64, 'base64');
      expect(roundTripped.equals(body)).toBe(true);
      expect(parsed.metaXml).toContain('<contentType>application/zip</contentType>');

      await cleanupSourceTree(tree);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('produces different encoded content for different binary bodies (so a real byte-level change is detected)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-binary-content-'));
    try {
      const key = { type: 'StaticResource', fullName: 'Widget' };
      const treeA = await writeStaticResource(root, 'Widget', Buffer.from([0x01, 0x02, 0x03]));
      const resolvedA = await resolveComponentContents(treeA, [key], new RegistryAccess());
      const encodedA = resolvedA.get(componentKeyString(key));

      const root2 = await mkdtemp(join(tmpdir(), 'vibeset-binary-content-'));
      const treeB = await writeStaticResource(root2, 'Widget', Buffer.from([0x01, 0x02, 0x04]));
      const resolvedB = await resolveComponentContents(treeB, [key], new RegistryAccess());
      const encodedB = resolvedB.get(componentKeyString(key));

      expect(encodedA).toBeDefined();
      expect(encodedB).toBeDefined();
      expect(encodedA).not.toBe(encodedB);

      await cleanupSourceTree(treeB);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('detects a metadata-sidecar-only change (identical body, different contentType) — body-only hashing would miss this', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'vibeset-binary-content-'));
    const rootB = await mkdtemp(join(tmpdir(), 'vibeset-binary-content-'));
    try {
      const key = { type: 'StaticResource', fullName: 'Widget' };
      const sameBody = Buffer.from([0xaa, 0xbb, 0xcc]);
      const treeA = await writeStaticResource(rootA, 'Widget', sameBody, 'application/zip');
      const treeB = await writeStaticResource(rootB, 'Widget', sameBody, 'image/png');

      const encodedA = (await resolveComponentContents(treeA, [key], new RegistryAccess())).get(componentKeyString(key));
      const encodedB = (await resolveComponentContents(treeB, [key], new RegistryAccess())).get(componentKeyString(key));

      expect(encodedA).not.toBe(encodedB);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: rootA, files: new Map() });
      await cleanupSourceTree({ sourceId: 'test', rootDir: rootB, files: new Map() });
    }
  });
});

/**
 * Regression coverage for the decomposed-`CustomObject` composition fix.
 *
 * `test/fixtures/real-retrieve-account/objects/Account/` is NOT a
 * hand-written fixture — it is a byte-for-byte copy of a real
 * `sf project retrieve start -m "CustomObject:Account"` against RCA DEV
 * (2026-09-04), the exact on-disk shape `OrgSource`'s `MetadataConverter`
 * produces for a decomposed source-format `CustomObject`: an object-level
 * shell (`Account.object-meta.xml`, no `<fields>`/`<listViews>`/... tags
 * at all) plus separate `fields/*.field-meta.xml`, `listViews/
 * *.listView-meta.xml`, `webLinks/*.webLink-meta.xml` files. This is
 * deliberate: `merge/generic-merge.ts`'s fixtures are all hand-written
 * COMPLETE `.object` files (mdapi shape), which is exactly why the bug
 * this composes for survived undetected — a test fixture in the wrong
 * shape passes regardless of whether composition works. Using the real
 * shape here means these tests fail without the `compose` option, the
 * same way `merge.resolve` silently produced zero `fields.*`/`listViews.*`
 * merge entries against real orgs before this fix (see
 * `packages/server/test/perf/real-org-decomposed-merge-check.ts` for the
 * live end-to-end proof against RCA DEV/ARM DEV).
 */
describe('resolveComponentContents — compose (decomposed CustomObject, real retrieved shape)', () => {
  const FIXTURE_ROOT = join(HERE, '..', 'fixtures', 'real-retrieve-account');

  async function materializedFixtureTree(): Promise<SourceTree> {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-compose-fixture-'));
    await cp(FIXTURE_ROOT, rootDir, { recursive: true });
    return { sourceId: 'test', rootDir, files: new Map() };
  }

  it('WITHOUT compose: reads only the object-level shell — confirms the bug precondition (no <fields>/<listViews> on a real retrieve)', async () => {
    const tree = await materializedFixtureTree();
    try {
      const key = { type: 'CustomObject', fullName: 'Account' };
      const resolved = await resolveComponentContents(tree, [key], new RegistryAccess());
      const content = resolved.get(componentKeyString(key));

      expect(content).toBeDefined();
      expect(content).not.toContain('<fields>');
      expect(content).not.toContain('<listViews>');
      // The shell DOES have object-level settings — proves this is reading
      // real content, not an empty/missing file.
      expect(content).toContain('<sharingModel>');
    } finally {
      await cleanupSourceTree(tree);
    }
  });

  it('WITH compose: recomposes the real retrieved children (fields/listViews/webLinks) into one logical document', async () => {
    const tree = await materializedFixtureTree();
    try {
      const key = { type: 'CustomObject', fullName: 'Account' };
      const resolved = await resolveComponentContents(tree, [key], new RegistryAccess(), { compose: true });
      const content = resolved.get(componentKeyString(key));
      expect(content).toBeDefined();

      // Count what's actually on disk rather than hardcoding a number, so
      // this test doesn't silently drift from the fixture if it's ever
      // re-retrieved.
      const fieldFiles = await readdir(join(FIXTURE_ROOT, 'objects', 'Account', 'fields'));
      const listViewFiles = await readdir(join(FIXTURE_ROOT, 'objects', 'Account', 'listViews'));
      const webLinkFiles = await readdir(join(FIXTURE_ROOT, 'objects', 'Account', 'webLinks'));

      const fieldTagCount = (content!.match(/<fields>/g) ?? []).length;
      const listViewTagCount = (content!.match(/<listViews>/g) ?? []).length;
      const webLinkTagCount = (content!.match(/<webLinks>/g) ?? []).length;

      expect(fieldTagCount).toBe(fieldFiles.length);
      expect(listViewTagCount).toBe(listViewFiles.length);
      expect(webLinkTagCount).toBe(webLinkFiles.length);

      // A specific real field, by name, not just a tag count — proves the
      // actual child content made it into the composed document, not just
      // an empty wrapper tag.
      expect(content).toMatch(/<fields>\s*<fullName>Website<\/fullName>/);

      // The object-level shell content composition started from is still
      // there too — composing children must not replace or drop it.
      expect(content).toContain('<sharingModel>');
    } finally {
      await cleanupSourceTree(tree);
    }
  });

  it('compose is a no-op for a component with no decomposed children present in the tree (nothing to compose)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-compose-nochildren-'));
    try {
      const dir = join(root, 'objects', 'Widget__c');
      await mkdir(dir, { recursive: true });
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Widget</label></CustomObject>\n';
      await writeFile(join(dir, 'Widget__c.object-meta.xml'), xml);

      const tree: SourceTree = { sourceId: 'test', rootDir: root, files: new Map() };
      const key = { type: 'CustomObject', fullName: 'Widget__c' };
      const resolved = await resolveComponentContents(tree, [key], new RegistryAccess(), { compose: true });
      expect(resolved.get(componentKeyString(key))).toBe(xml);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('decomposedChildTypeNames: CustomObject reports its real child types (registry-driven, not a hardcoded list)', () => {
    const names = decomposedChildTypeNames(new RegistryAccess(), 'CustomObject');
    expect(names).toBeDefined();
    expect(names).toEqual(
      expect.arrayContaining(['CustomField', 'ListView', 'RecordType', 'ValidationRule', 'WebLink', 'BusinessProcess', 'CompactLayout', 'FieldSet', 'Index', 'SharingReason']),
    );
  });

  it('decomposedChildTypeNames: undefined for a non-decomposed type (Profile — single complete file, nothing to compose)', () => {
    expect(decomposedChildTypeNames(new RegistryAccess(), 'Profile')).toBeUndefined();
  });
});

/**
 * `resolveAnalyzerComponents` is `resolveComponentContents`'s counterpart
 * for `AnalysisContext.packageComponents` — same materialized-`SourceTree`
 * resolution, but returning `Component` (`path` + `content` + `auxFiles`)
 * instead of a bare content string, since analyzers can read a
 * component's `-meta.xml` sidecar (the stale-API-version rule) or other
 * bundle members, not just its primary body.
 */
describe('resolveAnalyzerComponents', () => {
  async function writeApexClass(rootDir: string, name: string, body: string): Promise<SourceTree> {
    const dir = join(rootDir, 'classes');
    await mkdir(dir, { recursive: true });
    const clsPath = join(dir, `${name}.cls`);
    const metaPath = join(dir, `${name}.cls-meta.xml`);
    await writeFile(clsPath, body);
    await writeFile(
      metaPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>58.0</apiVersion><status>Active</status></ApexClass>\n',
    );
    const files = new Map<string, string>([
      [`classes/${name}.cls`, clsPath],
      [`classes/${name}.cls-meta.xml`, metaPath],
    ]);
    return { sourceId: 'test', rootDir, files };
  }

  async function writeLayout(rootDir: string, objectApiName: string, layoutLabel: string): Promise<SourceTree> {
    const dir = join(rootDir, 'layouts');
    await mkdir(dir, { recursive: true });
    const fullName = `${objectApiName}-${layoutLabel}`;
    const layoutPath = join(dir, `${fullName}.layout-meta.xml`);
    await writeFile(
      layoutPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata"><showEmailCheckbox>false</showEmailCheckbox></Layout>\n',
    );
    const files = new Map<string, string>([[`layouts/${fullName}.layout-meta.xml`, layoutPath]]);
    return { sourceId: 'test', rootDir, files };
  }

  it('resolves a text-body type (ApexClass) with the body as primary content and the -meta.xml sidecar as an auxFile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-analyzer-components-'));
    try {
      const tree = await writeApexClass(root, 'MyClass', 'public class MyClass {}');
      const key = { type: 'ApexClass', fullName: 'MyClass' };

      const { components, unresolved } = await resolveAnalyzerComponents(tree, [key], new RegistryAccess());

      expect(unresolved).toEqual([]);
      expect(components).toHaveLength(1);
      const component = components[0]!;
      expect(component.key).toEqual(key);
      expect(component.content).toBe('public class MyClass {}');
      expect(component.path).toMatch(/MyClass\.cls$/);
      expect(component.auxFiles).toHaveLength(1);
      expect(component.auxFiles![0]!.path).toMatch(/MyClass\.cls-meta\.xml$/);
      expect(component.auxFiles![0]!.content).toContain('<apiVersion>58.0</apiVersion>');

      await cleanupSourceTree(tree);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('resolves a plain XML type (Layout) with no auxFiles (single file, no sidecar)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-analyzer-components-'));
    try {
      const tree = await writeLayout(root, 'Account', 'Account Layout');
      const key = { type: 'Layout', fullName: 'Account-Account Layout' };

      const { components, unresolved } = await resolveAnalyzerComponents(tree, [key], new RegistryAccess());

      expect(unresolved).toEqual([]);
      expect(components).toHaveLength(1);
      expect(components[0]!.content).toContain('<showEmailCheckbox>false</showEmailCheckbox>');
      expect(components[0]!.auxFiles).toBeUndefined();

      await cleanupSourceTree(tree);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('reports a requested key that never resolved (missing/failed retrieve) via `unresolved`, not a thrown error or a silently shorter array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeset-analyzer-components-'));
    try {
      const tree = await writeApexClass(root, 'Present', 'public class Present {}');
      const presentKey = { type: 'ApexClass', fullName: 'Present' };
      const missingKey = { type: 'ApexClass', fullName: 'NeverRetrieved' };

      const { components, unresolved } = await resolveAnalyzerComponents(tree, [presentKey, missingKey], new RegistryAccess());

      expect(components.map((c) => c.key)).toEqual([presentKey]);
      expect(unresolved).toEqual([missingKey]);

      await cleanupSourceTree(tree);
    } finally {
      await cleanupSourceTree({ sourceId: 'test', rootDir: root, files: new Map() });
    }
  });

  it('an empty keys array (or an empty tree) resolves to no components and every key marked unresolved', async () => {
    const emptyTree: SourceTree = { sourceId: 'test', rootDir: '', files: new Map() };
    const key = { type: 'ApexClass', fullName: 'Whatever' };

    const result = await resolveAnalyzerComponents(emptyTree, [key], new RegistryAccess());

    expect(result.components).toEqual([]);
    expect(result.unresolved).toEqual([key]);
  });
});
