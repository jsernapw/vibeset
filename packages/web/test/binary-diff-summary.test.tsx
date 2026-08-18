import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DiffResult } from '@vibeset/core';
import { BinaryDiffSummary } from '../src/components/diff/BinaryDiffSummary';

const componentContentMock = vi.fn();

vi.mock('@/lib/adapters/comparisons', () => ({
  useComponentContent: (...args: unknown[]) => componentContentMock(...args),
}));

function encoded(bytes: string, metaXml = '<Meta/>') {
  return JSON.stringify({ bodyBase64: btoa(bytes), metaXml });
}

function renderSummary(result: DiffResult) {
  return render(<BinaryDiffSummary result={result} leftLabel="RCA DEV" rightLabel="ARM DEV" comparisonId="cmp-1" />);
}

describe('BinaryDiffSummary', () => {
  it('shows a loading state while the sizing fetch is pending', () => {
    componentContentMock.mockReturnValue({ isPending: true, isError: false, data: undefined, error: null });
    renderSummary({ key: { type: 'StaticResource', fullName: 'Logo' }, status: 'changed', binary: true });
    expect(screen.getByText('Loading binary metadata...')).toBeInTheDocument();
  });

  it('shows an honest error state if the content fetch fails, never a garbage diff', () => {
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: true,
      data: undefined,
      error: { message: 'snapshot not found' },
    });
    renderSummary({ key: { type: 'StaticResource', fullName: 'Logo' }, status: 'changed', binary: true });
    expect(screen.getByText('Could not load binary metadata')).toBeInTheDocument();
    expect(screen.getByText('snapshot not found')).toBeInTheDocument();
  });

  it('reports byte sizes on both sides for a changed binary component', () => {
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: false,
      error: null,
      data: { leftContent: encoded('a'.repeat(4200)), rightContent: encoded('a'.repeat(4800)) },
    });
    renderSummary({
      key: { type: 'StaticResource', fullName: 'Logo' },
      status: 'changed',
      binary: true,
      leftSha256: 'a'.repeat(64),
      rightSha256: 'b'.repeat(64),
    });

    expect(screen.getByText(/Binary file, changed — 4\.1 KB → 4\.7 KB/)).toBeInTheDocument();
    expect(screen.getByText('RCA DEV')).toBeInTheDocument();
    expect(screen.getByText('ARM DEV')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
  });

  it('reports only the right-side size for a new binary component', () => {
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: false,
      error: null,
      data: { leftContent: undefined, rightContent: encoded('x'.repeat(1024)) },
    });
    renderSummary({ key: { type: 'StaticResource', fullName: 'NewZip' }, status: 'new', binary: true, rightSha256: 'c'.repeat(64) });

    expect(screen.getByText(/Binary file, added — 1\.0 KB/)).toBeInTheDocument();
  });

  it('reports only the left-side size for a deleted binary component', () => {
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: false,
      error: null,
      data: { leftContent: encoded('y'.repeat(2048)), rightContent: undefined },
    });
    renderSummary({ key: { type: 'Document', fullName: 'OldDoc' }, status: 'deleted', binary: true, leftSha256: 'e'.repeat(64) });

    expect(screen.getByText(/Binary file, removed — 2\.0 KB/)).toBeInTheDocument();
  });

  it('never renders raw byte/base64 content directly into the DOM', () => {
    const rawMarker = 'RAW_BYTES_SHOULD_NOT_APPEAR_LITERALLY';
    componentContentMock.mockReturnValue({
      isPending: false,
      isError: false,
      error: null,
      data: { leftContent: encoded(rawMarker), rightContent: encoded(rawMarker) },
    });
    renderSummary({ key: { type: 'StaticResource', fullName: 'Thing' }, status: 'identical', binary: true });

    expect(screen.queryByText(rawMarker)).not.toBeInTheDocument();
    expect(screen.queryByText(btoa(rawMarker))).not.toBeInTheDocument();
  });
});
