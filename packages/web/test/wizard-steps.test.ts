import { describe, expect, it } from 'vitest';
import { buildWizardSteps, stepIndex } from '../src/lib/wizard-steps';

describe('buildWizardSteps (step gating)', () => {
  it('with nothing chosen yet, only "Choose sources" is reachable', () => {
    const steps = buildWizardSteps({ sourcesReady: false });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.sources!.reachable).toBe(true);
    expect(byKey.types!.reachable).toBe(false);
    expect(byKey.types!.target).toBeNull();
    expect(byKey.review!.reachable).toBe(false);
    expect(byKey.deploy!.reachable).toBe(false);
    expect(byKey.result!.reachable).toBe(false);
  });

  it('once sources are committed, "Select types" becomes reachable but review/deploy/result stay gated', () => {
    const steps = buildWizardSteps({ sourcesReady: true });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.types!.reachable).toBe(true);
    expect(byKey.types!.target).toEqual({ to: '/comparisons/new/types' });
    expect(byKey.review!.reachable).toBe(false);
    expect(byKey.deploy!.reachable).toBe(false);
  });

  it('once a comparisonId exists, review and deploy both become reachable and link to that comparison', () => {
    const steps = buildWizardSteps({ sourcesReady: true, comparisonId: 'cmp-1' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.review!.reachable).toBe(true);
    expect(byKey.review!.target).toEqual({ to: '/comparisons/$comparisonId', params: { comparisonId: 'cmp-1' } });
    expect(byKey.deploy!.reachable).toBe(true);
    expect(byKey.deploy!.target).toEqual({ to: '/comparisons/$comparisonId/deploy', params: { comparisonId: 'cmp-1' } });
    expect(byKey.result!.reachable).toBe(false);
  });

  it('once a deploymentId exists, the result step becomes reachable', () => {
    const steps = buildWizardSteps({ sourcesReady: true, comparisonId: 'cmp-1', deploymentId: 'dep-1' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.result!.reachable).toBe(true);
    expect(byKey.result!.target).toEqual({ to: '/deployments/$deploymentId', params: { deploymentId: 'dep-1' } });
  });

  it('a comparisonId without sourcesReady still makes review/deploy reachable (deep-link case)', () => {
    // Arriving at a comparison via the "recent comparisons" list, not the wizard.
    const steps = buildWizardSteps({ sourcesReady: false, comparisonId: 'cmp-2' });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.types!.reachable).toBe(false);
    expect(byKey.review!.reachable).toBe(true);
    expect(byKey.deploy!.reachable).toBe(true);
  });

  it('stepIndex orders steps sources < types < review < deploy < result', () => {
    expect(stepIndex('sources')).toBe(0);
    expect(stepIndex('types')).toBe(1);
    expect(stepIndex('review')).toBe(2);
    expect(stepIndex('deploy')).toBe(3);
    expect(stepIndex('result')).toBe(4);
  });
});
