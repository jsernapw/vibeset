/**
 * Pure step-gating logic for the comparison -> deploy wizard, kept free of
 * React/router so it's trivial to unit test. `ComparisonStepper` renders
 * whatever this returns; each route computes its own `WizardContext` from
 * whatever it actually knows (URL params for `comparisonId`/`deploymentId`,
 * the flow store for whether sources are committed).
 */

export type WizardStepKey = 'sources' | 'types' | 'review' | 'deploy' | 'result';

export interface WizardTarget {
  /** A route path registered in router.tsx. */
  to: string;
  params?: Record<string, string>;
}

export interface WizardStepInfo {
  key: WizardStepKey;
  label: string;
  target: WizardTarget | null;
  /** Whether this step can be navigated to right now (vs. shown but grayed out). */
  reachable: boolean;
}

export interface WizardContext {
  /** True once a valid, distinct source+target pair has been committed (not just an in-progress edit). */
  sourcesReady: boolean;
  /** The comparison currently being reviewed/deployed, if any. */
  comparisonId?: string;
  /** The deployment launched from this flow, if any. */
  deploymentId?: string;
}

const STEP_LABELS: Record<WizardStepKey, string> = {
  sources: 'Choose sources',
  types: 'Select types',
  review: 'Review differences',
  deploy: 'Review & deploy',
  result: 'Result',
};

const STEP_ORDER: WizardStepKey[] = ['sources', 'types', 'review', 'deploy', 'result'];

export function buildWizardSteps(ctx: WizardContext): WizardStepInfo[] {
  return STEP_ORDER.map((key): WizardStepInfo => {
    switch (key) {
      case 'sources':
        return { key, label: STEP_LABELS[key], target: { to: '/comparisons/new' }, reachable: true };
      case 'types':
        return {
          key,
          label: STEP_LABELS[key],
          target: ctx.sourcesReady ? { to: '/comparisons/new/types' } : null,
          reachable: ctx.sourcesReady,
        };
      case 'review':
        return {
          key,
          label: STEP_LABELS[key],
          target: ctx.comparisonId ? { to: '/comparisons/$comparisonId', params: { comparisonId: ctx.comparisonId } } : null,
          reachable: !!ctx.comparisonId,
        };
      case 'deploy':
        return {
          key,
          label: STEP_LABELS[key],
          target: ctx.comparisonId
            ? { to: '/comparisons/$comparisonId/deploy', params: { comparisonId: ctx.comparisonId } }
            : null,
          reachable: !!ctx.comparisonId,
        };
      case 'result':
        return {
          key,
          label: STEP_LABELS[key],
          target: ctx.deploymentId ? { to: '/deployments/$deploymentId', params: { deploymentId: ctx.deploymentId } } : null,
          reachable: !!ctx.deploymentId,
        };
    }
  });
}

export function stepIndex(key: WizardStepKey): number {
  return STEP_ORDER.indexOf(key);
}
