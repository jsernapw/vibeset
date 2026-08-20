/**
 * Pure derivation behind the "Choose sources" step's disabled-Continue
 * explanation (`routes/comparisons.new.tsx`). Extracted so the exact
 * messaging is unit-testable without a router/DOM harness — a disabled
 * button with no explanation is the "greyed-out Continue" symptom recorded
 * in the Phase 2 plan's known debt, so every disabled state here must say
 * why.
 */
export function resolveContinueHint(params: {
  readonly hasSource: boolean;
  readonly hasTarget: boolean;
  readonly sameNonEmpty: boolean;
}): string | undefined {
  const { hasSource, hasTarget, sameNonEmpty } = params;
  if (sameNonEmpty) return 'Source and target must be different.';
  if (!hasSource && !hasTarget) return 'Choose a source and a target to continue.';
  if (!hasSource) return 'Choose a source to continue.';
  if (!hasTarget) return 'Choose a target to continue.';
  return undefined;
}
