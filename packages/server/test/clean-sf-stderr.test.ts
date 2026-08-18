import { describe, expect, it } from 'vitest';
import { cleanSfStderr } from '../src/trpc/routers/connections.js';

const ESC = '';

describe('cleanSfStderr', () => {
  it('strips ANSI colour codes', () => {
    const raw = `${ESC}[33mSomething broke${ESC}[39m`;
    expect(cleanSfStderr(raw)).toBe('Something broke');
  });

  it('drops the unrelated "update available" advisory so the real error surfaces', () => {
    // Exactly the shape observed from the real CLI: the advisory comes first
    // and would otherwise be all the user sees in the UI.
    const raw =
      `${ESC}[33m›${ESC}[39m   Warning: @salesforce/cli update available from ${ESC}[92m2.111.7${ESC}[39m to ${ESC}[92m2.147.7${ESC}[39m.\n` +
      'Error: User canceled the OAuth flow.';
    expect(cleanSfStderr(raw)).toBe('Error: User canceled the OAuth flow.');
  });

  it('strips the CLI\'s leading "›" bullet', () => {
    expect(cleanSfStderr('  ›   Error: no browser available')).toBe('Error: no browser available');
  });

  it('returns an empty string when nothing but advisories remain, so callers can fall back', () => {
    const raw = `${ESC}[33m›${ESC}[39m   Warning: @salesforce/cli update available from 1 to 2.\n\n`;
    expect(cleanSfStderr(raw)).toBe('');
  });

  it('preserves multi-line error detail', () => {
    expect(cleanSfStderr('Error: bad thing\n  at step two')).toBe('Error: bad thing\n  at step two');
  });

  it('does not eat text that merely looks like a colour code', () => {
    // A bare /\[[0-9;]*m/ (no ESC) would destroy this legitimate content.
    expect(cleanSfStderr('Deploy failed on [30m]Object')).toBe('Deploy failed on [30m]Object');
  });
});
