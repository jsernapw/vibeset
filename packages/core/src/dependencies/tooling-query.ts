import type { Connection } from '@salesforce/core';
import type { DependencyEdge } from './types.js';

/** The eight columns this module actually reads off `MetadataComponentDependency` — see Salesforce's Tooling API object reference for the full (identical) row shape. */
export interface MetadataComponentDependencyRecord {
  readonly MetadataComponentId: string;
  readonly MetadataComponentType: string;
  readonly MetadataComponentName: string;
  readonly MetadataComponentNamespace: string | null;
  readonly RefMetadataComponentId: string;
  readonly RefMetadataComponentType: string;
  readonly RefMetadataComponentName: string;
  readonly RefMetadataComponentNamespace: string | null;
}

/** One page of a Tooling API SOQL query — the subset of jsforce's `Query`/`QueryResult` shape this module actually touches. */
export interface ToolingQueryPage<T> {
  readonly records: readonly T[];
  readonly done: boolean;
  readonly nextRecordsUrl?: string;
  readonly totalSize?: number;
}

/**
 * The paging surface this module needs from the Tooling API. Deliberately
 * narrower than jsforce's `Tooling` class (same reasoning as
 * `sources/org-source.ts`'s `FilePropertiesLike`) so tests can supply a
 * plain fake instead of a real `Connection`/`Tooling` object.
 */
export interface ToolingQueryClient {
  query<T>(soql: string): Promise<ToolingQueryPage<T>>;
  queryMore<T>(nextRecordsUrl: string): Promise<ToolingQueryPage<T>>;
}

/**
 * Wraps a live `@salesforce/core` `Connection`'s `.tooling` — the only
 * client `MetadataComponentDependency` is queryable through (it is a
 * Tooling-API-only object; it does not exist over the regular REST/SOAP
 * Query resource). `conn.tooling.query(soql)` returns jsforce's `Query`
 * object, which is itself a thenable that performs the request when
 * awaited — awaiting it directly (rather than calling `.exec()`/`.run()`)
 * is the documented jsforce usage and is what actually issues the HTTP
 * request.
 */
export function toolingClientFromConnection(connection: Connection): ToolingQueryClient {
  return {
    async query<T>(soql: string): Promise<ToolingQueryPage<T>> {
      return (await connection.tooling.query(soql)) as unknown as ToolingQueryPage<T>;
    },
    async queryMore<T>(nextRecordsUrl: string): Promise<ToolingQueryPage<T>> {
      return (await connection.tooling.queryMore(nextRecordsUrl)) as unknown as ToolingQueryPage<T>;
    },
  };
}

export interface QueryOrgDependencyEdgesOptions {
  /**
   * Restricts the query to edges whose FROM side is one of these metadata
   * types (`WHERE MetadataComponentType IN (...)`). Omit to query every
   * type the org has recorded — `MetadataComponentDependency` has no
   * `LIMIT`/`OFFSET` support, only cursor paging (`nextRecordsUrl`), so an
   * unrestricted query is legal but can be large on a big org; scoping to
   * the types actually in scope for a sync keeps the page count down
   * without changing the paging logic itself.
   */
  readonly fromTypes?: readonly string[];
  /** Called once per page fetched (`queryMore` round trip), with the running total of records seen — lets a caller report sync progress without this module knowing anything about jobs/UI. */
  readonly onPage?: (recordsSoFar: number, totalSize: number | undefined) => void;
}

function soqlStringList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');
}

const DEPENDENCY_FIELDS = [
  'MetadataComponentId',
  'MetadataComponentType',
  'MetadataComponentName',
  'MetadataComponentNamespace',
  'RefMetadataComponentId',
  'RefMetadataComponentType',
  'RefMetadataComponentName',
  'RefMetadataComponentNamespace',
].join(', ');

function normalizeNamespace(ns: string | null | undefined): string | undefined {
  return ns ? ns : undefined;
}

function recordToEdge(r: MetadataComponentDependencyRecord): DependencyEdge {
  return {
    fromType: r.MetadataComponentType,
    fromFullName: r.MetadataComponentName,
    toType: r.RefMetadataComponentType,
    toFullName: r.RefMetadataComponentName,
    provenance: 'org',
    fromNamespace: normalizeNamespace(r.MetadataComponentNamespace),
    toNamespace: normalizeNamespace(r.RefMetadataComponentNamespace),
  };
}

/**
 * Pages through the ENTIRE `MetadataComponentDependency` result set (or the
 * `fromTypes`-scoped subset) via `query` + repeated `queryMore` until
 * `done`, converting each row into a `DependencyEdge` with
 * `provenance: 'org'`.
 *
 * This is the org's own, org-computed dependency graph — see
 * `DependencyEdge`'s doc comment for what "authoritative" does and does not
 * mean about the result. Managed-package components are NOT excluded
 * here; namespace is preserved on every edge (`fromNamespace`/
 * `toNamespace`) specifically so a caller can apply the same
 * namespace/managed-package filtering policy `sources/type-filter.ts`
 * already applies to inventories — see `filterEdgesByNamespace` below.
 */
export async function queryOrgDependencyEdges(
  client: ToolingQueryClient,
  options: QueryOrgDependencyEdgesOptions = {},
): Promise<DependencyEdge[]> {
  const where = options.fromTypes && options.fromTypes.length > 0
    ? ` WHERE MetadataComponentType IN (${soqlStringList(options.fromTypes)})`
    : '';
  const soql = `SELECT ${DEPENDENCY_FIELDS} FROM MetadataComponentDependency${where}`;

  const edges: DependencyEdge[] = [];
  let page = await client.query<MetadataComponentDependencyRecord>(soql);
  for (const r of page.records) edges.push(recordToEdge(r));
  options.onPage?.(edges.length, page.totalSize);

  while (!page.done && page.nextRecordsUrl) {
    page = await client.queryMore<MetadataComponentDependencyRecord>(page.nextRecordsUrl);
    for (const r of page.records) edges.push(recordToEdge(r));
    options.onPage?.(edges.length, page.totalSize);
  }

  return edges;
}

/**
 * Namespace-only filtering policy for dependency edges, mirroring
 * `sources/type-filter.ts`'s `excludeNamespaces`/`excludeManagedPackages`
 * dimensions of `TypeFilter`. Deliberately COARSER than that module: the
 * Tooling API's `MetadataComponentDependency` rows carry a namespace but no
 * `manageableState` (there is no equivalent signal distinguishing "this is
 * the ORG's OWN packaging namespace" from "this belongs to an installed
 * managed package" the way `listMetadata`'s `FileProperties.manageableState`
 * does for inventory). An edge whose endpoint has a non-empty namespace is
 * therefore treated as "belongs to a package" unconditionally when
 * `excludeManagedPackages` is set — correct for the overwhelming common
 * case (an installed package like `omnistudio__`) but would ALSO exclude a
 * packaging org's own namespaced components, unlike the inventory path.
 * Documented here and in the module's README-equivalent (this comment) —
 * not silently assumed equivalent to `matchesTypeFilter`.
 */
export function filterEdgesByNamespace(
  edges: readonly DependencyEdge[],
  opts: { readonly excludeNamespaces?: readonly string[]; readonly excludeManagedPackages?: boolean },
): DependencyEdge[] {
  const excluded = new Set(opts.excludeNamespaces ?? []);
  const isExcludedNamespace = (ns: string | undefined): boolean => {
    if (!ns) return false;
    if (opts.excludeManagedPackages) return true;
    return excluded.has(ns);
  };
  return edges.filter((e) => !isExcludedNamespace(e.fromNamespace) && !isExcludedNamespace(e.toNamespace));
}
