import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AuthInfo, Connection } from '@salesforce/core';
import { ComponentSet, MetadataConverter, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import type {
  ComponentInventory,
  ComponentInventoryEntry,
  ComponentKey,
  MetadataSource,
  SourceTree,
  TypeFilter,
} from '../types/metadata-source.js';
import { planMaterializeChunks, type ChunkingOptions } from '../retrieval/chunking.js';
import {
  NON_LISTABLE_SINGLETON_TYPES,
  STANDARD_VALUE_SET_TYPE,
  UNFILED_PUBLIC_FOLDER,
  chunk,
  getFolderContainerType,
  getRegistryAccess,
  isFolderBasedType,
  loadStandardValueSetNames,
  resolveInventoryTypes,
  withConcurrency,
} from './registry.js';

/**
 * The subset of `FileProperties` (jsforce's `listMetadata` response row)
 * this source actually reads. Declared locally rather than importing
 * jsforce's type so fakes in tests don't need to satisfy jsforce's full
 * (much larger) shape.
 */
export interface FilePropertiesLike {
  readonly type: string;
  readonly fullName: string;
  readonly lastModifiedDate: string;
  readonly id?: string;
}

export interface RetrieveAndConvertResult {
  /** repo-relative path -> absolute path, for every file written to source format. */
  readonly files: ReadonlyMap<string, string>;
  readonly missing: ReadonlyArray<{ key: ComponentKey; reason: string }>;
}

export interface OrgSourceDeps {
  /**
   * Returns a live `@salesforce/core` `Connection`. Defaults to
   * `AuthInfo.create({ username }) -> Connection.create({ authInfo })`,
   * which is the only credential path VibeSet ever uses — it reads the
   * `sf` CLI's existing auth store and never stores a token of its own.
   *
   * Overridable for tests: `inventory()` and `healthCheck()` only touch
   * `metadata.list`, `getApiVersion`, `instanceUrl`, `identity`, `limits`
   * on the returned object, so a plain fake object (cast to `Connection`)
   * is enough to exercise them with no network access.
   */
  getConnection?: () => Promise<Connection>;
  /**
   * Performs one retrieve-and-convert-to-source-format cycle for a single
   * chunk of keys. Defaults to the real SDR-backed implementation
   * (`ComponentSet.retrieve` + `MetadataConverter`). Overridable so
   * `materialize()`'s chunking/parallelism/cleanup orchestration can be
   * unit-tested without a live org — see `test/sources/org-source.test.ts`.
   */
  retrieveAndConvert?: (
    keys: ComponentKey[],
    destDir: string,
    signal: AbortSignal | undefined,
    connection: Connection,
  ) => Promise<RetrieveAndConvertResult>;
  readonly registry?: RegistryAccess;
  /** Max concurrent `listMetadata` batch calls during inventory. SOAP allows 3 queries/call; this bounds how many calls run at once. */
  readonly listMetadataConcurrency?: number;
  /** Max concurrent retrieve chunks during materialize. */
  readonly retrieveConcurrency?: number;
  readonly chunking?: ChunkingOptions;
  readonly onWarning?: (message: string) => void;
}

export interface OrgHealthCheckResult {
  readonly ok: boolean;
  readonly apiVersion?: string;
  readonly instanceUrl?: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly limits?: Readonly<Record<string, { max: number; remaining: number }>>;
  readonly error?: string;
}

/**
 * Real `OrgSource` implementation over `@salesforce/core` (`AuthInfo`,
 * `Connection`) and SDR (`ComponentSet`, `MetadataApiRetrieve`,
 * `MetadataConverter`, `RegistryAccess`).
 *
 * Credentials: VibeSet never stores one. `getConnection()` resolves a
 * `Connection` via `AuthInfo.create({ username })`, which reads the `sf`
 * CLI's local auth store — the org must already be authenticated via
 * `sf org login web` (the "Add org" UI action shells out to exactly that).
 */
export class OrgSource implements MetadataSource {
  readonly kind = 'org' as const;

  private readonly registry: RegistryAccess;
  private readonly listMetadataConcurrency: number;
  private readonly retrieveConcurrency: number;
  private readonly chunking: ChunkingOptions | undefined;
  private connectionPromise: Promise<Connection> | undefined;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly connectionOptions: { username: string; instanceUrl?: string },
    private readonly deps: OrgSourceDeps = {},
  ) {
    this.registry = deps.registry ?? getRegistryAccess();
    this.listMetadataConcurrency = deps.listMetadataConcurrency ?? 4;
    this.retrieveConcurrency = deps.retrieveConcurrency ?? 3;
    this.chunking = deps.chunking;
  }

  private async getConnection(): Promise<Connection> {
    if (this.deps.getConnection) return this.deps.getConnection();
    this.connectionPromise ??= (async () => {
      const authInfo = await AuthInfo.create({ username: this.connectionOptions.username });
      return Connection.create({ authInfo });
    })();
    return this.connectionPromise;
  }

  /**
   * Verifies the connection actually works (round-trips the identity
   * endpoint) and reports org limits — surfaced in the UI per-connection.
   * Never throws; failures come back as `{ ok: false, error }`.
   */
  async healthCheck(): Promise<OrgHealthCheckResult> {
    try {
      const conn = await this.getConnection();
      const [identity, limits] = await Promise.all([conn.identity(), conn.limits()]);
      const normalizedLimits: Record<string, { max: number; remaining: number }> = {};
      for (const [name, value] of Object.entries(limits)) {
        normalizedLimits[name] = { max: value.Max, remaining: value.Remaining };
      }
      return {
        ok: true,
        apiVersion: conn.getApiVersion(),
        instanceUrl: conn.instanceUrl,
        orgId: identity.organization_id,
        userId: identity.user_id,
        limits: normalizedLimits,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Cheap enumeration via `listMetadata`, batched 3 queries/call (the SOAP
   * limit) with bounded concurrency across batches. Never fetches bodies.
   *
   * Three shapes of type are handled explicitly rather than falling
   * through to "list the bare type name" (which silently returns nothing
   * for all three):
   *  - Folder-based types (`Report`, `Dashboard`, `EmailTemplate`,
   *    `Document`): list the folder-container type first (e.g.
   *    `ReportFolder`), then list within each folder, including the
   *    implicit `unfiled$public` folder every org has.
   *  - Non-listable singleton containers (`Settings`, `CustomLabels`):
   *    `listMetadata` doesn't support enumerating their members at all.
   *    Emitted as a single inventory entry for the container itself, with
   *    `lastModifiedDateUnknown: true` so the cache always refetches it.
   *  - `StandardValueSet`: also unsupported by `listMetadata`; the set of
   *    valid names is fixed by Salesforce, and read from SDR's own shipped
   *    copy of that list (see `loadStandardValueSetNames`) rather than a
   *    VibeSet-maintained duplicate.
   */
  async inventory(filter: TypeFilter): Promise<ComponentInventory> {
    const types = resolveInventoryTypes(filter, this.registry);
    const conn = await this.getConnection();
    const apiVersion = conn.getApiVersion();

    const entries: ComponentInventoryEntry[] = [];
    const folders = new Set<string>();

    const folderTypes = types.filter(isFolderBasedType);
    const standardValueSetRequested = types.some((t) => t.name === STANDARD_VALUE_SET_TYPE);
    const singletonTypes = types.filter((t) => NON_LISTABLE_SINGLETON_TYPES.has(t.name));
    const normalTypes = types.filter(
      (t) => !isFolderBasedType(t) && t.name !== STANDARD_VALUE_SET_TYPE && !NON_LISTABLE_SINGLETON_TYPES.has(t.name),
    );

    const listBatched = async (queries: Array<{ type: string; folder?: string }>): Promise<FilePropertiesLike[]> => {
      const batches = chunk(queries, 3);
      const results = await withConcurrency(batches, this.listMetadataConcurrency, (batch) =>
        this.listMetadataBatch(batch, conn, apiVersion),
      );
      return results.flat();
    };

    if (normalTypes.length > 0) {
      const props = await listBatched(normalTypes.map((t) => ({ type: t.name })));
      for (const p of props) entries.push(toInventoryEntry(p));
    }

    if (folderTypes.length > 0) {
      const folderContainerQueries = folderTypes.map((t) => ({ type: getFolderContainerType(t, this.registry).name }));
      const folderProps = await listBatched(folderContainerQueries);

      const foldersByType = new Map<string, Set<string>>();
      for (const t of folderTypes) foldersByType.set(t.name, new Set([UNFILED_PUBLIC_FOLDER]));

      for (const p of folderProps) {
        folders.add(p.fullName);
        const containerType = this.registry.getTypeByName(p.type);
        const contentType = containerType.folderContentType
          ? this.registry.findType((t) => t.id === containerType.folderContentType)
          : undefined;
        if (contentType) foldersByType.get(contentType.name)?.add(p.fullName);
      }
      // Every folder-based type has an implicit "Unfiled Public..." folder
      // that `listMetadata` never returns as part of the folder-container
      // listing above, but which still needs to appear in the reported
      // folder set (it's queried for content regardless, in the loop below).
      if (folderTypes.length > 0) folders.add(UNFILED_PUBLIC_FOLDER);

      const folderContentQueries: Array<{ type: string; folder: string }> = [];
      for (const t of folderTypes) {
        for (const folderName of foldersByType.get(t.name) ?? [UNFILED_PUBLIC_FOLDER]) {
          folderContentQueries.push({ type: t.name, folder: folderName });
        }
      }
      const contentProps = await listBatched(folderContentQueries);
      for (const p of contentProps) entries.push(toInventoryEntry(p));
    }

    for (const t of singletonTypes) {
      entries.push({
        key: { type: t.name, fullName: t.name },
        lastModifiedDate: '',
        lastModifiedDateUnknown: true,
      });
    }

    if (standardValueSetRequested) {
      const names = await loadStandardValueSetNames();
      for (const name of names) {
        entries.push({
          key: { type: STANDARD_VALUE_SET_TYPE, fullName: name },
          lastModifiedDate: '',
          lastModifiedDateUnknown: true,
        });
      }
    }

    return { sourceId: this.id, entries, folders: folders.size > 0 ? [...folders] : undefined };
  }

  /**
   * `conn.metadata.list()` batches up to 3 queries into one SOAP call, but
   * the call is all-or-nothing: if even one query in the batch names a type
   * the org's edition/feature set doesn't support (observed against a real
   * org: `Translations` throws `INVALID_TYPE` when Translation Workbench
   * isn't enabled), jsforce throws for the WHOLE batch — every other type
   * that would have succeeded in the same call is lost, and with the
   * inventory scope now spanning ~30+ default types, one org-specific
   * feature gap would otherwise crash the entire inventory rather than just
   * being absent, defeating the point of a curated "types most orgs
   * deploy" default that necessarily includes some optional Salesforce
   * features.
   *
   * On failure, retries the batch's members one at a time to isolate which
   * query actually failed; a query that still fails in isolation is
   * reported via `onWarning` and treated as zero components for that
   * type/folder rather than aborting the whole comparison. The common case
   * (every type in the batch is supported) makes exactly one SOAP call, as
   * before — this only costs extra round-trips when something is actually
   * unsupported.
   */
  private async listMetadataBatch(
    batch: Array<{ type: string; folder?: string }>,
    conn: Connection,
    apiVersion: string,
  ): Promise<FilePropertiesLike[]> {
    try {
      return (await conn.metadata.list(batch, apiVersion)) as unknown as FilePropertiesLike[];
    } catch (err) {
      if (batch.length === 1) {
        const q = batch[0]!;
        this.deps.onWarning?.(
          `listMetadata failed for type "${q.type}"${q.folder ? ` (folder "${q.folder}")` : ''} against ${this.label}: ` +
            `${(err as Error).message}. Treating as zero components for this type rather than failing the whole inventory ` +
            `— this usually means the type isn't enabled/available in this org's edition or feature set.`,
        );
        return [];
      }
      const isolated = await Promise.all(batch.map((q) => this.listMetadataBatch([q], conn, apiVersion)));
      return isolated.flat();
    }
  }

  /**
   * Retrieves + converts the requested components to source format.
   * Chunked under the Metadata API's 10,000-file / 39MB-zip limits
   * (`planMaterializeChunks`, which also implements the Profile/
   * PermissionSet pairing rule — see `retrieval/chunking.ts`), with chunks
   * run at bounded concurrency. Writes to a fresh temp directory; on any
   * failure that temp directory is removed before the error propagates, so
   * callers never accumulate orphaned directories from a failed run. On
   * success, the caller owns the returned `rootDir` and is responsible for
   * eventually deleting it.
   */
  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    if (keys.length === 0) {
      return { sourceId: this.id, rootDir: '', files: new Map() };
    }

    const { chunks, warnings } = planMaterializeChunks(keys, this.chunking);
    for (const w of warnings) this.deps.onWarning?.(w);

    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-org-materialize-'));
    const files = new Map<string, string>();
    const missing: Array<{ key: ComponentKey; reason: string }> = [];

    try {
      const connection = await this.getConnection();
      const retrieveAndConvert = this.deps.retrieveAndConvert ?? this.defaultRetrieveAndConvert.bind(this);

      await withConcurrency(chunks, this.retrieveConcurrency, async (chunkKeys, i) => {
        const chunkDir = join(rootDir, `chunk-${i}`);
        await mkdir(chunkDir, { recursive: true });
        const result = await retrieveAndConvert(chunkKeys, chunkDir, undefined, connection);
        for (const [rel, abs] of result.files) files.set(join(`chunk-${i}`, rel), abs);
        missing.push(...result.missing);
      });
    } catch (err) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    return { sourceId: this.id, rootDir, files, missing: missing.length > 0 ? missing : undefined };
  }

  private async defaultRetrieveAndConvert(
    keys: ComponentKey[],
    destDir: string,
    signal: AbortSignal | undefined,
    connection: Connection,
  ): Promise<RetrieveAndConvertResult> {
    const componentSet = new ComponentSet(
      keys.map((k) => ({ type: k.type, fullName: k.fullName })),
      this.registry,
    );
    componentSet.apiVersion = connection.getApiVersion();

    const mdapiDir = await mktempDir('vibeset-org-mdapi-');
    try {
      const operation = await componentSet.retrieve({
        usernameOrConnection: connection,
        output: mdapiDir,
        merge: false,
      });

      const onAbort = (): void => {
        void operation.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      let result;
      try {
        result = await operation.pollStatus();
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      signal?.throwIfAborted();

      const missing = result
        .getFileResponses()
        .filter((fr) => fr.state === 'Failed')
        .map((fr) => ({
          key: { type: fr.type, fullName: fr.fullName },
          reason: 'error' in fr ? fr.error : 'retrieve failed',
        }));

      const converter = new MetadataConverter(this.registry);
      await converter.convert(result.components, 'source', {
        type: 'directory',
        outputDirectory: destDir,
        genUniqueDir: false,
      });

      const files = new Map<string, string>();
      await walkDir(destDir, destDir, files);

      return { files, missing };
    } finally {
      await rm(mdapiDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function toInventoryEntry(p: FilePropertiesLike): ComponentInventoryEntry {
  return { key: { type: p.type, fullName: p.fullName }, lastModifiedDate: p.lastModifiedDate, id: p.id };
}

async function mktempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function walkDir(root: string, dir: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, abs, out);
    } else {
      out.set(relative(root, abs), abs);
    }
  }
}

/**
 * Enumerates every org the `sf` CLI has authenticated, reading its local
 * auth store — this is VibeSet's only credential path; nothing is ever
 * written back to it. Used by the connections tRPC router to populate the
 * "add org" / connection list UI.
 */
export interface OrgAuthorizationInfo {
  readonly username: string;
  readonly orgId: string;
  readonly alias?: string;
  readonly instanceUrl?: string;
  readonly isSandbox?: boolean;
  readonly isScratch?: boolean;
  readonly isExpired: boolean | 'unknown';
}

export async function listAuthorizedOrgs(): Promise<OrgAuthorizationInfo[]> {
  const authorizations = await AuthInfo.listAllAuthorizations();
  return authorizations
    .filter((a) => !a.error)
    .map((a) => ({
      username: a.username,
      orgId: a.orgId,
      alias: a.aliases?.[0] ?? undefined,
      instanceUrl: a.instanceUrl,
      isSandbox: a.isSandbox,
      isScratch: a.isScratchOrg,
      isExpired: a.isExpired,
    }));
}
