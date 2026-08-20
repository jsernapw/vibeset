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
 * strong evidence the coordinate-based repro was a browser-automation
 * coordinate-space artifact (screenshot-pixel-space vs actual viewport
 * scale), not a code-level defect. This test exercises the ACTUAL
 * `SourceTargetPicker` component with Testing Library's `userEvent`
 * (real DOM events via jsdom, no screen-coordinate guessing involved) to
 * settle it definitively and guard against a real regression either way.
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
});
