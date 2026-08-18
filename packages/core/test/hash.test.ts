import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';

describe('sha256Hex', () => {
  it('is deterministic', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  it('matches a known digest', () => {
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('differs for different content', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});
