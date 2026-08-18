import { describe, expect, it } from 'vitest';
import { toServerSides } from '@/lib/comparison-direction';

/**
 * Safety-critical. The UI says Source/Target; the server says left/right; they
 * mean OPPOSITE things. If this mapping is ever "simplified" to a straight
 * pass-through, comparisons still run and still look plausible — but the
 * deployment package is built against the wrong org. These assertions exist so
 * that mistake fails a test instead of reaching someone's production org.
 */
describe('toServerSides — wizard Source/Target -> server left/right', () => {
  const sources = {
    sourceId: 'conn-arm-dev',
    sourceLabel: 'ARM DEV',
    targetId: 'conn-rca-dev',
    targetLabel: 'RCA DEV',
  };

  it('maps the user-facing Target onto the server\'s `left` (current state)', () => {
    const sides = toServerSides(sources);
    expect(sides.leftId).toBe('conn-rca-dev');
    expect(sides.leftLabel).toBe('RCA DEV');
  });

  it('maps the user-facing Source onto the server\'s `right` (desired state)', () => {
    const sides = toServerSides(sources);
    expect(sides.rightId).toBe('conn-arm-dev');
    expect(sides.rightLabel).toBe('ARM DEV');
  });

  it('is NOT an identity mapping — the sides must actually cross over', () => {
    const sides = toServerSides(sources);
    expect(sides.leftId).not.toBe(sources.sourceId);
    expect(sides.rightId).not.toBe(sources.targetId);
  });

  it('keeps each id paired with its own label after the swap', () => {
    const sides = toServerSides(sources);
    // A swap that moved ids but not labels would mislabel the whole review
    // screen while still deploying "correctly" — equally confusing.
    expect([sides.leftId, sides.leftLabel]).toEqual(['conn-rca-dev', 'RCA DEV']);
    expect([sides.rightId, sides.rightLabel]).toEqual(['conn-arm-dev', 'ARM DEV']);
  });

  it('round-trips back to the original Source/Target when swapped again', () => {
    const sides = toServerSides(sources);
    const back = toServerSides({
      sourceId: sides.rightId,
      sourceLabel: sides.rightLabel,
      targetId: sides.leftId,
      targetLabel: sides.leftLabel,
    });
    expect(back.rightId).toBe(sources.sourceId);
    expect(back.leftId).toBe(sources.targetId);
  });
});
