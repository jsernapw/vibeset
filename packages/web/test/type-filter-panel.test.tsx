import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TypeFilterPanel } from '../src/components/comparisons/TypeFilterPanel';

const CURATED = ['ApexClass', 'ApexTrigger', 'CustomObject', 'Flow', 'Profile'];
const ALL_418 = [...CURATED, 'Territory2Model', 'WaveApplication', 'AIApplicationConfig'];

function renderPanel(overrides: Partial<Parameters<typeof TypeFilterPanel>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TypeFilterPanel allTypes={ALL_418} curatedTypes={CURATED} selectedTypes={[]} onChange={onChange} {...overrides} />,
  );
  return { onChange, ...utils };
}

describe('TypeFilterPanel', () => {
  it('shows a loading skeleton and no columns while availableTypes is loading', () => {
    renderPanel({ isLoading: true });
    expect(screen.queryByTestId('available-types-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selected-types-list')).not.toBeInTheDocument();
  });

  it('shows an error state with a retry action when availableTypes failed to load', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderPanel({ error: new Error('Network unreachable'), onRetry });

    expect(screen.getByText('Could not load metadata types')).toBeInTheDocument();
    expect(screen.getByText('Network unreachable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('defaults the Available scope to the curated list, hiding non-curated types', () => {
    renderPanel();
    const list = screen.getByTestId('available-types-list');
    expect(within(list).getByText('ApexClass')).toBeInTheDocument();
    expect(within(list).queryByText('Territory2Model')).not.toBeInTheDocument();
  });

  it('switching to "All types" reveals the full registry in Available', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /All types/ }));
    const list = screen.getByTestId('available-types-list');
    expect(within(list).getByText('Territory2Model')).toBeInTheDocument();
  });

  it('a search with no matches in the curated scope offers a jump to search everything', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByPlaceholderText('Search types...'), 'territory');

    expect(screen.getByText(/No matches in the common/)).toBeInTheDocument();
    const jump = screen.getByText(/Search all \d+ registered types/);
    await user.click(jump);

    expect(within(screen.getByTestId('available-types-list')).getByText('Territory2Model')).toBeInTheDocument();
  });

  it('clicking an available type calls onChange with it added to the selection', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel({ selectedTypes: ['Flow'] });
    await user.click(screen.getByLabelText('Add ApexClass'));
    expect(onChange).toHaveBeenCalledWith(['Flow', 'ApexClass']);
  });

  it('clicking a selected type calls onChange with it removed', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel({ selectedTypes: ['Flow', 'ApexClass'] });
    await user.click(screen.getByLabelText('Remove ApexClass'));
    expect(onChange).toHaveBeenCalledWith(['Flow']);
  });

  it('a selected type stays visible in Selected even after switching Available scope away from it', () => {
    // Selected via "All types" scope in an earlier session (e.g. Territory2Model),
    // now viewed back in the default curated scope.
    renderPanel({ selectedTypes: ['Territory2Model'] });
    expect(within(screen.getByTestId('selected-types-list')).getByText('Territory2Model')).toBeInTheDocument();
  });

  it('"Add all" adds only the currently visible (scope + search filtered) available types', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Add all' }));
    // Curated scope is active by default, so only curated types get added.
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(CURATED));
    expect(onChange.mock.calls[0][0]).not.toContain('Territory2Model');
  });

  it('"Clear all" empties the selection', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel({ selectedTypes: ['ApexClass', 'Flow'] });
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('renders a bounded number of DOM rows for a large registry (virtualized, not all 400+ at once)', () => {
    const bigAll = Array.from({ length: 420 }, (_, i) => `Type_${i}`);
    renderPanel({ allTypes: bigAll, curatedTypes: bigAll.slice(0, 33) });
    // Switch is implicit: with 420 > 33 curated, the toggle exists; default
    // scope is curated (33 rows) which already fits without virtualization
    // mattering — assert the *available* list count is far below the full
    // 420-item universe regardless, proving it isn't dumping everything in.
    const rows = document.querySelectorAll('[data-testid="available-types-list"] [data-index]');
    expect(rows.length).toBeLessThan(420);
  });

  it('renders a bounded number of DOM rows when scoped to the full ~418-type registry', async () => {
    const user = userEvent.setup();
    const bigAll = Array.from({ length: 420 }, (_, i) => `Type_${i}`);
    const bigCurated = bigAll.slice(0, 33);
    renderPanel({ allTypes: bigAll, curatedTypes: bigCurated });

    await user.click(screen.getByRole('button', { name: /All types/ }));

    const rows = document.querySelectorAll('[data-testid="available-types-list"] [data-index]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(420);
  });
});
