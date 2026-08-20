import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceTargetPicker } from '../src/components/comparisons/SourceTargetPicker';
import type { SourceOption } from '../src/lib/adapters/comparisons';

/**
 * Regression coverage for a user-reported bug (the "greyed-out Continue to
 * metadata types button" — comparisons.new.tsx's `canContinue` requires
 * `leftOpt`, so if the Source picker can never accept a value, the wizard
 * can never be started at all). An investigation session reproduced Source
 * failing to accept a selection via coordinate-based browser-automation
 * clicks while Target succeeded, but could not reproduce any asymmetry via
 * real DOM events dispatched at the resolved element (ref-based clicks) —
 * both accept selections identically and reliably.
 *
 * What WAS real, confirmed via the browser console during that
 * investigation: "Select is changing from uncontrolled to controlled" —
 * `leftId`/`rightId` start as `undefined` in `comparisons.new.tsx`'s
 * `useState`, so Radix's `Select` mounted uncontrolled on first render and
 * flipped to controlled the moment a value was picked. That's a real React
 * anti-pattern (the component bootstraps its own internal state before the
 * switch), fixed in `SourceTargetPicker.tsx` by defaulting `value` to `''`
 * so it's controlled from the very first render. This file exercises the
 * ACTUAL `SourceTargetPicker` component with Testing Library's `userEvent`
 * (real DOM events via jsdom) to guard both the original "does Source
 * accept a value" question and the uncontrolled/controlled fix.
 */

const OPTIONS: SourceOption[] = [
  { id: 'org-rca', label: 'RCA DEV', kind: 'org' },
  { id: 'org-arm', label: 'ARM DEV', kind: 'org' },
];

function renderPicker(overrides: Partial<Parameters<typeof SourceTargetPicker>[0]> = {}) {
  const onChangeLeft = vi.fn();
  const onChangeRight = vi.fn();
  const onSwap = vi.fn();
  const utils = render(
    <SourceTargetPicker
      options={OPTIONS}
      leftId={undefined}
      rightId={undefined}
      onChangeLeft={onChangeLeft}
      onChangeRight={onChangeRight}
      onSwap={onSwap}
      {...overrides}
    />,
  );
  return { onChangeLeft, onChangeRight, onSwap, ...utils };
}

describe('SourceTargetPicker (regression: Source must accept a selection exactly like Target)', () => {
  it('selecting an option in Source calls onChangeLeft with that option\'s id', async () => {
    const user = userEvent.setup();
    const { onChangeLeft } = renderPicker();

    const comboboxes = screen.getAllByRole('combobox');
    await user.click(comboboxes[0]!); // Source is the first combobox
    await user.click(await screen.findByRole('option', { name: /RCA DEV/ }));

    expect(onChangeLeft).toHaveBeenCalledWith('org-rca');
  });

  it('selecting an option in Target calls onChangeRight with that option\'s id', async () => {
    const user = userEvent.setup();
    const { onChangeRight } = renderPicker();

    const comboboxes = screen.getAllByRole('combobox');
    await user.click(comboboxes[1]!); // Target is the second combobox
    await user.click(await screen.findByRole('option', { name: /ARM DEV/ }));

    expect(onChangeRight).toHaveBeenCalledWith('org-arm');
  });

  it('Source accepts a selection identically regardless of interaction order (opening Target first must not affect Source)', async () => {
    const user = userEvent.setup();
    const { onChangeLeft, onChangeRight } = renderPicker();

    const comboboxes = screen.getAllByRole('combobox');
    await user.click(comboboxes[1]!);
    await user.click(await screen.findByRole('option', { name: /ARM DEV/ }));
    expect(onChangeRight).toHaveBeenCalledWith('org-arm');

    await user.click(comboboxes[0]!);
    await user.click(await screen.findByRole('option', { name: /RCA DEV/ }));
    expect(onChangeLeft).toHaveBeenCalledWith('org-rca');
  });

  it('renders the committed value once leftId/rightId are set (controlled component round trip)', () => {
    renderPicker({ leftId: 'org-rca', rightId: 'org-arm' });
    expect(screen.getByText('RCA DEV')).toBeInTheDocument();
    expect(screen.getByText('ARM DEV')).toBeInTheDocument();
  });

  it('the swap button calls onSwap without touching either onChange handler', async () => {
    const user = userEvent.setup();
    const { onSwap, onChangeLeft, onChangeRight } = renderPicker({ leftId: 'org-rca', rightId: 'org-arm' });

    await user.click(screen.getByRole('button', { name: 'Swap source and target' }));

    expect(onSwap).toHaveBeenCalledOnce();
    expect(onChangeLeft).not.toHaveBeenCalled();
    expect(onChangeRight).not.toHaveBeenCalled();
  });

  // NOTE: a test asserting no "uncontrolled to controlled" console warning
  // was deliberately NOT added here — verified (by temporarily reverting
  // the `value ?? ''` fix and re-running) that jsdom/Testing Library does
  // NOT reproduce that specific React warning the way a real browser does,
  // so such a test would pass whether or not the fix is present and give
  // false confidence. The warning was confirmed present in a real Chrome
  // console before the fix and absent after, by direct observation — see
  // this PR's description. The behavioral tests above (value round-trips,
  // both pickers accept a selection) are what actually guard this file.
});
