import { describe, expect, it } from 'vitest';
import { diffText } from '../../src/diff/text.js';

describe('diffText', () => {
  it('returns a single unchanged hunk for identical text', () => {
    const hunks = diffText('line1\nline2\n', 'line1\nline2\n');
    expect(hunks).toEqual([
      { added: false, removed: false, value: 'line1\nline2\n', lineStart: 1 },
    ]);
  });

  it('treats CRLF and LF as equivalent', () => {
    const hunks = diffText('line1\r\nline2\r\n', 'line1\nline2\n');
    expect(hunks.every((h) => !h.added && !h.removed)).toBe(true);
  });

  it('computes correct 1-based lineStart for an insertion', () => {
    const left = 'a\nb\nc\n';
    const right = 'a\nb\nX\nc\n';
    const hunks = diffText(left, right);
    const added = hunks.find((h) => h.added)!;
    expect(added.value).toBe('X\n');
    // Inserted after line 2 ("b"), so it starts at left-content line 3.
    expect(added.lineStart).toBe(3);
  });

  it('computes correct lineStart for a deletion', () => {
    const left = 'a\nb\nc\nd\n';
    const right = 'a\nd\n';
    const hunks = diffText(left, right);
    const removed = hunks.find((h) => h.removed)!;
    expect(removed.value).toBe('b\nc\n');
    expect(removed.lineStart).toBe(2);
  });

  it('handles undefined sides as empty content', () => {
    expect(diffText(undefined, 'new\n')).toEqual([
      { added: true, removed: false, value: 'new\n', lineStart: 1 },
    ]);
    expect(diffText('old\n', undefined)).toEqual([
      { added: false, removed: true, value: 'old\n', lineStart: 1 },
    ]);
  });
});
