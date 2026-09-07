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

/**
 * Everything `toFilterSet`/`saveFilterSet` need from a caller EXCEPT the
 * schema version — the version is never something a caller supplies, only
 * something this module stamps. Mirrors `package/manifest.ts`'s
 * `toManifest` builder: `PackageManifestComponentEntry`/`DeploymentPackage`
 * callers never hand-set `vibesetManifestVersion` either, they go through
 * `toManifest`.
 */
export type FilterSetDraft = Omit<FilterSet, 'vibesetFilterSetVersion'>;

/**
 * The one sanctioned way to produce a `FilterSet` — stamps
 * `vibesetFilterSetVersion` centrally so no caller (this build's `filters`
 * router, or any future one) can construct a filter set that
 * `loadFilterSet` then refuses to read. `saveFilterSet` below routes
 * through this rather than trusting its `filterSet` argument to already
 * carry a correct version.
 */
export function toFilterSet(draft: FilterSetDraft): FilterSet {
  return { vibesetFilterSetVersion: FILTER_SET_SCHEMA_VERSION, ...draft };
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

/**
 * Writes a filter set to `<vibesetDir>/filter-sets/<id>.yml`. Takes a
 * `FilterSetDraft` (everything but the version) rather than a full
 * `FilterSet`, and stamps `vibesetFilterSetVersion` itself via
 * `toFilterSet` — the actual fix for the save/load asymmetry this module
 * used to have: a caller that had the version field wrong, stale, or
 * simply omitted (TypeScript still allows constructing an object of a
 * wider type — e.g. via a spread that happened to drop it, or a manually
 * built object cast through `as FilterSet`) could previously write a file
 * `loadFilterSet` would then throw `Unsupported filter set version
 * undefined` trying to read back. Now there is no path to that file ever
 * getting written without a valid version, because this function — not
 * each caller — is what puts it there.
 *
 * `(vibesetDir, filterSet)` parameter order matches `deleteFilterSet`'s
 * `(vibesetDir, id)` (both "where" before "what") — previously this took
 * `(filterSet, vibesetDir)`, the one inconsistent signature among this
 * module's three mutating functions.
 */
export async function saveFilterSet(vibesetDir: string, filterSet: FilterSetDraft): Promise<string> {
  const stamped = toFilterSet(filterSet);
  const filePath = filterSetFilePath(vibesetDir, stamped.id);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, filterSetToYaml(stamped), 'utf8');
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
