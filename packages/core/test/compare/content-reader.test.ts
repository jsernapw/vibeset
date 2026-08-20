import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { describe, expect, it } from 'vitest';
import { cleanupSourceTree, resolveComponentContents } from '../../src/compare/content-reader.js';
import { componentKeyString } from '../../src/util/component-key.js';
import type { SourceTree } from '../../src/types/metadata-source.js';

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
