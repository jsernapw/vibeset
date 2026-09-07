import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixDoubledMetaXmlSuffix } from '../../src/sources/org-source.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vibeset-fix-doubled-suffix-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Regression test for the real bug discovered by spot-checking
 * `dependencies.sync` against ARM DEV/RCA DEV: `MetadataConverter.convert`
 * doubles the `-meta.xml` suffix for content-less XML types (Profile,
 * PermissionSet, Layout, ...) because SDR's own retrieve step already
 * writes that suffix once before conversion runs. See
 * `fixDoubledMetaXmlSuffix`'s doc comment in `org-source.ts` for the full
 * root cause (traced into `DefaultMetadataTransformer.getXmlDestination`).
 */
describe('fixDoubledMetaXmlSuffix', () => {
  it('collapses a doubled -meta.xml-meta.xml suffix to a single -meta.xml, at the top level', async () => {
    await mkdir(join(dir, 'profiles'), { recursive: true });
    await writeFile(join(dir, 'profiles', 'Admin.profile-meta.xml-meta.xml'), '<Profile/>');

    await fixDoubledMetaXmlSuffix(dir);

    const entries = await readdir(join(dir, 'profiles'));
    expect(entries).toEqual(['Admin.profile-meta.xml']);
  });

  it('recurses into nested directories, matching OrgSource\'s chunk-N/ layout', async () => {
    await mkdir(join(dir, 'chunk-0', 'main', 'default', 'layouts'), { recursive: true });
    await writeFile(
      join(dir, 'chunk-0', 'main', 'default', 'layouts', 'Account-Account Layout.layout-meta.xml-meta.xml'),
      '<Layout/>',
    );

    await fixDoubledMetaXmlSuffix(dir);

    const entries = await readdir(join(dir, 'chunk-0', 'main', 'default', 'layouts'));
    expect(entries).toEqual(['Account-Account Layout.layout-meta.xml']);
  });

  it('leaves a correctly single-suffixed file untouched (the common, non-buggy case — ApexClass et al.)', async () => {
    await mkdir(join(dir, 'classes'), { recursive: true });
    await writeFile(join(dir, 'classes', 'Foo.cls'), 'public class Foo {}');
    await writeFile(join(dir, 'classes', 'Foo.cls-meta.xml'), '<ApexClass/>');

    await fixDoubledMetaXmlSuffix(dir);

    const entries = (await readdir(join(dir, 'classes'))).sort();
    expect(entries).toEqual(['Foo.cls', 'Foo.cls-meta.xml']);
  });

  it('leaves a filename that merely CONTAINS "-meta.xml" mid-string (not as a doubled trailing suffix) untouched', async () => {
    await writeFile(join(dir, 'Weird-meta.xml.thing'), 'x');
    await fixDoubledMetaXmlSuffix(dir);
    expect(await readdir(dir)).toEqual(['Weird-meta.xml.thing']);
  });

  it('does nothing (no throw) for a directory that does not exist', async () => {
    await expect(fixDoubledMetaXmlSuffix(join(dir, 'nonexistent'))).resolves.toBeUndefined();
  });
});
