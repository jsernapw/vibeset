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
}

export interface ComponentInventory {
  readonly sourceId: string;
  readonly entries: ComponentInventoryEntry[];
  /** Populated when folder-based types (Report, Dashboard, EmailTemplate, Document) were enumerated. */
  readonly folders?: string[];
}

/** Filters what `inventory()` enumerates. Empty/omitted arrays mean "no restriction". */
export interface TypeFilter {
  /** Metadata type names to include; omit for "all registered types". */
  readonly types?: string[];
  /** Glob-ish name patterns (e.g. `Account.*`) applied to `fullName`. */
  readonly namePatterns?: string[];
  /** Only include components modified on/after this ISO date. */
  readonly modifiedSince?: string;
  /** Exclude components in these namespaces (managed packages). */
  readonly excludeNamespaces?: string[];
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
