import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stepIndex, type WizardStepInfo, type WizardStepKey } from '@/lib/wizard-steps';

/**
 * The step indicator for the comparison -> deploy journey (Choose sources ->
 * Select types -> Review differences -> Review & deploy -> Result). Steps
 * with a target are real `Link`s so completed steps stay revisitable and
 * the whole thing is keyboard-navigable; steps without a target (not
 * reached yet) render as inert, dimmed text.
 *
 * `target.to` is a route path built dynamically from `wizard-steps.ts`
 * (constant strings, but not literal at the call site), so it doesn't line
 * up with `Link`'s literal route-union typing — the cast below is the one
 * deliberately-loose spot in an otherwise fully-typed router setup.
 */
export function ComparisonStepper({
  current,
  steps,
  selectedCount,
}: {
  current: WizardStepKey;
  steps: WizardStepInfo[];
  selectedCount?: number;
}) {
  const currentIndex = stepIndex(current);

  return (
    <nav
      aria-label="Comparison progress"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900/40"
    >
      <ol className="flex flex-1 flex-wrap items-center gap-x-1 gap-y-1.5">
        {steps.map((step, i) => {
          const isCurrent = step.key === current;
          const isDone = i < currentIndex && step.reachable;
          const clickable = !!step.target && step.reachable && !isCurrent;

          const badge = (
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                isCurrent
                  ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                  : isDone
                    ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                    : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
              )}
            >
              {isDone ? <Check className="h-3 w-3" /> : i + 1}
            </span>
          );
          const label = (
            <span
              className={cn(
                'whitespace-nowrap',
                isCurrent ? 'font-semibold text-neutral-900 dark:text-neutral-50' : 'text-neutral-500 dark:text-neutral-400',
              )}
            >
              {step.label}
            </span>
          );

          return (
            <li key={step.key} className="flex items-center gap-1">
              {clickable ? (
                <Link
                  to={step.target!.to as never}
                  params={step.target!.params as never}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  {badge}
                  {label}
                </Link>
              ) : (
                <span
                  className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-1', !step.reachable && 'opacity-40')}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {badge}
                  {label}
                </span>
              )}
              {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-4 shrink-0 bg-neutral-300 dark:bg-neutral-700" />}
            </li>
          );
        })}
      </ol>
      {typeof selectedCount === 'number' && (
        <span
          data-testid="wizard-selected-count"
          className="shrink-0 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
        >
          {selectedCount.toLocaleString()} component{selectedCount === 1 ? '' : 's'} selected
        </span>
      )}
    </nav>
  );
}
