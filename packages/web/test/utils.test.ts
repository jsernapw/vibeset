import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/utils';

describe('cn', () => {
  it('merges class names and dedupes tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', undefined, false, 'font-bold')).toBe('text-sm font-bold');
  });
});
