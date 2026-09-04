/**
 * The central abstraction of VibeSet: every place metadata can come from
 * (a Salesforce org, a local SFDX project, a Git ref) implements this same
 * interface. The differ, the package builder, and the analyzers never know
 * or care which kind of source they're looking at — they only ever see
 * `SourceTree`s produced by `materialize()`.
 *
 * Implementations MUST normalize whatever they read into Salesforce
 * "source format" (the same on-disk shape `sf project retrieve` produces),
 * typically via SDR's `MetadataConverter`, so downstream code is uniform.
 */
export interface MetadataSource {
  readonly id: string;
  readonly kind: MetadataSourceKind;
  /** Human-readable label for UI display (org alias, project path, git ref). */
  readonly label: string;

  /**
   * Cheap enumeration: returns `fullName` + `lastModifiedDate` (+ id, where
   * the source can supply one) for every component matching `filter`.
   * Must NOT fetch component bodies.
   */
  inventory(filter: TypeFilter): Promise<ComponentInventory>;

  /**
   * Expensive fetch: materializes the actual file contents for the given
   * keys, converted to source format. Callers should have already consulted
   * the content-addressed snapshot cache and only request keys that are
   * missing or stale.
   */
  materialize(keys: ComponentKey[]): Promise<SourceTree>;
}

export type MetadataSourceKind = 'org' | 'sfdx-project' | 'git-ref';

/**
 * Identifies a single metadata component within a source. `type` is the
 * Salesforce metadata type name (e.g. `ApexClass`, `CustomField`) as known
 * to SDR's `RegistryAccess` — never hardcode a parallel type list.
 */
export interface ComponentKey {
  readonly type: string;
  readonly fullName: string;
  /**
   * Optional parent component full name for child/decomposed types
   * (e.g. a `CustomField`'s parent `CustomObject`).
   */
  readonly parentFullName?: string;
}

/** A single row of cheap-inventory metadata about a component. */
export interface ComponentInventoryEntry {
  readonly key: ComponentKey;
  /** ISO-8601 timestamp, as reported by the source (org `listMetadata`, FS mtime, git commit date). */
  readonly lastModifiedDate: string;
  /** Salesforce record Id, when the source is an org. */
  readonly id?: string;
  /** `true` when the source could not resolve a real timestamp (falls back to "always refetch"). */
  readonly lastModifiedDateUnknown?: boolean;
  /**
   * The managed-package namespace this component belongs to, when known.
   * For `OrgSource` this is `listMetadata`'s own `FileProperties.namespacePrefix`
   * — an authoritative API signal, never derived from `fullName`
   * string-parsing (see `sources/type-filter.ts`'s namespace resolution).
   * `undefined` means "confirmed no namespace" for org entries that
   * carried the signal, or "source doesn't report this" for filesystem
   * sources, which fall back to a `fullName` heuristic purely for
   * filtering and don't populate this field. Present mainly so a
   * filtered-IN namespaced component (the user explicitly chose to
   * include managed packages) can still be labeled as such by the UI
   * without a second lookup.
   */
  readonly namespacePrefix?: string;
}

export interface ComponentInventory {
  readonly sourceId: string;
  readonly entries: ComponentInventoryEntry[];
  /** Populated when folder-based types (Report, Dashboard, EmailTemplate, Document) were enumerated. */
  readonly folders?: string[];
}

/**
 * Filters what `inventory()` enumerates. Empty/omitted arrays mean "no
 * restriction" — this is the mechanical, source-of-truth contract every
 * `MetadataSource.inventory()` implementation must honor by filtering
 * BEFORE a component ever becomes an inventory entry, so an excluded
 * component never reaches a retrieve chunk (see `sources/type-filter.ts`'s
 * `matchesTypeFilter`, the shared predicate all three source kinds use).
 *
 * Any *product default* (e.g. "hide managed packages unless the user asks
 * for them") is a policy decision layered on top by whatever builds a
 * filter for a real comparison — see `sources/type-filter.ts`'s
 * `withManagedPackageDefault` — never baked in silently here, so an
 * omitted/empty `TypeFilter` always means literally "no restriction" at
 * this layer.
 */
export interface TypeFilter {
  /** Metadata type names to include; omit for "all registered types". */
  readonly types?: string[];
  /** Glob-ish name patterns (e.g. `Account.*`) applied to `fullName`. */
  readonly namePatterns?: string[];
  /** Only include components modified on/after this ISO date. */
  readonly modifiedSince?: string;
  /**
   * Only include components last modified by one of these identities.
   * Matched against whatever authorship signal the source can supply:
   * `OrgSource` matches `listMetadata`'s `lastModifiedByName` (falling back
   * to `lastModifiedById`); `GitRefSource` matches the last commit's
   * author name or email for the component's files. `SfdxProjectSource`
   * cannot support this (plain disk has no authorship concept) and ignores
   * it — filtering by `modifiedBy` against a local project inventory is a
   * silent no-op, not an error.
   */
  readonly modifiedBy?: string[];
  /** Exclude components in these specific namespaces (managed packages). */
  readonly excludeNamespaces?: string[];
  /**
   * Exclude every namespaced (managed-package) component, regardless of
   * which namespace — the coarse "hide all managed packages" switch,
   * independent of (and applied in addition to) `excludeNamespaces`
   * naming specific ones. Namespace detection prefers each source's own
   * authoritative signal over `fullName` heuristics where one exists (see
   * `sources/type-filter.ts`). For `OrgSource` specifically, a component
   * is treated as "someone else's managed package" only when it both
   * carries a `namespacePrefix` AND its `manageableState` is not
   * `'unmanaged'` — a packaging/dev org's OWN namespaced-but-editable
   * metadata reports `manageableState: 'unmanaged'` too, and must not be
   * excluded by this switch.
   */
  readonly excludeManagedPackages?: boolean;
}

/**
 * A materialized set of files in Salesforce source format, rooted at
 * `rootDir` on disk (may be a temp directory for org/git sources).
 * `files` maps repo-relative path -> absolute path, for convenient access
 * without re-walking the filesystem.
 */
export interface SourceTree {
  readonly sourceId: string;
  readonly rootDir: string;
  readonly files: ReadonlyMap<string, string>;
  /** Keys that were requested but could not be materialized, with a reason. */
  readonly missing?: ReadonlyArray<{ key: ComponentKey; reason: string }>;
}
