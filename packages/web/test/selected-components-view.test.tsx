import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiffResult } from '@vibeset/core';
import { SelectedComponentsView } from '../src/components/comparisons/SelectedComponentsView';
import { componentKeyToString, useSelectionStore } from '../src/lib/selection-store';

function makeResults(): DiffResult[] {
  return [
    { key: { type: 'ApexClass', fullName: 'FooService' }, status: 'changed' },
    { key: { type: 'ApexClass', fullName: 'BarHandler' }, status: 'new' },
    { key: { type: 'Flow', fullName: 'Onboarding_Flow' }, status: 'deleted' },
  ];
}

describe('SelectedComponentsView (cross-type "what am I about to deploy?" screen)', () => {
  beforeEach(() => {
    useSelectionStore.setState({ selected: new Set(), activeComparisonId: null });
  });

  it('shows an empty state when nothing is selected yet', () => {
    render(<SelectedComponentsView results={makeResults()} />);
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('lists every selected component across types, grouped by type by default', () => {
    const results = makeResults();
    useSelectionStore.getState().replaceAll(results.map((r) => componentKeyToString(r.key)));
    render(<SelectedComponentsView results={results} />);

    // "ApexClass"/"Flow" appear both as the group header and as the
    // per-row type badge, so assert on the group headers' member counts
    // instead of an exact (ambiguous) text match.
    expect(screen.getAllByText('ApexClass').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Flow').length).toBeGreaterThan(0);
    expect(screen.getByText('FooService')).toBeInTheDocument();
    expect(screen.getByText('BarHandler')).toBeInTheDocument();
    expect(screen.getByText('Onboarding_Flow')).toBeInTheDocument();
  });

  it('deselecting a row via its remove control removes it from the shared selection store', async () => {
    const user = userEvent.setup();
    const results = makeResults();
    useSelectionStore.getState().replaceAll(results.map((r) => componentKeyToString(r.key)));
    render(<SelectedComponentsView results={results} />);

    await user.click(screen.getByRole('button', { name: 'Deselect FooService' }));

    expect(useSelectionStore.getState().selected.has('ApexClass::FooService')).toBe(false);
    expect(useSelectionStore.getState().selected.has('ApexClass::BarHandler')).toBe(true);
  });

  it('"Remove all" on a group header deselects every component in that type', async () => {
    const user = userEvent.setup();
    const results = makeResults();
    useSelectionStore.getState().replaceAll(results.map((r) => componentKeyToString(r.key)));
    render(<SelectedComponentsView results={results} />);

    // Groups are sorted alphabetically, so the first "Remove all" is ApexClass's.
    const [removeApexGroup] = screen.getAllByRole('button', { name: 'Remove all' });
    await user.click(removeApexGroup!);

    expect(useSelectionStore.getState().selected.has('ApexClass::FooService')).toBe(false);
    expect(useSelectionStore.getState().selected.has('ApexClass::BarHandler')).toBe(false);
    expect(useSelectionStore.getState().selected.has('Flow::Onboarding_Flow')).toBe(true);
  });

  it('search narrows the list by name or type, case-insensitively', async () => {
    const user = userEvent.setup();
    const results = makeResults();
    useSelectionStore.getState().replaceAll(results.map((r) => componentKeyToString(r.key)));
    render(<SelectedComponentsView results={results} />);

    await user.type(screen.getByPlaceholderText('Search selected components...'), 'onboarding');

    expect(screen.getByText('Onboarding_Flow')).toBeInTheDocument();
    expect(screen.queryByText('FooService')).not.toBeInTheDocument();
  });

  it('switching to "Flat list" removes the type group headers (no more "Remove all" group controls)', async () => {
    const user = userEvent.setup();
    const results = makeResults();
    useSelectionStore.getState().replaceAll(results.map((r) => componentKeyToString(r.key)));
    render(<SelectedComponentsView results={results} />);

    expect(screen.getAllByRole('button', { name: 'Remove all' }).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Flat list' }));

    expect(screen.queryByRole('button', { name: 'Remove all' })).not.toBeInTheDocument();
    expect(screen.getByText('FooService')).toBeInTheDocument();
  });
});
