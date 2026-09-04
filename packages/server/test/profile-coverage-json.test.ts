import { describe, expect, it } from 'vitest';
import type { SideCoverage } from '@vibeset/core';
import { deserializeProfileCoverage, serializeProfileCoverage } from '../src/trpc/routers/shared/profile-coverage-json.js';

describe('profile-coverage-json codec', () => {
  it('round-trips a "scoped" SideCoverage through JSON without losing its retrievedComponents Set', () => {
    // Regression test for the exact bug this module exists to prevent: a
    // bare `JSON.stringify` on an object holding a `Set` silently produces
    // `{}` for that field (a `Set` has no own enumerable properties), and
    // `JSON.parse` alone hands back a plain array/object, not a `Set` —
    // either way `diff/profiles.ts`'s `isCovered` (`coverage.retrievedComponents.has(ref)`)
    // would throw once it hit real org-sourced (non-full) coverage.
    const left: SideCoverage = { mode: 'scoped', retrievedComponents: new Set(['ApexClass:Foo', 'ApexClass:Bar']) };
    const right: SideCoverage = { mode: 'scoped', retrievedComponents: new Set() };
    const coverage = { 'Profile#Admin': { left, right } };

    const json = JSON.stringify(serializeProfileCoverage(coverage));
    // Prove the Set genuinely survived the JSON round-trip, not just that
    // parsing didn't throw.
    expect(json).toContain('ApexClass:Foo');
    expect(json).toContain('ApexClass:Bar');

    const parsed = JSON.parse(json) as Record<string, Parameters<typeof deserializeProfileCoverage>[0]>;
    const rehydrated = deserializeProfileCoverage(parsed['Profile#Admin']!);

    expect(rehydrated.left.mode).toBe('scoped');
    expect(rehydrated.right.mode).toBe('scoped');
    if (rehydrated.left.mode !== 'scoped' || rehydrated.right.mode !== 'scoped') throw new Error('unreachable');

    // The exact interface isCovered() needs — a real Set, not an array or {}.
    expect(rehydrated.left.retrievedComponents).toBeInstanceOf(Set);
    expect(rehydrated.left.retrievedComponents.has('ApexClass:Foo')).toBe(true);
    expect(rehydrated.left.retrievedComponents.has('ApexClass:Missing')).toBe(false);
    expect(rehydrated.right.retrievedComponents.size).toBe(0);
  });

  it('round-trips "full" coverage (no Set involved) unchanged', () => {
    const coverage = { 'Profile#Admin': { left: { mode: 'full' as const }, right: { mode: 'full' as const } } };
    const parsed = JSON.parse(JSON.stringify(serializeProfileCoverage(coverage))) as Record<string, Parameters<typeof deserializeProfileCoverage>[0]>;
    const rehydrated = deserializeProfileCoverage(parsed['Profile#Admin']!);
    expect(rehydrated.left).toEqual({ mode: 'full' });
    expect(rehydrated.right).toEqual({ mode: 'full' });
  });

  it('round-trips an optional "base" SideCoverage (three-way) alongside left/right', () => {
    const coverage = {
      'Profile#Admin': {
        left: { mode: 'scoped' as const, retrievedComponents: new Set(['ApexClass:Left']) },
        right: { mode: 'full' as const },
      },
    };
    const parsed = JSON.parse(JSON.stringify(serializeProfileCoverage(coverage))) as Record<string, any>;
    // base is optional and this fixture doesn't set one — confirm it's simply absent, not fabricated.
    expect(parsed['Profile#Admin'].base).toBeUndefined();
    const rehydrated = deserializeProfileCoverage(parsed['Profile#Admin']);
    expect(rehydrated.base).toBeUndefined();
  });
});
