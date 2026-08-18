import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RegistryAccess, type MetadataType } from '@salesforce/source-deploy-retrieve';
import type { ComponentInventory, ComponentKey, MetadataSource, SourceTree, TypeFilter } from '../types/metadata-source.js';
import { TEXT_BODY_TYPES } from '../diff/dispatch.js';
import { componentKeyString } from '../util/component-key.js';

type FilePathsFn = (component: { fullName: string; type: MetadataType }, packageDir?: string) => string[];

/**
 * SDR ships the exact file-path convention every metadata type's source
 * format uses (`filePathsFromMetadataComponent` — suffix, directory,
 * `-meta.xml`, decomposed-child nesting, ...) but doesn't re-export it from
 * its public entry point. Reading it via a deep import avoids VibeSet
 * maintaining its own duplicate suffix/path table (the "don't hardcode the
 * metadata type registry" rule from `ARCHITECTURE.md`) while not being a
 * documented, stable public API — same tradeoff, same deep-import pattern,
 * `sources/registry.ts`'s `loadStandardValueSetNames` already accepts for
 * the same reason. Unlike that helper, there's no safe empty fallback here
 * (a rollback deploy genuinely cannot proceed without knowing where to
 * write a component's content), so a load failure throws a clear, wrapped
 * error instead of degrading silently.
 */
async function loadFilePathsFromMetadataComponent(): Promise<FilePathsFn> {
  try {
    const mod = (await import('@salesforce/source-deploy-retrieve/lib/src/utils/filePathGenerator.js')) as {
      filePathsFromMetadataComponent?: FilePathsFn;
    };
    if (!mod.filePathsFromMetadataComponent) throw new Error('export not found');
    return mod.filePathsFromMetadataComponent;
  } catch (err) {
    throw new Error(
      `Could not load @salesforce/source-deploy-retrieve's internal filePathsFromMetadataComponent helper ` +
        `(used to synthesize valid source-format file paths for a rollback deploy). This is a deep, ` +
        `undocumented import that may have moved in a newer SDR version. Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function defaultMetaXml(type: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></${type}>\n`;
}

/**
 * A `MetadataSource` backed by in-memory canonical content rather than a
 * live org/project — used ONLY for rollback deploys, where the content of
 * truth is what `package/rollback.ts`'s `generateRollbackPlan` already
 * resolved from the content-addressed `SnapshotStore` (the target's
 * pre-deploy state), not anything fetchable from a real source. Writing it
 * out via SDR's own file-path conventions and handing the result to
 * `runDeploy` (which builds a `ComponentSet` from the materialized
 * directory exactly like any other deploy) is what makes a rollback "a
 * normal deployable package going through the same validate/deploy path"
 * per the task brief, rather than a special-cased deploy variant.
 *
 * KNOWN LIMITATIONS (flagged for reviewer scrutiny — see the Phase 1c
 * final report):
 *  - Text-body types (ApexClass, ...) are snapshotted body-only (see
 *    `diff/dispatch.ts`'s `TEXT_BODY_TYPES` design: the `-meta.xml`
 *    sidecar's `apiVersion`/`status` were never part of what gets diffed
 *    or snapshotted for these types). Restoring one synthesizes a default
 *    `-meta.xml` (`apiVersion` 62.0, `status` Active) rather than the
 *    historically exact one.
 *  - Bundle-adapter types (LightningComponentBundle, AuraDefinitionBundle,
 *    ...) are multi-file components the snapshot store doesn't capture as
 *    a coherent whole (each resource file is its own diffed/snapshotted
 *    component). Rather than write something silently wrong, these are
 *    reported via `SourceTree.missing` instead of materialized.
 */
export class SnapshotContentSource implements MetadataSource {
  readonly kind = 'sfdx-project' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly contents: ReadonlyMap<string, string>,
    private readonly registry: RegistryAccess = new RegistryAccess(),
  ) {}

  async inventory(_filter: TypeFilter): Promise<ComponentInventory> {
    return { sourceId: this.id, entries: [] };
  }

  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    if (keys.length === 0) return { sourceId: this.id, rootDir: '', files: new Map() };

    const filePathsFromMetadataComponent = await loadFilePathsFromMetadataComponent();
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-rollback-materialize-'));
    const files = new Map<string, string>();
    const missing: Array<{ key: ComponentKey; reason: string }> = [];

    for (const key of keys) {
      const content = this.contents.get(componentKeyString(key));
      if (content === undefined) {
        missing.push({ key, reason: 'No pre-deploy content available for this component.' });
        continue;
      }

      const type = this.registry.getTypeByName(key.type);
      if (type.strategies?.adapter === 'bundle' || type.strategies?.adapter === 'uiBundles') {
        missing.push({ key, reason: `${key.type} is a multi-file bundle type; rollback restore is not supported for it in Phase 1.` });
        continue;
      }

      const relPaths = filePathsFromMetadataComponent({ fullName: key.fullName, type });

      if (TEXT_BODY_TYPES.has(key.type)) {
        // matchingContentFile types resolve to [".../X.cls-meta.xml", ".../X.cls"] — write the real body to the content file, a synthesized meta.xml sidecar to the other (see the class doc's known-limitation note).
        for (const relPath of relPaths) {
          const abs = join(rootDir, relPath);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, relPath.endsWith('-meta.xml') ? defaultMetaXml(key.type) : content);
          files.set(relPath, abs);
        }
      } else {
        // Everything else: the canonical content IS the metadata XML. Multi-path results (folder-based types) list folder markers before the final file; only the last path is the actual component file.
        const relPath = relPaths[relPaths.length - 1]!;
        const abs = join(rootDir, relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        files.set(relPath, abs);
      }
    }

    return { sourceId: this.id, rootDir, files, missing: missing.length > 0 ? missing : undefined };
  }
}
