import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import * as git from 'isomorphic-git';
import { MetadataResolver, RegistryAccess, VirtualTreeContainer, type SourceComponent } from '@salesforce/source-deploy-retrieve';
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

/** See `GitRefSource.pathHistory`'s doc comment for why `order` (not `date`) is what breaks ties between two files last touched within the same git-timestamp second. */
interface PathHistoryEntry {
  readonly date: string;
  readonly author: string;
  readonly order: number;
}

export interface GitRefSourceDeps {
  readonly registry?: RegistryAccess;
  /** Node's `fs` module by default; injectable for tests that want an in-memory filesystem. */
  readonly fs?: typeof fs;
}

/**
 * Reads a tree at an arbitrary git ref using `isomorphic-git`, entirely
 * against the object database — it never runs `git checkout`, never
 * touches the working directory or the index. This is a hard requirement:
 * users will point this at repos with uncommitted work, and VibeSet must
 * not disturb it.
 *
 * `lastModifiedDate` per path comes from the commit date of the last
 * commit that touched it. Computed with a single `git.log({ includeChanges:
 * true })` walk over the whole ref history (not one `git.log` call per
 * file, which the plan explicitly calls out as expensive) and cached on the
 * instance per ref, since both `inventory()` and `materialize()` may need
 * it.
 */
export class GitRefSource implements MetadataSource {
  readonly kind = 'git-ref' as const;

  private readonly registry: RegistryAccess;
  private readonly fsClient: typeof fs;
  private pathHistoryPromise: Promise<Map<string, PathHistoryEntry>> | undefined;
  private resolvedPromise: Promise<{ oid: string; components: SourceComponent[] }> | undefined;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly repoPath: string,
    private readonly ref: string,
    private readonly deps: GitRefSourceDeps = {},
  ) {
    this.registry = deps.registry ?? getRegistryAccess();
    this.fsClient = deps.fs ?? fs;
  }

  /**
   * Commit date (ISO-8601), author (name, falling back to email), and
   * newest-first walk position of the most recent commit reachable from
   * `ref` that changed each path, as a single pass over history. Memoized
   * per instance — `inventory()` needs all three, and re-walking the whole
   * ref history per call (or once per signal) would defeat the point.
   * Author support (`TypeFilter.modifiedBy`) is feasible here — unlike
   * `SfdxProjectSource`, which reads plain disk with no VCS concept of
   * authorship — because `isomorphic-git`'s commit walk already carries
   * `commit.author` for free alongside the commit date this method already
   * had to read.
   *
   * `order` (this walk's 0-based index, smaller = newer) exists because git
   * commit timestamps only have SECOND resolution: two files last touched
   * by two different commits within the same second produce IDENTICAL
   * `date` strings, and `inventory()` picks "the most recently touched
   * file" for a multi-file component (e.g. `.cls` + `.cls-meta.xml`) by
   * comparing dates. A strict string/date comparison can't break that tie
   * and would non-deterministically attribute the wrong commit's `author`
   * (silently correct for `date`, since a tied date string reads the same
   * either way, but a REAL bug for `author`, which can genuinely differ
   * between the tied commits). `order` is unambiguous — it reflects the
   * actual commit graph traversal, not wall-clock resolution — so
   * `inventory()` uses it, not `date`, to pick which file's author (and,
   * for consistency, date) wins a tie.
   */
  private async pathHistory(): Promise<Map<string, PathHistoryEntry>> {
    this.pathHistoryPromise ??= (async () => {
      const commits = await git.log({ fs: this.fsClient, dir: this.repoPath, ref: this.ref, includeChanges: true });
      const history = new Map<string, PathHistoryEntry>();
      // Newest-first: the first commit we see touching a path is its most recent modification.
      let order = 0;
      for (const { commit } of commits) {
        const changes = commit.changes ?? [];
        if (changes.length === 0) continue;
        const date = new Date(commit.committer.timestamp * 1000).toISOString();
        const author = commit.author.name || commit.author.email;
        for (const change of changes) {
          const filepath = change[2];
          if (!filepath || history.has(filepath)) continue;
          history.set(filepath, { date, author, order });
        }
        order += 1;
      }
      return history;
    })();
    return this.pathHistoryPromise;
  }

  private async resolveComponents(): Promise<{ oid: string; components: SourceComponent[] }> {
    this.resolvedPromise ??= (async () => {
      const oid = await git.resolveRef({ fs: this.fsClient, dir: this.repoPath, ref: this.ref });

      const projectJsonBlob = await git.readBlob({
        fs: this.fsClient,
        dir: this.repoPath,
        oid,
        filepath: 'sfdx-project.json',
      });
      const projectJson = JSON.parse(Buffer.from(projectJsonBlob.blob).toString('utf8')) as SfdxProjectJson;
      const packageDirs = (projectJson.packageDirectories?.map((d) => d.path) ?? ['force-app']).map((p) =>
        posix.normalize(p).replace(/^\.\//, '').replace(/\/$/, ''),
      );

      // Structure-only walk: collects every blob PATH at this ref without
      // reading any blob content, so this stays cheap even on a large repo.
      const allPaths: string[] = await git.walk({
        fs: this.fsClient,
        dir: this.repoPath,
        trees: [git.TREE({ ref: this.ref })],
        map: async (filepath, [entry]) => {
          if (!entry) return undefined;
          return (await entry.type()) === 'blob' ? filepath : undefined;
        },
      });

      const relevantPaths = allPaths.filter((p) => packageDirs.some((dir) => p === dir || p.startsWith(`${dir}/`)));

      // A virtual, content-less tree — just the file *locations* found
      // above — is enough for SDR's MetadataResolver to classify components
      // (which files belong together, decomposition, folders, ...) without
      // reading any blob content yet. Content is only read in materialize(),
      // and only for the specific components actually requested.
      const virtualPaths = relevantPaths.map((p) => resolve(this.repoPath, p));
      const virtualTree = VirtualTreeContainer.fromFilePaths(virtualPaths);
      const resolver = new MetadataResolver(this.registry, virtualTree);
      // Only resolve package directories that actually have at least one
      // file at this ref — a dir with zero entries doesn't exist in the
      // virtual tree at all (e.g. this ref predates the directory being
      // created), and `getComponentsFromPath` throws "not found" rather
      // than returning an empty list for a path it can't see.
      const presentPackageDirs = packageDirs.filter((dir) =>
        relevantPaths.some((p) => p === dir || p.startsWith(`${dir}/`)),
      );
      const roots = presentPackageDirs.flatMap((dir) => resolver.getComponentsFromPath(resolve(this.repoPath, dir)));
      const components = flattenComponents(roots);

      return { oid, components };
    })();
    return this.resolvedPromise;
  }

  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const [{ components }, history] = await Promise.all([this.resolveComponents(), this.pathHistory()]);
    const entries: ComponentInventoryEntry[] = [];

    for (const component of components) {
      if (component.type.isAddressable === false) continue;

      let latest: string | undefined;
      let latestAuthor: string | undefined;
      let latestOrder: number | undefined;
      for (const file of componentFiles(component)) {
        const relPath = toGitPath(relative(this.repoPath, file));
        const entry = history.get(relPath);
        // Tie-break on walk `order` (smaller = newer), not the `date`
        // string — see `pathHistory`'s doc comment: two files last touched
        // within the same git-timestamp second produce equal `date`
        // strings, which would otherwise make this comparison silently
        // fall through to "whichever file iterated first wins", attributing
        // the wrong commit's author non-deterministically.
        if (entry && (latestOrder === undefined || entry.order < latestOrder)) {
          latest = entry.date;
          latestAuthor = entry.author;
          latestOrder = entry.order;
        }
      }

      if (
        !matchesTypeFilter(
          { type: component.type.name, fullName: component.fullName, lastModifiedDate: latest, modifiedBy: latestAuthor },
          filter,
        )
      ) {
        continue;
      }

      const key: ComponentKey = {
        type: component.type.name,
        fullName: component.fullName,
        parentFullName: component.parent?.fullName,
      };
      entries.push(latest ? { key, lastModifiedDate: latest } : { key, lastModifiedDate: '', lastModifiedDateUnknown: true });
    }

    return { sourceId: this.id, entries };
  }

  /**
   * Reads only the blobs for the requested components' files, straight
   * from the git object database (`git.readBlob`), and writes them into a
   * fresh temp directory — never into the repo's real working directory.
   */
  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    if (keys.length === 0) return { sourceId: this.id, rootDir: '', files: new Map() };

    const { oid, components } = await this.resolveComponents();
    const byKey = new Map(components.map((c) => [`${c.type.name}#${c.fullName}`, c] as const));

    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-git-materialize-'));
    const files = new Map<string, string>();
    const missing: Array<{ key: ComponentKey; reason: string }> = [];

    for (const key of keys) {
      const component = byKey.get(`${key.type}#${key.fullName}`);
      if (!component) {
        missing.push({ key, reason: `Not found at ${this.ref}.` });
        continue;
      }
      for (const srcFile of componentFiles(component)) {
        const relPath = toGitPath(relative(this.repoPath, srcFile));
        try {
          const blob = await git.readBlob({ fs: this.fsClient, dir: this.repoPath, oid, filepath: relPath });
          const destFile = join(rootDir, relPath);
          await mkdir(dirname(destFile), { recursive: true });
          await writeFile(destFile, Buffer.from(blob.blob));
          files.set(relPath, destFile);
        } catch (err) {
          missing.push({ key, reason: `Failed to read ${relPath} at ${this.ref}: ${(err as Error).message}` });
        }
      }
    }

    return { sourceId: this.id, rootDir, files, missing: missing.length > 0 ? missing : undefined };
  }
}

/** `isomorphic-git` always uses forward-slash paths regardless of platform; normalize before comparing against them. */
function toGitPath(p: string): string {
  return isAbsolute(p) ? p : p.split(/[\\/]/).join('/');
}
