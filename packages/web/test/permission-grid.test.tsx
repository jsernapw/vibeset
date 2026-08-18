import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiffEntry } from '@vibeset/core';
import { PermissionGrid } from '../src/components/diff/PermissionGrid';

/**
 * A small but representative decomposed Profile/PermissionSet diff spanning
 * every category the mock generator emits, mirroring the shape produced by
 * `buildPermissionEntries` in `lib/mock/comparison-mock.ts`.
 */
function makeEntries(): DiffEntry[] {
  return [
    {
      path: 'fieldPermissions.Account__c.Name__c',
      key: 'Account__c.Name__c',
      status: 'changed',
      children: [
        { path: 'fieldPermissions.Account__c.Name__c.readable', key: 'readable', status: 'changed', before: true, after: true },
        { path: 'fieldPermissions.Account__c.Name__c.editable', key: 'editable', status: 'changed', before: false, after: true },
      ],
    },
    {
      path: 'fieldPermissions.Contact__c.Email__c',
      key: 'Contact__c.Email__c',
      status: 'identical',
      children: [
        { path: 'fieldPermissions.Contact__c.Email__c.readable', key: 'readable', status: 'identical', before: true, after: true },
        { path: 'fieldPermissions.Contact__c.Email__c.editable', key: 'editable', status: 'identical', before: true, after: true },
      ],
    },
    {
      path: 'objectPermissions.Account__c',
      key: 'Account__c',
      status: 'new',
      children: [
        { path: 'objectPermissions.Account__c.allowRead', key: 'allowRead', status: 'new', after: true },
        { path: 'objectPermissions.Account__c.allowCreate', key: 'allowCreate', status: 'new', after: true },
        { path: 'objectPermissions.Account__c.allowEdit', key: 'allowEdit', status: 'new', after: false },
        { path: 'objectPermissions.Account__c.allowDelete', key: 'allowDelete', status: 'new', after: false },
      ],
    },
    {
      path: 'classAccesses.LeadHandler',
      key: 'LeadHandler',
      status: 'deleted',
      children: [{ path: 'classAccesses.LeadHandler.enabled', key: 'enabled', status: 'deleted', before: true }],
    },
    {
      path: 'userPermissions.ApiEnabled',
      key: 'ApiEnabled',
      status: 'changed',
      children: [{ path: 'userPermissions.ApiEnabled.enabled', key: 'enabled', status: 'changed', before: false, after: true }],
    },
  ];
}

function renderGrid(entries: DiffEntry[] | undefined, overrides: Partial<ComponentProps<typeof PermissionGrid>> = {}) {
  const onToggle = vi.fn();
  const onToggleMany = vi.fn();
  const utils = render(
    <PermissionGrid entries={entries} selected={new Set()} onToggle={onToggle} onToggleMany={onToggleMany} {...overrides} />,
  );
  return { onToggle, onToggleMany, ...utils };
}

describe('PermissionGrid', () => {
  it('renders an empty state when there are no entries at all', () => {
    renderGrid(undefined);
    expect(screen.getByText('No permission entries')).toBeInTheDocument();
    renderGrid([]);
    expect(screen.getAllByText('No permission entries').length).toBeGreaterThan(0);
  });

  it('groups entries into one tab per category, with the entry count in the tab label', () => {
    renderGrid(makeEntries());
    // categories sorted alphabetically by tag: classAccesses, fieldPermissions, objectPermissions, userPermissions
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Class access1', 'Field permissions2', 'Object permissions1', 'User permissions1']);
  });

  it('defaults to the first category and renders rows keyed by the natural key, not array position', () => {
    renderGrid(makeEntries());
    // First category alphabetically is classAccesses -> only "LeadHandler" is visible initially.
    expect(screen.getByText('LeadHandler')).toBeInTheDocument();
    expect(screen.queryByText('Account__c.Name__c')).not.toBeInTheDocument();
  });

  it('renders each row status as a badge with the entry status text', () => {
    renderGrid(makeEntries());
    const row = screen.getByText('LeadHandler').closest('tr')!;
    expect(within(row).getByText('deleted')).toBeInTheDocument();
  });

  it('switches the visible rows when a different category tab is activated', async () => {
    const user = userEvent.setup();
    renderGrid(makeEntries());
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    expect(screen.getByText('Account__c.Name__c')).toBeInTheDocument();
    expect(screen.getByText('Contact__c.Email__c')).toBeInTheDocument();
    // Column headers come from the children's natural keys (readable/editable), not a hardcoded list.
    expect(screen.getByRole('columnheader', { name: 'readable' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'editable' })).toBeInTheDocument();
  });

  it('filters the active category by case-insensitive substring search', async () => {
    const user = userEvent.setup();
    renderGrid(makeEntries());
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    await user.type(screen.getByPlaceholderText('Search by name...'), 'contact');
    expect(screen.getByText('Contact__c.Email__c')).toBeInTheDocument();
    expect(screen.queryByText('Account__c.Name__c')).not.toBeInTheDocument();
  });

  it('shows the "no entries match" fallback row when filters exclude everything', async () => {
    const user = userEvent.setup();
    renderGrid(makeEntries());
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    await user.type(screen.getByPlaceholderText('Search by name...'), 'nothing-matches-this');
    expect(screen.getByText('No entries match the current filters.')).toBeInTheDocument();
  });

  it('filters by status within the active category', async () => {
    const user = userEvent.setup();
    renderGrid(makeEntries());
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    await user.click(screen.getByRole('button', { name: 'identical' }));
    expect(screen.getByText('Contact__c.Email__c')).toBeInTheDocument();
    expect(screen.queryByText('Account__c.Name__c')).not.toBeInTheDocument();
  });

  it('toggling a row checkbox calls onToggle with that entry\'s path', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderGrid(makeEntries());
    await user.click(screen.getByRole('checkbox', { name: 'Select LeadHandler' }));
    expect(onToggle).toHaveBeenCalledWith('classAccesses.LeadHandler');
  });

  it('the select-all checkbox calls onToggleMany with every currently visible row path', async () => {
    const user = userEvent.setup();
    const { onToggleMany } = renderGrid(makeEntries());
    await user.click(screen.getByRole('tab', { name: /Field permissions/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Select all visible rows' }));
    expect(onToggleMany).toHaveBeenCalledWith(
      ['fieldPermissions.Account__c.Name__c', 'fieldPermissions.Contact__c.Email__c'],
      true,
    );
  });

  it('reflects the `selected` set as checked rows', () => {
    renderGrid(makeEntries(), { selected: new Set(['classAccesses.LeadHandler']) });
    expect(screen.getByRole('checkbox', { name: 'Select LeadHandler' })).toBeChecked();
  });
});
