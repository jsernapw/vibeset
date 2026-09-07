import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Component, ComponentFile } from '../../src/types/analyzer.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

/**
 * Loads a `package/` directory (a real Salesforce source-format tree —
 * `objects/<Obj>/fields/<Field>.field-meta.xml`, `classes/<Name>.cls`
 * (+`.cls-meta.xml`), `layouts/<Name>.layout-meta.xml`, etc.) into
 * `Component[]`, grouping a body file with its `-meta.xml` sidecar the
 * same way `sf project retrieve` actually lays components out on disk.
 *
 * Deliberately scoped to the metadata types this analyzer package's rules
 * actually read (see the `if` chain below) rather than a general SDR-style
 * source-format parser — the point is that golden fixtures here are real
 * directory trees, not hand-rolled JSON blobs, for exactly the same reason
 * the diff corpus's fixtures are real XML files rather than parsed-object
 * literals: a hand-written approximation of the shape is exactly how a
 * real-shape bug (like the decomposed-CustomObject one) survives unnoticed.
 */
export function loadFixturePackage(rootDir: string): Component[] {
  if (!existsSync(rootDir)) return [];
  const files = walk(rootDir);
  const byIdentity = new Map<
    string,
    { key: ComponentKey; primary?: ComponentFile; aux: ComponentFile[] }
  >();

  const put = (key: ComponentKey, file: ComponentFile, isMeta: boolean) => {
    const identity = `${key.type}#${key.fullName}`;
    const entry = byIdentity.get(identity) ?? {
      key,
      primary: undefined,
      aux: [] as ComponentFile[],
    };
    if (isMeta && entry.primary !== undefined) entry.aux.push(file);
    else if (isMeta)
      entry.aux.push(file); // meta-only component (no separate body) still recorded as aux; promoted below if it ends up being the only file
    else entry.primary = file;
    byIdentity.set(identity, entry);
  };

  for (const relPath of files) {
    const absPath = join(rootDir, relPath);
    const content = readFileSync(absPath, 'utf8');
    const segments = relPath.split('/');
    const fileName = segments[segments.length - 1]!;

    if (segments[0] === 'classes' && fileName.endsWith('.cls-meta.xml')) {
      put(
        { type: 'ApexClass', fullName: fileName.replace('.cls-meta.xml', '') },
        { path: relPath, content },
        true,
      );
    } else if (segments[0] === 'classes' && fileName.endsWith('.cls')) {
      put(
        { type: 'ApexClass', fullName: fileName.replace('.cls', '') },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'triggers' && fileName.endsWith('.trigger-meta.xml')) {
      put(
        { type: 'ApexTrigger', fullName: fileName.replace('.trigger-meta.xml', '') },
        { path: relPath, content },
        true,
      );
    } else if (segments[0] === 'triggers' && fileName.endsWith('.trigger')) {
      put(
        { type: 'ApexTrigger', fullName: fileName.replace('.trigger', '') },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'layouts' && fileName.endsWith('.layout-meta.xml')) {
      put(
        { type: 'Layout', fullName: fileName.replace('.layout-meta.xml', '') },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'flows' && fileName.endsWith('.flow-meta.xml')) {
      put(
        { type: 'Flow', fullName: fileName.replace('.flow-meta.xml', '') },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'profiles' && fileName.endsWith('.profile-meta.xml')) {
      put(
        { type: 'Profile', fullName: fileName.replace('.profile-meta.xml', '') },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'permissionsets' && fileName.endsWith('.permissionset-meta.xml')) {
      put(
        { type: 'PermissionSet', fullName: fileName.replace('.permissionset-meta.xml', '') },
        { path: relPath, content },
        false,
      );
    } else if (
      segments[0] === 'objects' &&
      segments[2] === 'fields' &&
      fileName.endsWith('.field-meta.xml')
    ) {
      const objectApiName = segments[1]!;
      const fieldApiName = fileName.replace('.field-meta.xml', '');
      put(
        {
          type: 'CustomField',
          fullName: `${objectApiName}.${fieldApiName}`,
          parentFullName: objectApiName,
        },
        { path: relPath, content },
        false,
      );
    } else if (
      segments[0] === 'objects' &&
      segments[2] === 'validationRules' &&
      fileName.endsWith('.validationRule-meta.xml')
    ) {
      const objectApiName = segments[1]!;
      const ruleName = fileName.replace('.validationRule-meta.xml', '');
      put(
        {
          type: 'ValidationRule',
          fullName: `${objectApiName}.${ruleName}`,
          parentFullName: objectApiName,
        },
        { path: relPath, content },
        false,
      );
    } else if (
      segments[0] === 'objects' &&
      segments[2] === 'quickActions' &&
      fileName.endsWith('.quickAction-meta.xml')
    ) {
      const objectApiName = segments[1]!;
      const actionName = fileName.replace('.quickAction-meta.xml', '');
      put(
        {
          type: 'QuickAction',
          fullName: `${objectApiName}.${actionName}`,
          parentFullName: objectApiName,
        },
        { path: relPath, content },
        false,
      );
    } else if (segments[0] === 'quickActions' && fileName.endsWith('.quickAction-meta.xml')) {
      put(
        { type: 'QuickAction', fullName: fileName.replace('.quickAction-meta.xml', '') },
        { path: relPath, content },
        false,
      );
    } else {
      throw new Error(
        `fixture-loader: unrecognized real-shape path "${relPath}" — extend loadFixturePackage's grouping rules to support it.`,
      );
    }
  }

  return [...byIdentity.values()].map((entry) => {
    const primary = entry.primary ?? entry.aux.shift()!;
    return {
      key: entry.key,
      path: primary.path,
      content: primary.content,
      ...(entry.aux.length ? { auxFiles: entry.aux } : {}),
    };
  });
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}
