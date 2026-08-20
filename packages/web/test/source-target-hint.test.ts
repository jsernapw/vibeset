import { describe, expect, it } from 'vitest';
import { resolveContinueHint } from '../src/lib/source-target-hint';

describe('resolveContinueHint (why the "Continue to metadata types" button is disabled)', () => {
  it('explains that both a source and target are needed when neither is chosen', () => {
    expect(resolveContinueHint({ hasSource: false, hasTarget: false, sameNonEmpty: false })).toBe(
      'Choose a source and a target to continue.',
    );
  });

  it('explains that a source is still needed when only the target is chosen', () => {
    expect(resolveContinueHint({ hasSource: false, hasTarget: true, sameNonEmpty: false })).toBe(
      'Choose a source to continue.',
    );
  });

  it('explains that a target is still needed when only the source is chosen', () => {
    expect(resolveContinueHint({ hasSource: true, hasTarget: false, sameNonEmpty: false })).toBe(
      'Choose a target to continue.',
    );
  });

  it('flags a same source/target pick even though both are technically "chosen"', () => {
    expect(resolveContinueHint({ hasSource: true, hasTarget: true, sameNonEmpty: true })).toBe(
      'Source and target must be different.',
    );
  });

  it('returns undefined (no hint needed) once both are chosen and distinct', () => {
    expect(resolveContinueHint({ hasSource: true, hasTarget: true, sameNonEmpty: false })).toBeUndefined();
  });

  it('the same-source-target case takes precedence over the missing-selection cases', () => {
    // sameNonEmpty implies both are technically set, but assert the precedence explicitly.
    expect(resolveContinueHint({ hasSource: true, hasTarget: true, sameNonEmpty: true })).not.toBe(
      'Choose a source and a target to continue.',
    );
  });
});
