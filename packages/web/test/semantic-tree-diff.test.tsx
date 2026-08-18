import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiffEntry } from '@vibeset/core';
import { SemanticTreeDiff } from '../src/components/diff/SemanticTreeDiff';

/** A small semantic tree mirroring `buildTreeEntries` output: a top-level field with nested property children. */
function makeEntries(): DiffEntry[] {
  return [
    {
      path: 'fields.Renewal_Date__c',
      key: 'Renewal_Date__c',
      status: 'changed',
      children: [
        { path: 'fields.Renewal_Date__c.required', key: 'required', status: 'changed', before: 'false', after: 'true' },
        { path: 'fields.Renewal_Date__c.label', key: 'label', status: 'identical', before: 'Renewal Date', after: 'Renewal Date' },
      ],
    },
    { path: 'fields.Territory__c', key: 'Territory__c', status: 'new', after: '50' },
    { path: 'fields.Batch__c', key: 'Batch__c', status: 'deleted', before: '12' },
    { path: 'fields.Vendor__c', key: 'Vendor__c', status: 'identical', before: 'active', after: 'active' },
  ];
}

describe('SemanticTreeDiff', () => {
  it('renders an empty state when there are no entries', () => {
    render(<SemanticTreeDiff entries={undefined} />);
    expect(screen.getByText('No structural changes')).toBeInTheDocument();
  });

  it('renders an empty state for an empty entries array too', () => {
    render(<SemanticTreeDiff entries={[]} />);
    expect(screen.getByText('No structural changes')).toBeInTheDocument();
  });

  it('renders one row per top-level entry, keyed by its natural key rather than array index', () => {
    render(<SemanticTreeDiff entries={makeEntries()} />);
    expect(screen.getByText('Renewal_Date__c')).toBeInTheDocument();
    expect(screen.getByText('Territory__c')).toBeInTheDocument();
    expect(screen.getByText('Batch__c')).toBeInTheDocument();
    expect(screen.getByText('Vendor__c')).toBeInTheDocument();
  });

  it('renders each row status as a badge with the entry status text', () => {
    render(<SemanticTreeDiff entries={makeEntries()} />);
    expect(screen.getAllByText('changed').length).toBeGreaterThan(0);
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('deleted')).toBeInTheDocument();
  });

  it('shows before -> after values for a changed leaf entry', () => {
    render(<SemanticTreeDiff entries={makeEntries()} />);
    expect(screen.getByText('50')).toBeInTheDocument(); // new entry shows only the "after" value
    expect(screen.getByText('12')).toBeInTheDocument(); // deleted entry shows only the "before" value
  });

  it('a top-level entry with children starts expanded (depth 0) and reveals its children', () => {
    render(<SemanticTreeDiff entries={makeEntries()} />);
    // depth-0 nodes default open, so nested keys are visible without clicking anything.
    expect(screen.getByText('required')).toBeInTheDocument();
    expect(screen.getByText('label')).toBeInTheDocument();
    expect(screen.getByText('true')).toBeInTheDocument(); // "required" after-value
  });

  it('collapsing a parent hides its children, and expanding it again restores them', async () => {
    const user = userEvent.setup();
    render(<SemanticTreeDiff entries={makeEntries()} />);
    const parentRow = screen.getByText('Renewal_Date__c').closest('div')!;
    const collapseButton = within(parentRow).getByRole('button', { name: 'Collapse' });

    await user.click(collapseButton);
    expect(screen.queryByText('required')).not.toBeInTheDocument();

    await user.click(within(parentRow).getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('renders leaf rows (no children) without an expand/collapse toggle', () => {
    render(<SemanticTreeDiff entries={makeEntries()} />);
    const leafRow = screen.getByText('Territory__c').closest('div')!;
    expect(within(leafRow).queryByRole('button')).not.toBeInTheDocument();
  });
});
