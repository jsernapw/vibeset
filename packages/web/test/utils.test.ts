import { describe, expect, it } from 'vitest';
import { cn, formatBytes } from '../src/lib/utils';

describe('cn', () => {
  it('merges class names and dedupes tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', undefined, false, 'font-bold')).toBe('text-sm font-bold');
  });
});

describe('formatBytes (binary diff size display)', () => {
  it('renders sub-KB sizes as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KB/MB/GB with one decimal place', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(4300)).toBe('4.2 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('handles invalid input without throwing', () => {
    expect(formatBytes(-5)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});
