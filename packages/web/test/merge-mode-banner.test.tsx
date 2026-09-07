import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeModeBanner } from '../src/components/merge/MergeModeBanner';

describe('MergeModeBanner', () => {
  it('two-way mode renders the warning tone and states there is no common ancestor', () => {
    render(
      <MergeModeBanner mode="two-way" gitRefOptions={[]} selectedBaseId={undefined} onSelectBase={vi.fn()} />,
    );
    const banner = screen.getByTestId('merge-mode-banner');
    expect(banner.dataset.mode).toBe('two-way');
    expect(screen.getByText(/two-way merge/i)).toBeInTheDocument();
    expect(screen.getByText(/no shared history/i)).toBeInTheDocument();
  });

  it('three-way mode renders the info tone and names the base', () => {
    render(
      <MergeModeBanner mode="three-way" baseLabel="Release branch" gitRefOptions={[]} selectedBaseId="conn-1" onSelectBase={vi.fn()} />,
    );
    const banner = screen.getByTestId('merge-mode-banner');
    expect(banner.dataset.mode).toBe('three-way');
    expect(screen.getByText(/Release branch/)).toBeInTheDocument();
  });

  it('lists every git-ref connection option in the base picker', async () => {
    const user = userEvent.setup();
    render(
      <MergeModeBanner
        mode="two-way"
        gitRefOptions={[{ id: 'g1', label: 'main @ origin' }, { id: 'g2', label: 'release-42' }]}
        selectedBaseId={undefined}
        onSelectBase={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'main @ origin' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'release-42' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'None (two-way)' })).toBeInTheDocument();
  });

  it('choosing a base connection calls onSelectBase with its id', async () => {
    const user = userEvent.setup();
    const onSelectBase = vi.fn();
    render(
      <MergeModeBanner
        mode="two-way"
        gitRefOptions={[{ id: 'g1', label: 'main @ origin' }]}
        selectedBaseId={undefined}
        onSelectBase={onSelectBase}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'main @ origin' }));
    expect(onSelectBase).toHaveBeenCalledWith('g1');
  });

  it('choosing "None (two-way)" calls onSelectBase with undefined', async () => {
    const user = userEvent.setup();
    const onSelectBase = vi.fn();
    render(
      <MergeModeBanner
        mode="three-way"
        gitRefOptions={[{ id: 'g1', label: 'main @ origin' }]}
        selectedBaseId="g1"
        onSelectBase={onSelectBase}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'None (two-way)' }));
    expect(onSelectBase).toHaveBeenCalledWith(undefined);
  });
});
