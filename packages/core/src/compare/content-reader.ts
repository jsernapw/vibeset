import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataConverter, MetadataResolver, RegistryAccess, type SourceComponent } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey, SourceTree } from '../types/metadata-source.js';
import type { Component, ComponentFile } from '../types/analyzer.js';
import { TEXT_BODY_TYPES } from '../diff/dispatch.js';
import { componentFiles, flattenComponents } from '../sources/flatten-components.js';
import { componentKeyString } from '../util/component-key.js';
import { BINARY_BODY_TYPES, encodeBinaryContent } from '../util/binary-content.js';

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
 *
 * `BINARY_BODY_TYPES` (`StaticResource`, `Document`) are a third case,
 * handled separately from both of the above: their body file is arbitrary
 * bytes, not text, so it's read as a `Buffer` (never `utf8`, which would
 * corrupt it) and combined with the `-meta.xml` sidecar into the stable
 * encoded form `encodeBinaryContent` defines. `comparison-engine.ts`
 * recognizes that encoding and compares these components by content hash
 * instead of routing them through the XML/text differ.
 *
 * DECOMPOSED PARENTS (`CustomObject` and anything else SDR decomposes,
 * e.g. `decomposition: 'folderPerType'` in the registry): by default this
 * function reads exactly one on-disk file per component, same as every
 * other type — for `CustomObject` that's the object-level shell
 * (`<Name>.object-meta.xml`), which does NOT contain `<fields>`,
 * `<listViews>`, `<recordTypes>`, etc. Those live as their OWN separate
 * `SourceComponent`s (`CustomField`, `ListView`, ...) on disk, and are
 * inventoried/diffed as their own components — see `ARCHITECTURE.md` and
 * the reconciliation note on `CustomField` counts matching `sf org list
 * metadata`. That default is deliberate: it's what keeps diff's per-
 * component granularity honest (a field change is reported once, as a
 * `CustomField` result, not a second time buried inside a `CustomObject`
 * result) and keeps `pre-deploy-snapshot.ts`'s rollback blobs matching
 * exactly what the retrieval planner's `lastModifiedDate` cache already
 * expects for that type.
 *
 * Pass `{ compose: true }` to instead recompose a decomposed parent's
 * children back into ONE logical document — the shape entry-level merge
 * needs (`merge/generic-merge.ts`'s `decomposeGeneric` parses a single XML
 * string and expects `<fields>`/`<listViews>`/... to already be there, the
 * same way a hand-retrieved `.object` file or the Metadata API's own
 * complete-file shape would have them). Composition only ever applies to a
 * component that actually HAS decomposed children present in `tree`
 * (`component.getChildren().length > 0`); every other key is read exactly
 * as before, `compose` or not. See `trpc/routers/merge.ts` for the one
 * caller that opts in, and why diff/pre-deploy-snapshot deliberately don't.
 */
export interface ResolveComponentContentsOptions {
  /**
   * When `true`, a decomposed parent component is recomposed (via SDR's
   * real `source` -> `metadata` format conversion — the same machinery
   * `OrgSource` already relies on, run here in reverse) into one logical
   * document instead of returning just its on-disk shell file. Requires
   * `tree` to actually contain the children's files (materialize the
   * parent key together with its children's keys — see
   * `decomposedChildTypeNames`). Defaults to `false`.
   */
  readonly compose?: boolean;
}

export async function resolveComponentContents(
  tree: SourceTree,
  keys: readonly ComponentKey[],
  registry: RegistryAccess,
  options: ResolveComponentContentsOptions = {},
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

    if (BINARY_BODY_TYPES.has(key.type)) {
      const encoded = await readBinaryComponentContent(component);
      if (encoded !== undefined) out.set(componentKeyString(key), encoded);
      continue;
    }

    if (options.compose && component.getChildren().length > 0) {
      const composed = await composeDecomposedComponent(component, registry);
      if (composed !== undefined) out.set(componentKeyString(key), composed);
      continue;
    }

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

export interface ResolveAnalyzerComponentsResult {
  readonly components: Component[];
  /** Keys that did not resolve (missing/failed retrieve) — same "treat as absent" convention `resolveComponentContents` uses, but surfaced explicitly here since a caller feeding `AnalysisContext.packageComponents` needs to know when a requested component silently dropped out rather than just getting a shorter array back. */
  readonly unresolved: ComponentKey[];
}

/**
 * The `AnalysisContext.packageComponents` counterpart to
 * `resolveComponentContents` above — same materialized-`SourceTree`-to-
 * component-content bridge, but producing the richer `Component` shape
 * (`types/analyzer.ts`) analyzers need: `path` + primary `content` PLUS
 * `auxFiles` for every other file real retrieval materializes alongside
 * it (an ApexClass/ApexTrigger's `-meta.xml` sidecar, an LWC/Aura bundle's
 * remaining members). Deliberately a separate function rather than an
 * options flag on `resolveComponentContents`: that function's callers
 * (the differ, `merge.resolve`) only ever want ONE string per key and
 * have no use for aux files, so bolting `Component`'s shape onto it would
 * make every existing caller carry a type they don't need.
 *
 * Does NOT support `{ compose: true }` — none of Cassia's shipped
 * analyzers operate on a composed decomposed-parent document (they read
 * `Layout`/`ValidationRule`/`CustomField`/`Flow`/`QuickAction`/`Profile`/
 * `PermissionSet` bodies directly, none of which are themselves decomposed
 * parents), so that path is left unimplemented here rather than copied
 * speculatively — add it if a future analyzer needs a composed
 * `CustomObject` document.
 */
export async function resolveAnalyzerComponents(
  tree: SourceTree,
  keys: readonly ComponentKey[],
  registry: RegistryAccess,
): Promise<ResolveAnalyzerComponentsResult> {
  if (tree.rootDir === '' || keys.length === 0) return { components: [], unresolved: [...keys] };

  const resolver = new MetadataResolver(registry);
  const roots = resolver.getComponentsFromPath(tree.rootDir);
  const flat = flattenComponents(roots);
  const byKey = new Map<string, SourceComponent>();
  for (const c of flat) {
    byKey.set(componentKeyString({ type: c.type.name, fullName: c.fullName }), c);
  }

  const components: Component[] = [];
  const unresolved: ComponentKey[] = [];

  for (const key of keys) {
    const component = byKey.get(componentKeyString(key));
    if (!component) {
      unresolved.push(key);
      continue;
    }

    if (BINARY_BODY_TYPES.has(key.type)) {
      const encoded = await readBinaryComponentContent(component);
      if (encoded === undefined) {
        unresolved.push(key);
        continue;
      }
      components.push({ key, path: component.content ?? component.xml ?? '', content: encoded });
      continue;
    }

    const primaryPath = TEXT_BODY_TYPES.has(key.type) ? component.content : component.xml;
    if (!primaryPath) {
      unresolved.push(key);
      continue;
    }

    let primaryContent: string;
    try {
      primaryContent = await readFile(primaryPath, 'utf8');
    } catch {
      unresolved.push(key); // listed by SDR but unreadable (race, symlink) — same convention as resolveComponentContents
      continue;
    }

    const auxFiles: ComponentFile[] = [];
    for (const filePath of componentFiles(component)) {
      if (filePath === primaryPath) continue;
      try {
        auxFiles.push({ path: filePath, content: await readFile(filePath, 'utf8') });
      } catch {
        // A bundle member/sidecar that fails to read is dropped, not fatal — the primary file is still usable.
      }
    }

    components.push({
      key,
      path: primaryPath,
      content: primaryContent,
      auxFiles: auxFiles.length > 0 ? auxFiles : undefined,
    });
  }

  return { components, unresolved };
}

/**
 * Recomposes one decomposed parent (already resolved, WITH its children
 * present on disk in `tree`) into the single document SDR would produce
 * for the Metadata API — exactly the reverse of the `source`-format
 * conversion `OrgSource` runs on the way in. Reuses SDR's own
 * `MetadataConverter`/`DecomposedMetadataTransformer` rather than
 * reimplementing the tag-name mapping (`fields`, `listViews`, ...) by
 * hand: that mapping is registry data (`type.children.types[id]
 * .directoryName`), not something worth a parallel, driftable copy of.
 *
 * Deliberately does NOT catch a conversion failure the way the plain
 * single-file read path does for a stray I/O race below — a decomposed
 * component that resolved but fails to recompose is a real problem (bad
 * child XML, a registry mismatch), and the caller here is exclusively
 * `merge.resolve`'s content path: silently falling back to "absent" would
 * misreport the component as deleted/new instead of surfacing the actual
 * failure.
 */
async function composeDecomposedComponent(component: SourceComponent, registry: RegistryAccess): Promise<string | undefined> {
  const outDir = await mkdtemp(join(tmpdir(), 'vibeset-compose-'));
  try {
    const converter = new MetadataConverter(registry);
    const result = await converter.convert([component], 'metadata', {
      type: 'directory',
      outputDirectory: outDir,
      genUniqueDir: false,
    });
    const composedPath = result.converted?.[0]?.xml;
    if (!composedPath) return undefined;
    return await readFile(composedPath, 'utf8');
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The child metadata type NAMES (`CustomField`, `ListView`, ...) a
 * decomposed parent type (`CustomObject`) has, straight from SDR's
 * registry — `undefined` for a type that doesn't decompose (e.g.
 * `Profile`: `transformer: 'none'`, one complete file, nothing to
 * compose). Read directly off `RegistryAccess` rather than a hand-
 * maintained type list, so a registry update (SDR adding/removing a
 * decomposed child type) is picked up automatically instead of silently
 * going stale — see `package/selection.ts`'s `CHILD_TO_PARENT_TYPE` for
 * the kind of drift a hardcoded copy of this same mapping already
 * accumulated (missing `Index`/`SharingReason` as of this writing).
 *
 * Callers use this to materialize a decomposed parent TOGETHER with its
 * children before calling `resolveComponentContents(..., { compose: true
 * })` — `materialize()` only copies a requested key's OWN files (see
 * `sources/flatten-components.ts`'s `componentFiles` doc comment), so
 * composing requires explicitly requesting the children's keys too.
 */
export function decomposedChildTypeNames(registry: RegistryAccess, typeName: string): string[] | undefined {
  const childTypes = registry.getTypeByName(typeName)?.children?.types;
  if (!childTypes) return undefined;
  const names = Object.values(childTypes)
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return names.length > 0 ? names : undefined;
}

/**
 * Reads a binary-bodied component's body file as raw bytes (base64-encoded
 * for safe storage in the string-keyed content map) plus its `-meta.xml`
 * sidecar as text, and combines them via `encodeBinaryContent`. Either half
 * may legitimately be absent (a chunk that only touched the sidecar, or a
 * resolver quirk); both missing means the component didn't actually
 * resolve, matching the "treat as absent" behavior above for every other
 * type.
 */
async function readBinaryComponentContent(component: SourceComponent): Promise<string | undefined> {
  const bodyPath = component.content;
  const metaPath = component.xml;
  if (!bodyPath && !metaPath) return undefined;

  const [bodyBuf, metaXml] = await Promise.all([
    bodyPath ? readFile(bodyPath).catch(() => undefined) : Promise.resolve(undefined),
    metaPath ? readFile(metaPath, 'utf8').catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (bodyBuf === undefined && metaXml === undefined) return undefined;

  return encodeBinaryContent(bodyBuf ? bodyBuf.toString('base64') : '', metaXml ?? '');
}

/** Best-effort cleanup of a materialized `SourceTree`'s temp directory. Safe to call with an empty `rootDir` (the zero-keys case every `MetadataSource.materialize([])` returns). */
export async function cleanupSourceTree(tree: SourceTree): Promise<void> {
  if (!tree.rootDir) return;
  await rm(tree.rootDir, { recursive: true, force: true }).catch(() => {});
}
