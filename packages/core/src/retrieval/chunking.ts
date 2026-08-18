import type { ComponentKey } from '../types/metadata-source.js';

/**
 * Metadata API package limits for a single retrieve (or deploy) zip.
 * Source: Salesforce Metadata API documentation. Retrieves/deploys that
 * would exceed either limit must be split into multiple requests.
 */
export const METADATA_API_LIMITS = {
  maxFiles: 10_000,
  maxZipBytes: 39 * 1024 * 1024,
} as const;

/**
 * THE PROFILE/PERMISSIONSET GOTCHA — read this before touching this file.
 *
 * The Metadata API only populates a Profile's or PermissionSet's *entries*
 * (field-level security, object permissions, Apex class access, Visualforce
 * page access, record type visibility, tab visibility, ...) for components
 * that are ALSO present in the same retrieve package. Retrieve a Profile on
 * its own and it comes back nearly empty — not an error, just silently
 * incomplete, which means a naive diff will silently under-report changes
 * and a user will lose real permission edits without ever seeing a warning.
 *
 * `PROFILE_PAIRED_TYPES` is the set of metadata types whose presence in a
 * retrieve package is what causes the corresponding Profile/PermissionSet
 * entries to be populated (object/field permissions <- CustomObject/
 * CustomField, class access <- ApexClass, page access <- ApexPage, tab
 * visibility <- CustomTab, record type visibility <- RecordType, layout
 * assignments <- Layout, and so on). `planMaterializeChunks` below refuses
 * to ever split a Profile/PermissionSet away from the paired-type
 * components in the same materialize request, even if that means exceeding
 * the "ideal" chunk size — see the pairing test in
 * `test/retrieval/chunking.test.ts` for the regression this guards against.
 */
export const PROFILE_LIKE_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

/** See the module doc above. Kept as a named, documented set rather than inline literals so the rule is discoverable and easy to extend. */
export const PROFILE_PAIRED_TYPES: ReadonlySet<string> = new Set([
  'CustomObject',
  'CustomField',
  'ApexClass',
  'ApexPage',
  'CustomTab',
  'RecordType',
  'Layout',
  'CustomPermission',
  'CustomApplication',
  'Flow',
  'ExternalDataSource',
]);

export interface ComponentSizeEstimate {
  readonly files: number;
  readonly bytes: number;
}

/**
 * Bundle-shaped types materialize to many files per component (an LWC
 * bundle is a directory of JS/HTML/CSS/meta files, not one file). Everything
 * else is treated as "a body file plus a -meta.xml", which covers the vast
 * majority of the Phase 1 metadata scope. This is intentionally a rough,
 * conservative estimate: inventory (the only thing available before a
 * retrieve happens) gives us a name and a timestamp, never a real file
 * count or byte size, so exact numbers aren't obtainable up front. Chunk
 * sizing only needs to stay safely under the API limits, not be exact.
 */
const BUNDLE_TYPES = new Set([
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'ExperienceBundle',
  'DigitalExperienceBundle',
  'StaticResource',
]);

const DEFAULT_ESTIMATE: ComponentSizeEstimate = { files: 2, bytes: 4 * 1024 };
const BUNDLE_ESTIMATE: ComponentSizeEstimate = { files: 12, bytes: 32 * 1024 };

export function estimateComponentSize(key: ComponentKey): ComponentSizeEstimate {
  return BUNDLE_TYPES.has(key.type) ? BUNDLE_ESTIMATE : DEFAULT_ESTIMATE;
}

function sumEstimate(
  keys: readonly ComponentKey[],
  estimate: (key: ComponentKey) => ComponentSizeEstimate,
): ComponentSizeEstimate {
  let files = 0;
  let bytes = 0;
  for (const key of keys) {
    const e = estimate(key);
    files += e.files;
    bytes += e.bytes;
  }
  return { files, bytes };
}

export interface ChunkingOptions {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  /** Override for tests / callers with better size knowledge than the default heuristic. */
  readonly estimate?: (key: ComponentKey) => ComponentSizeEstimate;
}

export interface MaterializeChunkPlan {
  /** Each inner array is one retrieve request's worth of keys, kept under the configured limits (Profile/PermissionSet pairing excepted — see warnings). */
  readonly chunks: ComponentKey[][];
  readonly warnings: string[];
}

/**
 * Splits a flat list of requested component keys into retrieve-sized chunks,
 * respecting `maxFiles`/`maxBytes` (defaulting to the real Metadata API
 * limits) — EXCEPT that any Profile/PermissionSet in the request is always
 * kept in the same chunk as every `PROFILE_PAIRED_TYPES` component also in
 * the request. See the module doc for why: splitting them is a correctness
 * bug, not just a size optimization.
 */
export function planMaterializeChunks(
  keys: readonly ComponentKey[],
  options: ChunkingOptions = {},
): MaterializeChunkPlan {
  const maxFiles = options.maxFiles ?? METADATA_API_LIMITS.maxFiles;
  const maxBytes = options.maxBytes ?? METADATA_API_LIMITS.maxZipBytes;
  const estimate = options.estimate ?? estimateComponentSize;
  const warnings: string[] = [];

  const profileLike = keys.filter((k) => PROFILE_LIKE_TYPES.has(k.type));
  const hasProfileLike = profileLike.length > 0;
  // Paired-type components only get pulled into the forced core chunk when
  // there's actually a Profile/PermissionSet in the request to pair them
  // with — otherwise (the common case) they're just ordinary components and
  // chunk normally like everything else in `rest`.
  const paired = hasProfileLike ? keys.filter((k) => PROFILE_PAIRED_TYPES.has(k.type)) : [];
  const coreSet = new Set(hasProfileLike ? [...profileLike, ...paired] : []);
  const rest = hasProfileLike ? keys.filter((k) => !coreSet.has(k)) : keys.slice();

  const chunks: ComponentKey[][] = [];

  if (profileLike.length > 0) {
    if (paired.length === 0) {
      warnings.push(
        `${profileLike.length} Profile/PermissionSet component(s) requested ` +
          `(${profileLike.map((k) => k.fullName).join(', ')}) with no paired component types ` +
          `(CustomObject, CustomField, ApexClass, ApexPage, CustomTab, RecordType, Layout, ...) ` +
          `in the same request. The Metadata API will return these with empty entries.`,
      );
    }

    const core = [...profileLike, ...paired];
    const coreEstimate = sumEstimate(core, estimate);
    if (coreEstimate.files > maxFiles || coreEstimate.bytes > maxBytes) {
      warnings.push(
        `Profile/PermissionSet pairing forced ${core.length} components into a single retrieve ` +
          `chunk (~${coreEstimate.files} files, ~${Math.round(coreEstimate.bytes / 1024)}KB estimated) ` +
          `that exceeds the configured limit (${maxFiles} files / ${Math.round(maxBytes / (1024 * 1024))}MB). ` +
          `It is kept together anyway — splitting it would silently under-report Profile/PermissionSet entries. ` +
          `If the live retrieve is rejected for size, reduce the selection.`,
      );
    }
    chunks.push(core);
  }

  let current: ComponentKey[] = [];
  let currentEstimate: ComponentSizeEstimate = { files: 0, bytes: 0 };
  for (const key of rest) {
    const e = estimate(key);
    const wouldExceed =
      current.length > 0 &&
      (currentEstimate.files + e.files > maxFiles || currentEstimate.bytes + e.bytes > maxBytes);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      currentEstimate = { files: 0, bytes: 0 };
    }
    current.push(key);
    currentEstimate = { files: currentEstimate.files + e.files, bytes: currentEstimate.bytes + e.bytes };
  }
  if (current.length > 0) chunks.push(current);

  return { chunks, warnings };
}
