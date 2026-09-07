import { mkdtemp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AuthInfo, Connection } from '@salesforce/core';
import { ComponentSet, MetadataConverter, RegistryAccess, type SourceComponent } from '@salesforce/source-deploy-retrieve';
import type {
  ComponentInventory,
  ComponentInventoryEntry,
  ComponentKey,
  MetadataSource,
  SourceTree,
  TypeFilter,
} from '../types/metadata-source.js';
import { planMaterializeChunks, type ChunkingOptions } from '../retrieval/chunking.js';
import { toolingClientFromConnection, type ToolingQueryClient } from '../dependencies/tooling-query.js';
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
import { matchesTypeFilter } from './type-filter.js';

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
  /**
   * The managed-package namespace this component belongs to, or `''`/
   * `undefined` for none — `listMetadata`'s own signal, preferred over
   * parsing `fullName` (see `sources/type-filter.ts`). Real orgs return
   * `''` (not `undefined`) for unnamespaced components; both are treated
   * as "no namespace" by `resolveNamespace`.
   */
  readonly namespacePrefix?: string;
  /**
   * `'unmanaged'` for the org's own metadata (including its own dev/
   * packaging namespace, if it has one) — anything else (`'installed'`,
   * `'released'`, `'deprecated'`, `'deprecatedEditable'`,
   * `'installedEditable'`, `'beta'`, `'deleted'`) means this component
   * belongs to another, installed managed package. See
   * `TypeFilter.excludeManagedPackages`'s doc comment for why this
   * distinction matters.
   */
  readonly manageableState?: string;
  readonly lastModifiedByName?: string;
  readonly lastModifiedById?: string;
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
 * Floor and ceiling for how many components a single top-level chunk is
 * allowed to lose to isolated retrieve/convert failures before the isolation
 * bisection gives up and re-throws instead of continuing. The actual budget
 * is `max(MIN_ISOLATED_FAILURES, ceil(chunkSize * MAX_ISOLATED_FAILURE_RATIO))`
 * — proportional, not a flat count. See `OrgSource`'s
 * `retrieveChunkWithIsolation` and `convertWithIsolation` doc comments for
 * why (a real org, ARM DEV, has enough `StaticResource`s hitting a single
 * shared conversion bug that a flat cap of 5 aborted a comparison that
 * should have degraded gracefully instead), and this is still a safety
 * valve, not "isolate forever": a genuinely systemic failure (every
 * component failing identically — an expired session, a network outage)
 * still blows through even a generous proportional budget and fails loudly,
 * rather than silently mass-reporting real components as missing.
 */
export const MIN_ISOLATED_FAILURES = 5;
export const MAX_ISOLATED_FAILURE_RATIO = 0.3;

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
   * A `ToolingQueryClient` bound to this org's connection — Phase 3
   * Workstream B's only reason to reach outside the `MetadataSource`
   * interface: `MetadataComponentDependency` is queryable ONLY through the
   * Tooling API, which `inventory()`/`materialize()` never touch. Reuses
   * the exact same cached `Connection` (`getConnection()`, memoized on
   * `connectionPromise`) those methods already use — never a second
   * credential path, and never re-authenticates per call.
   */
  async toolingClient(): Promise<ToolingQueryClient> {
    const conn = await this.getConnection();
    return toolingClientFromConnection(conn);
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
      for (const p of props) {
        if (matchesFilter(p, filter)) entries.push(toInventoryEntry(p));
      }
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
      for (const p of contentProps) {
        if (matchesFilter(p, filter)) entries.push(toInventoryEntry(p));
      }
    }

    // Singleton containers and StandardValueSet names carry no `listMetadata`
    // row (no `namespacePrefix`/`manageableState`/author signal to give
    // `matchesTypeFilter`) — `types` is already applied via
    // `resolveInventoryTypes` above, but `namePatterns` can still usefully
    // restrict which of these are included, so still route through the
    // shared predicate rather than pushing unconditionally.
    for (const t of singletonTypes) {
      if (!matchesTypeFilter({ type: t.name, fullName: t.name }, filter)) continue;
      entries.push({
        key: { type: t.name, fullName: t.name },
        lastModifiedDate: '',
        lastModifiedDateUnknown: true,
      });
    }

    if (standardValueSetRequested) {
      const names = await loadStandardValueSetNames();
      for (const name of names) {
        if (!matchesTypeFilter({ type: STANDARD_VALUE_SET_TYPE, fullName: name }, filter)) continue;
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
        // Isolation only kicks in for a chunk of >1 keys — a chunk that was
        // already exactly one component (the planner's own decision, not a
        // bisection artifact) has nothing left to isolate, so a failure
        // propagates immediately exactly as it always has.
        const result =
          chunkKeys.length > 1
            ? await this.retrieveChunkWithIsolation(chunkKeys, chunkDir, retrieveAndConvert, connection)
            : await retrieveAndConvert(chunkKeys, chunkDir, undefined, connection);
        for (const [rel, abs] of result.files) files.set(join(`chunk-${i}`, rel), abs);
        missing.push(...result.missing);
      });
    } catch (err) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    return { sourceId: this.id, rootDir, files, missing: missing.length > 0 ? missing : undefined };
  }

  /**
   * `retrieveAndConvert` operates on its whole input as one unit from this
   * method's point of view — there's no per-component partial success for a
   * failure thrown out of it. This bisect-and-retry loop is what's left of
   * that isolation strategy after Phase 2 Workstream D's performance
   * investigation (see `convertComponentsWithIsolation`'s doc comment
   * below): it now exists ONLY as the fallback for genuine retrieve-level
   * failures (a real `ComponentSet.retrieve()`/`pollStatus()` exception —
   * auth expiry, a network blip, an org-side error) and for callers that
   * inject their own `retrieveAndConvert` (tests; anything that doesn't
   * separate retrieve from convert). It still bisects by re-invoking
   * `retrieveAndConvert` wholesale, which means EACH bisection node is a
   * fresh network round trip — correct and cheap when failures are rare (a
   * real retrieve outage fails identically at every granularity, so the
   * budget below is exhausted in a handful of calls), but see
   * `convertComponentsWithIsolation` for why that made this THE wrong tool
   * for the specific failure this was originally written to handle
   * (conversion-only failures, which are local/CPU-bound and don't need a
   * fresh network retrieve to isolate).
   *
   * On failure, bisects the chunk and retries each half recursively rather
   * than retrying every component individually — O(log n) extra
   * retrieve+convert calls to isolate a single bad component out of n,
   * instead of n, PROVIDED failures are sparse (this degrades badly when
   * they are not — see below). The common case (nothing wrong) is
   * unaffected: exactly one call, same as before this existed. A component
   * that still fails once isolated to a batch of one is recorded in
   * `missing` (surfaced the same way a retrieve-level failure already is)
   * and reported via `onWarning`, instead of aborting the whole
   * `materialize()` call — UNLESS the proportional budget
   * (`MIN_ISOLATED_FAILURES`/`MAX_ISOLATED_FAILURE_RATIO` above) is
   * exhausted for this top-level chunk, in which case the underlying error
   * propagates and the whole `materialize()` call fails, same as before
   * this existed.
   */
  private async retrieveChunkWithIsolation(
    chunkKeys: ComponentKey[],
    dir: string,
    retrieveAndConvert: (
      keys: ComponentKey[],
      destDir: string,
      signal: AbortSignal | undefined,
      connection: Connection,
    ) => Promise<RetrieveAndConvertResult>,
    connection: Connection,
    // Default only applies on the outermost call (recursion always passes
    // the shared `budget` explicitly) — `chunkKeys.length` here is
    // therefore the ORIGINAL top-level chunk size, before any bisection,
    // which is exactly what the proportional budget should be computed
    // from. See MIN_ISOLATED_FAILURES/MAX_ISOLATED_FAILURE_RATIO's doc
    // comment for why this is proportional rather than a flat count.
    budget: { remaining: number } = {
      remaining: Math.max(MIN_ISOLATED_FAILURES, Math.ceil(chunkKeys.length * MAX_ISOLATED_FAILURE_RATIO)),
    },
  ): Promise<RetrieveAndConvertResult> {
    try {
      return await retrieveAndConvert(chunkKeys, dir, undefined, connection);
    } catch (err) {
      if (chunkKeys.length === 1) {
        const key = chunkKeys[0]!;
        if (budget.remaining <= 0) {
          throw err; // exhausted the tolerance for isolated failures — treat as systemic, fail loud.
        }
        budget.remaining -= 1;
        this.deps.onWarning?.(
          `Retrieve/convert failed for ${key.type} "${key.fullName}" from ${this.label}: ${(err as Error).message}. ` +
            `Treating this one component as missing rather than failing every other component in the same retrieve chunk.`,
        );
        return { files: new Map(), missing: [{ key, reason: (err as Error).message }] };
      }

      const mid = Math.floor(chunkKeys.length / 2);
      const halves: ReadonlyArray<readonly [ComponentKey[], string]> = [
        [chunkKeys.slice(0, mid), join(dir, 'a')],
        [chunkKeys.slice(mid), join(dir, 'b')],
      ];
      const files = new Map<string, string>();
      const missing: Array<{ key: ComponentKey; reason: string }> = [];
      // Shares one `budget` across both halves (and all deeper recursion)
      // so the cap is per ORIGINAL top-level chunk, not per branch —
      // otherwise a systemic failure would get a full budget in each half
      // independently and the cap would do nothing.
      await Promise.all(
        halves.map(async ([half, halfDir]) => {
          await mkdir(halfDir, { recursive: true });
          const result = await this.retrieveChunkWithIsolation(half, halfDir, retrieveAndConvert, connection, budget);
          const prefix = relative(dir, halfDir);
          for (const [rel, abs] of result.files) files.set(join(prefix, rel), abs);
          missing.push(...result.missing);
        }),
      );
      return { files, missing };
    }
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

      // Everything below this point is LOCAL (files already sit in
      // mdapiDir from the ONE retrieve above) — see
      // convertComponentsWithIsolation's doc comment for why conversion
      // failures are isolated here, locally, instead of by bisecting this
      // whole retrieveAndConvert call (which is what materialize()'s outer
      // retrieveChunkWithIsolation used to do, and is exactly the Phase 2
      // Workstream D root cause of the 33-type default's >13-minute run).
      const components = [...result.components] as SourceComponent[];
      const converter = new MetadataConverter(this.registry);
      const convertMissing = await this.convertComponentsWithIsolation(
        components,
        async (subset) => {
          await converter.convert(subset, 'source', {
            type: 'directory',
            outputDirectory: destDir,
            genUniqueDir: false,
          });
        },
        (component) => ({ type: component.type.name, fullName: component.fullName }),
      );

      // See `fixDoubledMetaXmlSuffix`'s doc comment: a real, discovered
      // bug in the retrieve+convert interaction for content-less XML
      // types (Profile, PermissionSet, Layout, ...) that must be
      // corrected before `walkDir` records the (currently unresolvable)
      // filenames.
      await fixDoubledMetaXmlSuffix(destDir);

      const files = new Map<string, string>();
      await walkDir(destDir, destDir, files);

      return { files, missing: [...missing, ...convertMissing] };
    } finally {
      await rm(mdapiDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * PERFORMANCE FIX — Phase 2 Workstream D, the confirmed root cause of the
   * 33-type default inventory's real-org comparison exceeding 13 minutes
   * without completing.
   *
   * `retrieveChunkWithIsolation` (above) isolates failures by bisecting and
   * re-invoking the WHOLE `retrieveAndConvert` — retrieve (network) AND
   * convert (local) together — as one atomic unit. That's the right
   * strategy for a genuine retrieve-level failure, but the StaticResource
   * `BadZipFile` failure this was built for (see the confirmed-root-cause
   * doc comment that used to live on `retrieveChunkWithIsolation`, still
   * accurate: some `omnistudio__` `StaticResource`s declare
   * `contentType: application/zip` but the Metadata API returns their
   * content pre-exploded into a directory, so SDR's
   * `StaticResourceMetadataTransformer` throws `BadZipFile` for the WHOLE
   * `MetadataConverter.convert()` batch) happens ENTIRELY LOCALLY, after
   * the network retrieve has already succeeded and every file already sits
   * on disk in `mdapiDir`. Bisecting at the `retrieveAndConvert` level
   * therefore re-runs a full Salesforce `ComponentSet.retrieve()` +
   * `pollStatus()` round trip — an async job with real, non-trivial fixed
   * latency — for every single bisection node, even though nothing about
   * the network retrieve was ever the problem.
   *
   * Quantified (network-free simulation of the exact bisection algorithm,
   * `retrieveChunkWithIsolation`'s pre-fix logic, against the real
   * measured ARM DEV shape — 200 StaticResources, ~60-70 BadZipFile
   * failures, i.e. ~30% failure density): bisection issues on the order of
   * 250-270 `retrieveAndConvert` calls to resolve one chunk that should
   * have cost 1, and in most runs EXHAUSTS the proportional failure budget
   * partway through and re-throws, failing the whole chunk anyway. At
   * even a conservative few seconds of fixed latency per Salesforce
   * Retrieve+poll cycle, 250+ redundant network round trips alone accounts
   * for minutes, before any additional delay from Salesforce-side
   * concurrent-request throttling (the old code's bisection halves ran via
   * unbounded `Promise.all`, which could fan out well past the configured
   * `retrieveConcurrency`). This is what actually produced the
   * "33-type default exceeded 13 minutes without completing" observation —
   * not `listMetadata` batching, not retrieve chunk sizing, and not SQLite
   * contention.
   *
   * The fix: isolate CONVERSION failures by bisecting the LOCAL
   * `MetadataConverter.convert()` call over an in-memory array of
   * already-retrieved `SourceComponent`s — no network call anywhere in
   * this method. Bisecting a purely local, CPU/disk-bound operation 250
   * times costs milliseconds, not minutes. `retrieveChunkWithIsolation`
   * still exists as the fallback for actual retrieve-level failures (which
   * remain rare and network-bound by nature, so bisecting them at the
   * network layer is still the right, cheap strategy) and for
   * test-injected `retrieveAndConvert` fakes that don't separate the two
   * phases.
   *
   * A standalone function (not a class method) and exported, rather than
   * private, on purpose: this bisection logic — the actual thing that
   * needed fixing — is directly unit testable with a plain fake `convertFn`
   * that never touches SDR, a `ComponentSet`, or a `Connection`, the same
   * way `chunking.ts`'s `planMaterializeChunks` is tested directly rather
   * than only indirectly through `OrgSource.materialize()`. See
   * `test/sources/org-source.test.ts`'s `convertComponentsWithIsolation`
   * describe block for the tests proving: (1) dense/clustered failures no
   * longer blow up call count the way they did when isolation bisected at
   * the retrieve level, (2) the proportional budget is still enforced
   * (systemic failure still throws), (3) `describe`/`onWarning` wiring
   * matches `retrieveChunkWithIsolation`'s existing behavior exactly, just
   * relocated.
   */
  private convertComponentsWithIsolation<T>(
    items: readonly T[],
    convertFn: (items: readonly T[]) => Promise<void>,
    describe: (item: T) => ComponentKey,
  ): Promise<Array<{ key: ComponentKey; reason: string }>> {
    return convertWithIsolation(items, convertFn, describe, this.label, this.deps.onWarning);
  }
}

/** See `OrgSource.convertComponentsWithIsolation`'s doc comment — this is that method's body, extracted so it's directly unit testable. */
export async function convertWithIsolation<T>(
  items: readonly T[],
  convertFn: (items: readonly T[]) => Promise<void>,
  describe: (item: T) => ComponentKey,
  sourceLabel: string,
  onWarning: ((message: string) => void) | undefined,
  budget: { remaining: number } = {
    remaining: Math.max(
      MIN_ISOLATED_FAILURES,
      Math.ceil(items.length * MAX_ISOLATED_FAILURE_RATIO),
    ),
  },
): Promise<Array<{ key: ComponentKey; reason: string }>> {
  if (items.length === 0) return [];
  try {
    await convertFn(items);
    return [];
  } catch (err) {
    if (items.length === 1) {
      const key = describe(items[0]!);
      if (budget.remaining <= 0) {
        throw err; // exhausted the tolerance for isolated failures — treat as systemic, fail loud.
      }
      budget.remaining -= 1;
      onWarning?.(
        `Convert failed for ${key.type} "${key.fullName}" from ${sourceLabel}: ${(err as Error).message}. ` +
          `Treating this one component as missing rather than failing every other component in the same ` +
          `conversion batch (isolated locally — no additional retrieve was needed).`,
      );
      return [{ key, reason: (err as Error).message }];
    }

    // Sequential, not `Promise.all`: this is local CPU/disk work now, not
    // network calls, so there's no latency to hide behind concurrency — and
    // sequential avoids two halves converting into the same `destDir` at
    // the same time for no benefit.
    const mid = Math.floor(items.length / 2);
    const missingA = await convertWithIsolation(items.slice(0, mid), convertFn, describe, sourceLabel, onWarning, budget);
    const missingB = await convertWithIsolation(items.slice(mid), convertFn, describe, sourceLabel, onWarning, budget);
    return [...missingA, ...missingB];
  }
}

/**
 * The pre-retrieve filter gate for every `listMetadata`-sourced entry —
 * THIS is the fix for the confirmed bug (see the module's task brief):
 * previously `OrgSource.inventory()` resolved `filter.types` (via
 * `resolveInventoryTypes`) but never consulted `namePatterns`,
 * `modifiedSince`, `modifiedBy`, `excludeNamespaces`, or
 * `excludeManagedPackages` at all, so an excluded component (e.g. a
 * corrupt `omnistudio__` `StaticResource`) still became an inventory entry
 * and still reached a retrieve chunk. Routes through the same
 * `matchesTypeFilter` predicate `SfdxProjectSource`/`GitRefSource` already
 * used correctly, passing the Metadata API's own `namespacePrefix`/
 * `manageableState`/`lastModifiedByName` signals so namespace and
 * authorship filtering are authoritative here rather than falling back to
 * `fullName` heuristics.
 */
function matchesFilter(p: FilePropertiesLike, filter: TypeFilter): boolean {
  return matchesTypeFilter(
    {
      type: p.type,
      fullName: p.fullName,
      lastModifiedDate: p.lastModifiedDate,
      namespacePrefix: p.namespacePrefix ?? '',
      manageableState: p.manageableState,
      modifiedBy: p.lastModifiedByName ?? p.lastModifiedById,
    },
    filter,
  );
}

function toInventoryEntry(p: FilePropertiesLike): ComponentInventoryEntry {
  const namespacePrefix = p.namespacePrefix ?? '';
  return {
    key: { type: p.type, fullName: p.fullName },
    lastModifiedDate: p.lastModifiedDate,
    id: p.id,
    namespacePrefix: namespacePrefix === '' ? undefined : namespacePrefix,
  };
}

async function mktempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const META_XML_SUFFIX = '-meta.xml';
const DOUBLED_META_XML_SUFFIX = META_XML_SUFFIX + META_XML_SUFFIX;

/**
 * REAL BUG, discovered by spot-checking `dependencies.sync` against ARM
 * DEV/RCA DEV (Phase 3 Workstream B verification) and confirmed by
 * inspecting SDR's `DefaultMetadataTransformer.getXmlDestination`
 * (`@salesforce/source-deploy-retrieve/lib/src/convert/transformers/
 * defaultMetadataTransformer.js`): for a content-LESS, single-file XML
 * metadata type (`Profile`, `PermissionSet`, `Layout`, and any other type
 * whose `SourceComponent` has no separate `.content` — most declarative
 * metadata), the Metadata API's retrieve zip is unpacked by SDR with the
 * source-format `<Name>.<suffix>-meta.xml` filename ALREADY on disk in the
 * "metadata format" directory (confirmed directly: a raw, pre-conversion
 * retrieve of `Profile` writes `RLM Portal Profile.profile-meta.xml`, not
 * a bare `.profile` file). `MetadataConverter.convert(components,
 * 'source', ...)` doesn't know that and unconditionally appends the same
 * `-meta.xml` suffix again for this content-less case, producing
 * `RLM Portal Profile.profile-meta.xml-meta.xml` — a filename SDR's own
 * `MetadataResolver` cannot match to any registered type afterward, so
 * every downstream reader of the materialized tree
 * (`compare/content-reader.ts`'s `resolveComponentContents`, used by
 * comparisons, `merge.resolve`, and this phase's dependency-edge
 * supplementation) silently treats the component as retrieved-but-
 * unreadable, exactly as if the retrieve had failed.
 *
 * This was never caught before Phase 3 Workstream B because Phase 1/2's
 * real-org proof was ApexClass-only (see the plan's carried debt note:
 * "only ApexClass was measured at scale — XML-heavy types (Profile,
 * CustomObject, Layout) were not"). ApexClass has a separate `.cls`
 * content file, so its `SourceComponent` takes `getXmlDestination`'s
 * `else if (suffix)` branch (rewrite via a regex substitution, not a raw
 * append) and never exhibits this.
 *
 * Fix: after conversion, walk the output directory and collapse any
 * doubled `-meta.xml-meta.xml` suffix back to one, renaming the file in
 * place. Purely corrective and narrowly conditioned on the exact doubled
 * string — a type that never exhibits the quirk (the overwhelming
 * majority, including every type this project's existing real-org proof
 * already covers) is completely unaffected.
 */
export async function fixDoubledMetaXmlSuffix(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fixDoubledMetaXmlSuffix(abs);
    } else if (entry.name.endsWith(DOUBLED_META_XML_SUFFIX)) {
      const fixedName = entry.name.slice(0, -META_XML_SUFFIX.length);
      await rename(abs, join(dir, fixedName));
    }
  }
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
