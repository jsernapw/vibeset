import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DiffResult } from '@vibeset/core';
import { DiffViewer } from '../src/components/diff/DiffViewer';

const componentContentMock = vi.fn();

vi.mock('@/lib/adapters/comparisons', () => ({
  useComponentContent: (...args: unknown[]) => componentContentMock(...args),
}));

function pendingContent() {
  return { isPending: true, isError: false, data: undefined, error: null };
}

describe('DiffViewer binary routing (result.binary must win before permission-grid/text-diff/tree checks)', () => {
  it('routes a binary result to BinaryDiffSummary even when the type name would otherwise be a permission-grid type', () => {
    componentContentMock.mockReturnValue(pendingContent());
    const result: DiffResult = {
      key: { type: 'Profile', fullName: 'Weird_Binary_Profile' },
      status: 'changed',
      binary: true,
      leftSha256: 'a'.repeat(64),
      rightSha256: 'b'.repeat(64),
    };
    render(<DiffViewer result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);

    // BinaryDiffSummary's own loading state (it does its own content fetch for sizing).
    expect(screen.getByText('Loading binary metadata...')).toBeInTheDocument();
    // Must NOT have taken the permission-grid path.
    expect(screen.queryByText('No permission entries')).not.toBeInTheDocument();
  });

  it('routes a binary result to BinaryDiffSummary even when the type name would otherwise be a text-diff type', () => {
    componentContentMock.mockReturnValue(pendingContent());
    const result: DiffResult = {
      key: { type: 'ApexClass', fullName: 'Weird_Binary_Class' },
      status: 'new',
      binary: true,
      rightSha256: 'c'.repeat(64),
    };
    render(<DiffViewer result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);

    expect(screen.getByText('Loading binary metadata...')).toBeInTheDocument();
  });

  it('a genuine StaticResource binary result renders the binary summary, not the semantic tree', () => {
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: false,
      error: null,
      data: { leftContent: undefined, rightContent: JSON.stringify({ bodyBase64: btoa('hello world'), metaXml: '<Meta/>' }) },
    });
    const result: DiffResult = {
      key: { type: 'StaticResource', fullName: 'MyZip' },
      status: 'new',
      rightSha256: 'd'.repeat(64),
      binary: true,
    };
    render(<DiffViewer result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);

    expect(screen.getByText(/Binary file, added/)).toBeInTheDocument();
    expect(screen.queryByText('No structural changes')).not.toBeInTheDocument();
  });

  it('a non-binary result (binary undefined) still falls through to the semantic tree for a generic XML type', () => {
    componentContentMock.mockReturnValue(pendingContent());
    const result: DiffResult = {
      key: { type: 'CustomObject', fullName: 'My_Object__c' },
      status: 'identical',
    };
    render(<DiffViewer result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);

    expect(screen.getByText('No structural changes')).toBeInTheDocument();
  });

  it('a non-binary Profile result still routes to the permission grid', () => {
    componentContentMock.mockReturnValue(pendingContent());
    const result: DiffResult = {
      key: { type: 'Profile', fullName: 'Standard_User' },
      status: 'identical',
    };
    render(<DiffViewer result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);

    expect(screen.getByText('No permission entries')).toBeInTheDocument();
  });

  it('renders the "no component selected" empty state when result is undefined', () => {
    componentContentMock.mockReturnValue(pendingContent());
    render(<DiffViewer result={undefined} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);
    expect(screen.getByText('No component selected')).toBeInTheDocument();
  });
});
