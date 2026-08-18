import { copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MetadataResolver, RegistryAccess, type SourceComponent } from '@salesforce/source-deploy-retrieve';
import type {
  ComponentInventory,
  ComponentInventoryEntry,
  ComponentKey,
  MetadataSource,
  SourceTree,
  TypeFilter,
} from '../types/metadata-source.js';
import { componentFiles, flattenComponents } from './flatten-components.js';
import { getRegistryAccess } from './registry.js';
import { matchesTypeFilter } from './type-filter.js';

interface SfdxProjectJson {
  readonly packageDirectories?: ReadonlyArray<{ path: string }>;
}

export interface SfdxProjectSourceDeps {
  readonly registry?: RegistryAccess;
}

/**
 * Reads a local SFDX project on disk. Already in Salesforce source format,
 * so unlike `OrgSource`/`GitRefSource` there's no conversion step —
 * `materialize()` just points at the files that are already there.
 * `RegistryAccess`/`MetadataResolver` (SDR) do all type classification;
 * this class never hardcodes a directory-name-to-type mapping.
 */
export class SfdxProjectSource implements MetadataSource {
  readonly kind = 'sfdx-project' as const;

  private readonly registry: RegistryAccess;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly projectPath: string,
    private readonly deps: SfdxProjectSourceDeps = {},
  ) {
    this.registry = deps.registry ?? getRegistryAccess();
  }

  private async readPackageDirectories(): Promise<string[]> {
    const raw = await readFile(join(this.projectPath, 'sfdx-project.json'), 'utf8');
    const parsed = JSON.parse(raw) as SfdxProjectJson;
    const dirs = parsed.packageDirectories?.map((d) => d.path) ?? ['force-app'];
    return dirs.map((d) => (isAbsolute(d) ? d : resolve(this.projectPath, d)));
  }

  /** Resolves every component (including decomposed children) across all package directories. Cheap: local disk I/O only, no network. */
  private async resolveAllComponents(): Promise<SourceComponent[]> {
    const packageDirs = await this.readPackageDirectories();
    const resolver = new MetadataResolver(this.registry);
    const roots = packageDirs.flatMap((dir) => resolver.getComponentsFromPath(dir));
    return flattenComponents(roots);
  }

  private static async lastModifiedDate(component: SourceComponent): Promise<string | undefined> {
    const files = componentFiles(component);
    let latest: number | undefined;
    for (const file of files) {
      try {
        const s = await stat(file);
        const mtime = s.mtimeMs;
        if (latest === undefined || mtime > latest) latest = mtime;
      } catch {
        // File listed by SDR but unreadable (race, symlink, ...) — skip it, don't fail the whole component.
      }
    }
    return latest === undefined ? undefined : new Date(latest).toISOString();
  }

  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const components = await this.resolveAllComponents();
    const entries: ComponentInventoryEntry[] = [];

    for (const component of components) {
      // isAddressable defaults to true in the registry; only skip when explicitly false.
      if (component.type.isAddressable === false) continue;
      const lastModifiedDate = await SfdxProjectSource.lastModifiedDate(component);
      if (!matchesTypeFilter({ type: component.type.name, fullName: component.fullName, lastModifiedDate }, filter)) {
        continue;
      }
      const key: ComponentKey = {
        type: component.type.name,
        fullName: component.fullName,
        parentFullName: component.parent?.fullName,
      };
      entries.push(
        lastModifiedDate === undefined
          ? { key, lastModifiedDate: '', lastModifiedDateUnknown: true }
          : { key, lastModifiedDate },
      );
    }

    return { sourceId: this.id, entries };
  }

  /**
   * Already source format on disk — no retrieve/convert needed. Copies
   * only the requested components' files into a fresh temp directory (so
   * callers get a self-contained `SourceTree` they can clean up
   * independently of the live project) rather than pointing `rootDir`
   * directly at the user's working copy.
   */
  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    if (keys.length === 0) return { sourceId: this.id, rootDir: '', files: new Map() };

    const components = await this.resolveAllComponents();
    const byKey = new Map(components.map((c) => [componentKeyString(c.type.name, c.fullName), c] as const));

    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-sfdx-materialize-'));
    const files = new Map<string, string>();
    const missing: Array<{ key: ComponentKey; reason: string }> = [];

    for (const key of keys) {
      const component = byKey.get(componentKeyString(key.type, key.fullName));
      if (!component) {
        missing.push({ key, reason: 'Not found in resolved project components.' });
        continue;
      }
      for (const srcFile of componentFiles(component)) {
        const relPath = relative(this.projectPath, srcFile);
        const destFile = join(rootDir, relPath);
        await mkdir(join(destFile, '..'), { recursive: true });
        await copyFile(srcFile, destFile);
        files.set(relPath, destFile);
      }
    }

    return { sourceId: this.id, rootDir, files, missing: missing.length > 0 ? missing : undefined };
  }
}

function componentKeyString(type: string, fullName: string): string {
  return `${type}#${fullName}`;
}
