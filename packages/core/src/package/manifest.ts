import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';
import type { ComponentKey } from '../types/metadata-source.js';
import type { DeploymentPackage } from '../types/deployment.js';
import type { DestructiveMode } from './package-xml.js';

/**
 * Bumped only on a breaking shape change. Phase 6 (CI/CD) reads these files
 * directly off disk — see the roadmap's `.vibeset/config.yml` / git-native
 * flows — so this is a real compatibility contract, not an implementation
 * detail. Additive fields do not require a bump; removing or repurposing a
 * field does.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The stable, documented YAML shape saved under `.vibeset/packages/<id>.yml`.
 * Deliberately plain data (no class instances, no `undefined` vs "absent
 * key" ambiguity beyond what YAML itself gives you) so it stays reviewable,
 * diffable, and git-committable per the task brief, and so a non-VibeSet
 * tool (a CI script, a human reviewer) can read it without this package.
 *
 * Example:
 * ```yaml
 * vibesetManifestVersion: 1
 * id: pkg_abc123
 * name: Sprint 42 release
 * comparisonId: cmp_xyz789
 * createdAt: 2026-08-14T12:00:00.000Z
 * destructiveMode: post
 * components:
 *   - type: ApexClass
 *     fullName: MyClass
 *   - type: CustomField
 *     fullName: Account.My_Field__c
 *     parentFullName: Account
 * destructiveComponents:
 *   - type: ApexClass
 *     fullName: OldClass
 * ```
 */
export interface PackageManifestComponentEntry {
  readonly type: string;
  readonly fullName: string;
  readonly parentFullName?: string;
}

export interface PackageManifest {
  readonly vibesetManifestVersion: number;
  readonly id: string;
  readonly name: string;
  readonly comparisonId?: string;
  readonly createdAt: string;
  readonly destructiveMode: DestructiveMode;
  readonly components: readonly PackageManifestComponentEntry[];
  readonly destructiveComponents: readonly PackageManifestComponentEntry[];
}

function toEntry(key: ComponentKey): PackageManifestComponentEntry {
  return key.parentFullName
    ? { type: key.type, fullName: key.fullName, parentFullName: key.parentFullName }
    : { type: key.type, fullName: key.fullName };
}

function toKey(entry: PackageManifestComponentEntry): ComponentKey {
  return entry.parentFullName
    ? { type: entry.type, fullName: entry.fullName, parentFullName: entry.parentFullName }
    : { type: entry.type, fullName: entry.fullName };
}

export function toManifest(
  pkg: DeploymentPackage,
  options: { readonly destructiveMode?: DestructiveMode; readonly createdAt?: string } = {},
): PackageManifest {
  return {
    vibesetManifestVersion: MANIFEST_SCHEMA_VERSION,
    id: pkg.id,
    name: pkg.name,
    comparisonId: pkg.comparisonId,
    createdAt: options.createdAt ?? pkg.createdAt,
    destructiveMode: options.destructiveMode ?? 'post',
    components: pkg.components.map(toEntry),
    destructiveComponents: pkg.destructiveComponents.map(toEntry),
  };
}

export function manifestToDeploymentPackage(manifest: PackageManifest, manifestPath?: string): DeploymentPackage {
  return {
    id: manifest.id,
    name: manifest.name,
    comparisonId: manifest.comparisonId,
    components: manifest.components.map(toKey),
    destructiveComponents: manifest.destructiveComponents.map(toKey),
    createdAt: manifest.createdAt,
    manifestPath,
  };
}

export function manifestToYaml(manifest: PackageManifest): string {
  // sortKeys: false preserves the field order declared above (readable,
  // stable diffs) rather than js-yaml's default alphabetical reordering.
  return dump(manifest, { sortKeys: false, lineWidth: -1 });
}

/** Parses and shape-validates a manifest YAML string. Throws loudly on a version mismatch or missing required field rather than silently returning a malformed object — a manifest feeds a real deploy, and Phase 6's CI/CD story depends on this file being trustworthy. */
export function manifestFromYaml(text: string): PackageManifest {
  const raw = load(text);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid package manifest: expected a YAML mapping at the document root.');
  }
  const obj = raw as Partial<PackageManifest>;
  if (obj.vibesetManifestVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported package manifest version ${String(obj.vibesetManifestVersion)}; this build of VibeSet ` +
        `understands version ${MANIFEST_SCHEMA_VERSION}.`,
    );
  }
  if (!obj.id || !obj.name || !obj.createdAt) {
    throw new Error('Invalid package manifest: missing required field (id, name, or createdAt).');
  }
  return {
    vibesetManifestVersion: obj.vibesetManifestVersion,
    id: obj.id,
    name: obj.name,
    comparisonId: obj.comparisonId,
    createdAt: obj.createdAt,
    destructiveMode: obj.destructiveMode === 'pre' ? 'pre' : 'post',
    components: obj.components ?? [],
    destructiveComponents: obj.destructiveComponents ?? [],
  };
}

/** Path convention: `<vibesetDir>/packages/<id>.yml`. `vibesetDir` is caller-supplied — could be a project's `.vibeset/` (git-committable) or the app's home directory; this module has no opinion on which. */
export function manifestFilePath(vibesetDir: string, id: string): string {
  return join(vibesetDir, 'packages', `${id}.yml`);
}

export async function saveManifest(manifest: PackageManifest, vibesetDir: string): Promise<string> {
  const filePath = manifestFilePath(vibesetDir, manifest.id);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, manifestToYaml(manifest), 'utf8');
  return filePath;
}

export async function loadManifest(filePath: string): Promise<PackageManifest> {
  return manifestFromYaml(await readFile(filePath, 'utf8'));
}
