import { readFile, rm } from 'node:fs/promises';
import { MetadataResolver, RegistryAccess, type SourceComponent } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey, SourceTree } from '../types/metadata-source.js';
import { TEXT_BODY_TYPES } from '../diff/dispatch.js';
import { flattenComponents } from '../sources/flatten-components.js';
import { componentKeyString } from '../util/component-key.js';

/**
 * Resolves a materialized `SourceTree` (the output of any `MetadataSource`'s
 * `materialize()`) back into per-component raw content, keyed by
 * `componentKeyString`. This is the bridge between the source-agnostic
 * `SourceTree` (a flat file map) and `diffComponent`'s per-component
 * `left`/`right` string contract.
 *
 * Reuses SDR's `MetadataResolver` — exactly the same mechanism
 * `SfdxProjectSource`/`GitRefSource` already use internally — rather than
 * hardcoding a type-to-suffix mapping. This works uniformly across all
 * three `MetadataSource` kinds because every one of them normalizes its
 * output to Salesforce "source format" before returning it (see
 * `ARCHITECTURE.md`): `OrgSource` via `MetadataConverter`, the other two by
 * construction. It also works across `OrgSource`'s per-chunk subdirectories
 * (`chunk-0/`, `chunk-1/`, ...) since `MetadataResolver.getComponentsFromPath`
 * walks recursively regardless of directory nesting.
 *
 * Dispatch mirrors `diff/dispatch.ts`'s `TEXT_BODY_TYPES` exactly (imported,
 * not duplicated): for opaque text-body types (ApexClass, ...) the "content"
 * a comparison cares about is the body file only, matching how those types
 * are actually diffed; for everything else it's the component's metadata
 * XML file.
 */
export async function resolveComponentContents(
  tree: SourceTree,
  keys: readonly ComponentKey[],
  registry: RegistryAccess,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tree.rootDir === '' || keys.length === 0) return out;

  const resolver = new MetadataResolver(registry);
  const roots = resolver.getComponentsFromPath(tree.rootDir);
  const components = flattenComponents(roots);
  const byKey = new Map<string, SourceComponent>();
  for (const c of components) {
    byKey.set(componentKeyString({ type: c.type.name, fullName: c.fullName }), c);
  }

  for (const key of keys) {
    const component = byKey.get(componentKeyString(key));
    if (!component) continue; // not resolved (missing/failed retrieve) — caller treats as absent
    const path = TEXT_BODY_TYPES.has(key.type) ? component.content : component.xml;
    if (!path) continue;
    try {
      out.set(componentKeyString(key), await readFile(path, 'utf8'));
    } catch {
      // File listed by SDR but unreadable (race, symlink) — treat as absent rather than fail the whole comparison.
    }
  }

  return out;
}

/** Best-effort cleanup of a materialized `SourceTree`'s temp directory. Safe to call with an empty `rootDir` (the zero-keys case every `MetadataSource.materialize([])` returns). */
export async function cleanupSourceTree(tree: SourceTree): Promise<void> {
  if (!tree.rootDir) return;
  await rm(tree.rootDir, { recursive: true, force: true }).catch(() => {});
}
