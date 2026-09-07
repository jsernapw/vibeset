import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MergeResult } from '@vibeset/core';
import { MergeResolutionPanel } from '../src/components/merge/MergeResolutionPanel';

const useMergeResolveMock = vi.fn();
const useGitRefConnectionsMock = vi.fn();

vi.mock('@/lib/adapters/merge', () => ({
  useMergeResolve: (...args: unknown[]) => useMergeResolveMock(...args),
  useGitRefConnections: (...args: unknown[]) => useGitRefConnectionsMock(...args),
}));

function pending() {
  return { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
}

function twoWayResult(): MergeResult & { comparisonId: string; diffStatus: string } {
  return {
    comparisonId: 'cmp-1',
    diffStatus: 'changed',
    mode: 'two-way',
    key: { type: 'Profile', fullName: 'Admin' },
    entries: [
      { path: 'description', key: 'description', status: 'conflict', left: 'Left edit', right: 'Right edit' },
      { path: 'classAccesses.FooController', key: 'FooController', status: 'take-left', left: { enabled: 'true' }, resolved: { enabled: 'true' } },
      { path: 'userPermissions.ApiEnabled', key: 'ApiEnabled', status: 'unchanged', resolved: { enabled: 'true' } },
    ],
    summary: { unchanged: 1, 'take-left': 1, 'take-right': 0, conflict: 1 },
  };
}

beforeEach(() => {
  useMergeResolveMock.mockReset();
  useGitRefConnectionsMock.mockReset();
  useGitRefConnectionsMock.mockReturnValue({ options: [], isLoading: false });
});

describe('MergeResolutionPanel', () => {
  // CustomObject was gated here until `content-reader.ts` learned to
  // recompose decomposed children (its `compose` option). Verified against
  // the live orgs before ungating: a real `merge.resolve` on `Account`
  // returned 43 `fields.*` and 5 `listViews.*` entries where it previously
  // saw the object-level shell only. It is now an ordinary mergeable type.
  it('CustomObject is no longer gated and does fire the merge query', () => {
    useGitRefConnectionsMock.mockReturnValue({ options: [], isLoading: false });
    useMergeResolveMock.mockReturnValue(pending());
    render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'CustomObject', fullName: 'My_Object__c' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(screen.queryByText(/not yet supported/i)).not.toBeInTheDocument();
    expect(useMergeResolveMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('shows a loading skeleton while the merge query is pending', () => {
    useMergeResolveMock.mockReturnValue(pending());
    const { container } = render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'Profile', fullName: 'Admin' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(container.querySelector('[data-testid="merge-resolution-panel"]')).not.toBeInTheDocument();
  });

  it('shows an error state when the query fails', () => {
    useMergeResolveMock.mockReturnValue({ data: undefined, isPending: false, isError: true, error: { message: 'no recorded coverage' }, refetch: vi.fn() });
    render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'Profile', fullName: 'Admin' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(screen.getByText('Could not resolve this merge')).toBeInTheDocument();
    expect(screen.getByText('no recorded coverage')).toBeInTheDocument();
  });

  it('renders the mode banner, summary badges, and entry table for a successful two-way result', () => {
    useMergeResolveMock.mockReturnValue({ data: twoWayResult(), isPending: false, isError: false, error: null, refetch: vi.fn() });
    render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'Profile', fullName: 'Admin' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(screen.getByTestId('merge-mode-banner').dataset.mode).toBe('two-way');
    expect(screen.getByText('1 unchanged')).toBeInTheDocument();
    expect(screen.getByText('1 auto → left')).toBeInTheDocument();
    expect(screen.getByText('0 auto → right')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 conflicts need your decision')).toBeInTheDocument();
  });

  it('accepting a conflict updates the open-conflict count in the summary strip', async () => {
    useMergeResolveMock.mockReturnValue({ data: twoWayResult(), isPending: false, isError: false, error: null, refetch: vi.fn() });
    const user = userEvent.setup();
    render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'Profile', fullName: 'Admin' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(screen.getByText('1 of 1 conflicts need your decision')).toBeInTheDocument();
    // The one conflict ("description") isn't in the alphabetically-first
    // category tab ("classAccesses", all auto-resolved) — switch to it first.
    await user.click(screen.getByRole('tab', { name: /description/ }));
    await user.click(screen.getByRole('button', { name: 'Accept left' }));
    expect(screen.getByText('all 1 conflicts resolved')).toBeInTheDocument();
  });

  it('a result with zero conflicts renders the "no conflicts" summary badge', () => {
    const result = twoWayResult();
    const noConflict: typeof result = {
      ...result,
      entries: result.entries.filter((e) => e.status !== 'conflict'),
      summary: { ...result.summary, conflict: 0 },
    };
    useMergeResolveMock.mockReturnValue({ data: noConflict, isPending: false, isError: false, error: null, refetch: vi.fn() });
    render(
      <MergeResolutionPanel comparisonId="cmp-1" resultKey={{ type: 'Profile', fullName: 'Admin' }} leftLabel="Target" rightLabel="Source" />,
    );
    expect(screen.getByText('no conflicts')).toBeInTheDocument();
  });
});
