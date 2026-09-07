import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MergeEntry } from '@vibeset/core';
import { MergeEntryTable } from '../src/components/merge/MergeEntryTable';

function makeEntries(): MergeEntry[] {
  return [
    { path: 'classAccesses.FooController', key: 'FooController', status: 'conflict', left: { apexClass: 'FooController', enabled: 'false' }, right: { apexClass: 'FooController', enabled: 'true' } },
    { path: 'description', key: 'description', status: 'conflict', left: 'Left edit', right: 'Right edit' },
    { path: 'fieldPermissions.Account.Name', key: 'Account.Name', status: 'take-left', left: { editable: 'true' }, resolved: { editable: 'true' } },
    { path: 'fieldPermissions.Contact.Email', key: 'Contact.Email', status: 'take-right', right: { editable: 'false' }, resolved: { editable: 'false' } },
    { path: 'userPermissions.ApiEnabled', key: 'ApiEnabled', status: 'unchanged', left: { enabled: 'true' }, right: { enabled: 'true' }, resolved: { enabled: 'true' } },
  ];
}

function renderTable(overrides: Partial<React.ComponentProps<typeof MergeEntryTable>> = {}) {
  const onResolve = vi.fn();
  const onClear = vi.fn();
  const utils = render(
    <MergeEntryTable
      entries={makeEntries()}
      mode="two-way"
      resolutions={new Map()}
      onResolve={onResolve}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onResolve, onClear, ...utils };
}

describe('MergeEntryTable', () => {
  it('renders an empty state with no entries at all', () => {
    renderTable({ entries: [] });
    expect(screen.getByText('No merge entries')).toBeInTheDocument();
  });

  it('groups entries into one tab per category, sorted alphabetically, with conflict counts badged', () => {
    renderTable();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Class access11',
      'description11',
      'Field permissions2',
      'User permissions1',
    ]);
  });

  it('defaults to the first category and shows that category\'s rows only', () => {
    renderTable();
    expect(screen.getByText('FooController')).toBeInTheDocument();
    // The "description" entry's own values shouldn't render — "description"
    // itself is a poor probe here since it's also that category's own tab
    // label, present regardless of which tab is active.
    expect(screen.queryByText('Left edit')).not.toBeInTheDocument();
  });

  it('conflict rows show Accept left / Accept right controls; auto-resolved and unchanged rows show a read-only label instead', async () => {
    const user = userEvent.setup();
    renderTable();
    expect(screen.getByRole('button', { name: 'Accept left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept right' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    expect(screen.getByText('auto → left')).toBeInTheDocument();
    expect(screen.getByText('auto → right')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept left' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /User permissions/ }));
    expect(screen.getByText('no change')).toBeInTheDocument();
  });

  it('clicking Accept left/right calls onResolve with the entry path and the chosen side', async () => {
    const user = userEvent.setup();
    const { onResolve } = renderTable();
    await user.click(screen.getByRole('button', { name: 'Accept right' }));
    expect(onResolve).toHaveBeenCalledWith('classAccesses.FooController', 'right');
  });

  it('an already-resolved conflict shows the chosen side and a Clear control instead of the accept buttons', async () => {
    const { onClear } = renderTable({ resolutions: new Map([['classAccesses.FooController', 'left']]) });
    expect(screen.getByText('left')).toBeInTheDocument();
    const clearBtn = screen.getByRole('button', { name: 'Clear resolution for FooController' });
    const user = userEvent.setup();
    await user.click(clearBtn);
    expect(onClear).toHaveBeenCalledWith('classAccesses.FooController');
  });

  it('shows a Base column only in three-way mode', async () => {
    const { rerender } = renderTable({ mode: 'two-way' });
    expect(screen.queryByText('Base')).not.toBeInTheDocument();

    rerender(
      <MergeEntryTable entries={makeEntries()} mode="three-way" resolutions={new Map()} onResolve={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByText('Base')).toBeInTheDocument();
  });

  it('filters the active category by search', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.type(screen.getByPlaceholderText('Search by name...'), 'foocontroller');
    expect(screen.getByText('FooController')).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Search by name...'));
    await user.type(screen.getByPlaceholderText('Search by name...'), 'nothing-matches');
    expect(screen.getByText('No entries match')).toBeInTheDocument();
  });

  it('filters the active category by status', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    await user.click(screen.getByRole('button', { name: 'take-left' }));
    expect(screen.getByText('Account.Name')).toBeInTheDocument();
    expect(screen.queryByText('Contact.Email')).not.toBeInTheDocument();
  });

  it('flags conflict rows without a resolution with a visual attention state', () => {
    renderTable();
    const row = screen.getByText('FooController').closest('[data-testid="merge-entry-row"]');
    expect(row?.className).toContain('bg-red-50');
  });

  it('does not visually flag a conflict row the user has already resolved', () => {
    renderTable({ resolutions: new Map([['classAccesses.FooController', 'left']]) });
    const row = screen.getByText('FooController').closest('[data-testid="merge-entry-row"]');
    expect(row?.className).not.toContain('bg-red-50');
  });
});
