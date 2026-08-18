import { describe, expect, it } from 'vitest';
import { isQuickDeployable, QUICK_DEPLOY_WINDOW_DAYS } from '../../src/deploy/quick-deploy.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

describe('isQuickDeployable', () => {
  it('true for a succeeded validation with a validationId, completed just now', () => {
    expect(
      isQuickDeployable({ checkOnly: true, status: 'succeeded', validationId: 'v1', completedAt: NOW.toISOString() }, NOW),
    ).toBe(true);
  });

  it('true right up to the edge of the 10-day window', () => {
    const completedAt = new Date(NOW.getTime() - QUICK_DEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isQuickDeployable({ checkOnly: true, status: 'succeeded', validationId: 'v1', completedAt }, NOW)).toBe(true);
  });

  it('false once past the 10-day window', () => {
    const completedAt = new Date(NOW.getTime() - (QUICK_DEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000 + 1000)).toISOString();
    expect(isQuickDeployable({ checkOnly: true, status: 'succeeded', validationId: 'v1', completedAt }, NOW)).toBe(false);
  });

  it('false when it was not a validation (checkOnly: false — a real deploy has nothing to "quick deploy")', () => {
    expect(
      isQuickDeployable({ checkOnly: false, status: 'succeeded', validationId: 'v1', completedAt: NOW.toISOString() }, NOW),
    ).toBe(false);
  });

  it('false when the validation failed', () => {
    expect(
      isQuickDeployable({ checkOnly: true, status: 'failed', validationId: 'v1', completedAt: NOW.toISOString() }, NOW),
    ).toBe(false);
  });

  it('false when there is no recorded validationId', () => {
    expect(isQuickDeployable({ checkOnly: true, status: 'succeeded', completedAt: NOW.toISOString() }, NOW)).toBe(false);
  });

  it('false when completedAt is missing (still in progress, or never recorded)', () => {
    expect(isQuickDeployable({ checkOnly: true, status: 'succeeded', validationId: 'v1' }, NOW)).toBe(false);
  });

  it('false for a completedAt in the future (clock skew / bad data) rather than reporting eligible', () => {
    const completedAt = new Date(NOW.getTime() + 60_000).toISOString();
    expect(isQuickDeployable({ checkOnly: true, status: 'succeeded', validationId: 'v1', completedAt }, NOW)).toBe(false);
  });
});
