import type { MergeProfileCoverage, SideCoverage } from '@vibeset/core';

/**
 * JSON codec for `comparisons.profileCoverageJson` — the ONLY place a
 * `SideCoverage`'s `{ mode: 'scoped'; retrievedComponents: ReadonlySet<string> }`
 * variant round-trips through `JSON.stringify`/`JSON.parse`, so the `Set`
 * conversion belongs here, once, rather than at both call sites.
 *
 * THE BUG THIS EXISTS TO PREVENT: `JSON.stringify` has no idea how to
 * serialize a `Set` — `JSON.stringify(new Set(['a', 'b']))` silently
 * produces `"{}"` (a `Set` has no own enumerable properties for the
 * serializer to see), not an error. Written that way, EVERY
 * `mode: 'scoped'` coverage entry — the one that matters, since `'full'`
 * has no `Set` field at all — would silently collapse to
 * `retrievedComponents: {}` on write. Read back, `{}` is a plain object,
 * not a `Set`: `diff/profiles.ts`'s `isCovered` calls
 * `coverage.retrievedComponents.has(ref)`, and `{}.has` is not a function —
 * so the very first real org-sourced Profile/PermissionSet merge with
 * anything less than full coverage would throw a `TypeError` out of
 * `merge.resolve`, not silently misbehave. Loud, but still a broken
 * feature for the #1 real-world case (org vs org) this route exists to
 * support — worth catching here rather than at a user's keyboard.
 *
 * `serializeProfileCoverage` (write side, `comparisons.ts`) converts every
 * `retrievedComponents` `Set` to a plain array before `JSON.stringify`;
 * `deserializeProfileCoverage` (read side, `merge.ts`) converts every such
 * array back into a real `Set` after `JSON.parse`, so `isCovered`'s
 * `.has(ref)` call sees the interface it was written against either way.
 */
type JsonSideCoverage = { readonly mode: 'full' } | { readonly mode: 'scoped'; readonly retrievedComponents: readonly string[] };
type JsonProfileCoverage = { readonly base?: JsonSideCoverage; readonly left: JsonSideCoverage; readonly right: JsonSideCoverage };

function toJsonSideCoverage(coverage: SideCoverage): JsonSideCoverage {
  return coverage.mode === 'full' ? { mode: 'full' } : { mode: 'scoped', retrievedComponents: [...coverage.retrievedComponents] };
}

function fromJsonSideCoverage(coverage: JsonSideCoverage): SideCoverage {
  return coverage.mode === 'full' ? { mode: 'full' } : { mode: 'scoped', retrievedComponents: new Set(coverage.retrievedComponents) };
}

/** Write side: call before `JSON.stringify`-ing a comparison's whole `profileCoverage` map into `profileCoverageJson`. */
export function serializeProfileCoverage(
  coverage: Readonly<Record<string, { readonly left: SideCoverage; readonly right: SideCoverage }>>,
): Record<string, JsonProfileCoverage> {
  const out: Record<string, JsonProfileCoverage> = {};
  for (const [key, entry] of Object.entries(coverage)) {
    out[key] = { left: toJsonSideCoverage(entry.left), right: toJsonSideCoverage(entry.right) };
  }
  return out;
}

/** Read side: call after `JSON.parse`-ing `profileCoverageJson`, on the single entry `merge.resolve` needs for its component. */
export function deserializeProfileCoverage(coverage: JsonProfileCoverage): MergeProfileCoverage {
  return {
    ...(coverage.base ? { base: fromJsonSideCoverage(coverage.base) } : {}),
    left: fromJsonSideCoverage(coverage.left),
    right: fromJsonSideCoverage(coverage.right),
  };
}
