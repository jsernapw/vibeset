import type { ComponentKey } from '../types/metadata-source.js';
import type { DiffEntry, DiffResult } from '../types/diff.js';
import { canonicalizeText, canonicalizeXml } from './normalize.js';
import { diffXml } from './differ.js';
import { diffText } from './text.js';
import { diffProfileLike, type ProfileDiffContext } from './profiles.js';

/**
 * The single entry point that ties normalize/differ/text/profiles together
 * into the `DiffResult` the rest of the product consumes. Everything above
 * this file operates on raw strings; this is the only place that knows
 * about `ComponentKey` and dispatches by metadata type.
 *
 * Dispatch defaults to XML (most Salesforce metadata is XML, and the
 * generic differ + natural-keys table degrade gracefully via the
 * content-hash fallback for any type without a table entry — see
 * natural-keys.ts). Only a known, explicit list of opaque-body types uses
 * the text differ instead. This means Phase 2's 100+ additional metadata
 * types work out of the box without touching this file; you only add here
 * when a new type turns out to have a non-XML body.
 */
const TEXT_BODY_TYPES: ReadonlySet<string> = new Set([
  'ApexClass',
  'ApexTrigger',
  'ApexPage',
  'ApexComponent',
  'AuraDefinition',
  'LightningComponentResource',
  // EmailTemplate uses SDR's `matchingContentFile` adapter — the exact same
  // "body file + sidecar -meta.xml" shape as ApexPage/ApexComponent above
  // (verified via the registry's `strategies.adapter`, not guessed): the
  // template body (.email/.txt/.html) is opaque markup, not a schema this
  // differ should try to parse as XML. Same tradeoff already accepted for
  // ApexPage/ApexComponent applies here too: the -meta.xml sidecar (folder,
  // subject, description, apiVersion, ...) is not diffed by this dispatch —
  // see content-reader.ts, which picks body-vs-xml per this same set.
  'EmailTemplate',
]);

const PROFILE_LIKE_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

/** Text-body (opaque, non-XML) metadata types — exported (additive) so callers outside this module (e.g. the comparison engine, which needs to know whether to read a component's content file or its metadata xml when materializing) can dispatch the same way without duplicating this list. */
export { TEXT_BODY_TYPES };

function hasRealChange(entries: readonly DiffEntry[]): boolean {
  return entries.some((e) => e.status !== 'identical' || (e.children && hasRealChange(e.children)));
}

/**
 * Diffs one component between two sources. `left`/`right` are the raw file
 * contents (undefined when the component doesn't exist on that side at
 * all — a whole-component add/delete).
 *
 * `profileContext` disambiguates absent-because-not-retrieved from
 * genuinely-removed for Profile/PermissionSet comparisons (see profiles.ts).
 * It is optional here — and simply ignored — for every type OTHER than
 * Profile/PermissionSet, so the vast majority of callers (diffing an
 * ApexClass, a CustomObject, ...) are unaffected. But for Profile/
 * PermissionSet specifically, omitting it is a hard error, not a silent
 * "assume full coverage" fallback: a Profile retrieved from an org only
 * contains entries for components also present in the same retrieve
 * package, so treating an omitted context as full coverage would silently
 * report absent-but-not-retrieved entries as deletions — and a deployment
 * built from that diff would strip real user permissions. Callers comparing
 * scope-limited org retrievals MUST supply a computed `'scoped'` context;
 * callers with known-complete files on both sides (a local SFDX project
 * file, a full-org retrieve, a hand-written fixture) must opt into that by
 * passing `FULL_COVERAGE_CONTEXT` explicitly.
 */
export function diffComponent(
  key: ComponentKey,
  left: string | undefined,
  right: string | undefined,
  profileContext?: ProfileDiffContext,
): DiffResult {
  if (left === undefined && right === undefined) {
    return { key, status: 'identical' };
  }
  if (left !== undefined && right === undefined) {
    return { key, status: 'deleted', leftSha256: hashOf(key.type, left) };
  }
  if (left === undefined && right !== undefined) {
    return { key, status: 'new', rightSha256: hashOf(key.type, right) };
  }

  const l = left as string;
  const r = right as string;

  if (TEXT_BODY_TYPES.has(key.type)) {
    const leftCanon = canonicalizeText(l);
    const rightCanon = canonicalizeText(r);
    if (leftCanon.sha256 === rightCanon.sha256) {
      // Equal hash short-circuits to identical with no further work — the
      // main performance lever for the whole comparison engine.
      return {
        key,
        status: 'identical',
        leftSha256: leftCanon.sha256,
        rightSha256: rightCanon.sha256,
      };
    }
    const textDiff = diffText(l, r);
    return {
      key,
      status: 'changed',
      leftSha256: leftCanon.sha256,
      rightSha256: rightCanon.sha256,
      textDiff,
    };
  }

  const leftCanon = canonicalizeXml(l, key.type);
  const rightCanon = canonicalizeXml(r, key.type);
  if (leftCanon.sha256 === rightCanon.sha256) {
    return {
      key,
      status: 'identical',
      leftSha256: leftCanon.sha256,
      rightSha256: rightCanon.sha256,
    };
  }

  const entries = PROFILE_LIKE_TYPES.has(key.type)
    ? diffProfileLike(key.type as 'Profile' | 'PermissionSet', l, r, requireProfileContext(key, profileContext))
    : diffXml(key.type, l, r);

  // Derived from the entries, not assumed from hash inequality: for
  // Profile/PermissionSet, an unequal hash can still mean "no reportable
  // change" once retrieve-pairing ambiguity is accounted for (see
  // profiles.ts) — trusting the raw hash here would reintroduce the exact
  // bug that module exists to prevent.
  const status = hasRealChange(entries) ? 'changed' : 'identical';

  return {
    key,
    status,
    leftSha256: leftCanon.sha256,
    rightSha256: rightCanon.sha256,
    entries,
  };
}

/**
 * The runtime half of the inverted default: fails loudly, with a message
 * that explains both the hazard and the fix, rather than silently falling
 * back to full coverage. See the `diffComponent` doc comment above.
 */
function requireProfileContext(key: ComponentKey, ctx: ProfileDiffContext | undefined): ProfileDiffContext {
  if (!ctx) {
    throw new Error(
      `diffComponent: comparing ${key.type} "${key.fullName}" requires an explicit ProfileDiffContext — ` +
        `omitting it is not allowed. A Profile/PermissionSet retrieved from an org only contains entries for ` +
        `components that were ALSO in the same retrieve package, so assuming full coverage by default would ` +
        `silently report absent-but-not-retrieved entries as deletions, and a deployment package built from ` +
        `that diff would strip real user permissions with no warning. Pass FULL_COVERAGE_CONTEXT (from ` +
        `'./profiles.js') explicitly only when both sides are known-complete files (a local SFDX project file, ` +
        `a full-org retrieve, or a hand-written fixture); pass a computed 'scoped' SideCoverage (built from the ` +
        `set of components actually co-retrieved on that side — see retrieval/chunking.ts) for anything sourced ` +
        `from an org via a scope-limited comparison.`,
    );
  }
  return ctx;
}

function hashOf(type: string, content: string): string {
  return TEXT_BODY_TYPES.has(type)
    ? canonicalizeText(content).sha256
    : canonicalizeXml(content, type).sha256;
}
