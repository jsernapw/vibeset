import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';
import type { TypeFilter } from '../types/metadata-source.js';

/**
 * Bumped only on a breaking shape change — same contract as
 * `package/manifest.ts`'s `MANIFEST_SCHEMA_VERSION`, which this module
 * deliberately mirrors: a filter set is a small, reviewable, git-committable
 * YAML file under `.vibeset/`, read directly off disk by more than just
 * this process (a future CI/API surface, per the roadmap). Additive fields
 * don't need a bump; removing/repurposing one does.
 */
export const FILTER_SET_SCHEMA_VERSION = 1;

/**
 * The stable, documented YAML shape saved under
 * `.vibeset/filter-sets/<id>.yml`. Plain data, same posture as
 * `PackageManifest`: no class instances, no "undefined vs. absent key"
 * ambiguity beyond what YAML itself gives you, so it stays diffable and
 * reviewable by a human or a CI script that never imports this package.
 *
 * Example:
 * ```yaml
 * vibesetFilterSetVersion: 1
 * id: fs_abc123
 * name: Exclude OmniStudio
 * description: Hide the omnistudio managed package from every comparison.
 * createdAt: 2026-09-04T12:00:00.000Z
 * updatedAt: 2026-09-04T12:00:00.000Z
 * filter:
 *   excludeManagedPackages: true
 *   excludeNamespaces:
 *     - omnistudio
 * ```
 */
export interface FilterSet {
  readonly vibesetFilterSetVersion: number;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly filter: TypeFilter;
}

export function filterSetToYaml(filterSet: FilterSet): string {
  // sortKeys: false preserves the field order declared above (readable,
  // stable diffs) rather than js-yaml's default alphabetical reordering —
  // same reasoning as `manifestToYaml`.
  return dump(filterSet, { sortKeys: false, lineWidth: -1 });
}

/**
 * Parses and shape-validates a filter-set YAML string. Throws loudly on a
 * version mismatch or missing required field rather than silently
 * returning a malformed object — a saved filter set feeds directly into a
 * real comparison's retrieve scope, so a corrupt file must fail loudly, not
 * quietly compare "everything" or "nothing".
 */
export function filterSetFromYaml(text: string): FilterSet {
  const raw = load(text);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid filter set: expected a YAML mapping at the document root.');
  }
  const obj = raw as Partial<FilterSet>;
  if (obj.vibesetFilterSetVersion !== FILTER_SET_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported filter set version ${String(obj.vibesetFilterSetVersion)}; this build of VibeSet ` +
        `understands version ${FILTER_SET_SCHEMA_VERSION}.`,
    );
  }
  if (!obj.id || !obj.name || !obj.createdAt || !obj.updatedAt) {
    throw new Error('Invalid filter set: missing required field (id, name, createdAt, or updatedAt).');
  }
  return {
    vibesetFilterSetVersion: obj.vibesetFilterSetVersion,
    id: obj.id,
    name: obj.name,
    description: obj.description,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    filter: obj.filter ?? {},
  };
}

/** Path convention: `<vibesetDir>/filter-sets/<id>.yml` — sibling to `manifestFilePath`'s `<vibesetDir>/packages/<id>.yml`. */
export function filterSetFilePath(vibesetDir: string, id: string): string {
  return join(vibesetDir, 'filter-sets', `${id}.yml`);
}

export async function saveFilterSet(filterSet: FilterSet, vibesetDir: string): Promise<string> {
  const filePath = filterSetFilePath(vibesetDir, filterSet.id);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, filterSetToYaml(filterSet), 'utf8');
  return filePath;
}

export async function loadFilterSet(filePath: string): Promise<FilterSet> {
  return filterSetFromYaml(await readFile(filePath, 'utf8'));
}

/**
 * Lists every saved filter set under `<vibesetDir>/filter-sets/`, newest
 * `updatedAt` first. Returns an empty array (not an error) when the
 * directory doesn't exist yet — the common case for a fresh `.vibeset/`
 * home that has never saved a filter set.
 */
export async function listFilterSets(vibesetDir: string): Promise<FilterSet[]> {
  const dir = join(vibesetDir, 'filter-sets');
  let fileNames: string[];
  try {
    fileNames = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const filterSets = await Promise.all(
    fileNames
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => loadFilterSet(join(dir, f))),
  );
  return filterSets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteFilterSet(vibesetDir: string, id: string): Promise<void> {
  await rm(filterSetFilePath(vibesetDir, id), { force: true });
}
