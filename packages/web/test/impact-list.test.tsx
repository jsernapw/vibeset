import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { ImpactList } from '../src/components/dependencies/ImpactList';
import type { ImpactNodeLike } from '../src/lib/dependency-graph';

function node(overrides: Partial<ImpactNodeLike> = {}): ImpactNodeLike {
  return {
    key: { type: 'ApexClass', fullName: 'BarHelper' },
    depth: 1,
    viaEdge: {
      fromType: 'ApexClass',
      fromFullName: 'FooService',
      toType: 'ApexClass',
      toFullName: 'BarHelper',
      provenance: 'org',
    },
    ...overrides,
  };
}

function renderList(overrides: Partial<Parameters<typeof ImpactList>[0]> = {}) {
  const onFocus = vi.fn();
  const utils = render(
    <TooltipProvider>
      <ImpactList nodes={[node()]} direction="forward" truncatedCount={0} onFocus={onFocus} {...overrides} />
    </TooltipProvider>,
  );
  return { onFocus, ...utils };
}

describe('ImpactList', () => {
  it('shows an honest "no recorded edge" empty state for forward, distinct from a false "confirmed none"', () => {
    renderList({ nodes: [] });
    expect(screen.getByText('Depends on nothing recorded')).toBeInTheDocument();
    expect(screen.getByText(/not a confirmed/)).toBeInTheDocument();
  });

  it('the reverse empty state explicitly warns this is not confirmation it is safe to delete', () => {
    renderList({ nodes: [], direction: 'reverse' });
    expect(screen.getByText('Nothing recorded depends on this')).toBeInTheDocument();
    expect(screen.getByText(/NOT confirmation it is safe to delete/)).toBeInTheDocument();
  });

  it('renders the component type, full name, depth and provenance for each row', () => {
    renderList();
    expect(screen.getByText('ApexClass')).toBeInTheDocument();
    expect(screen.getByText('BarHelper')).toBeInTheDocument();
    expect(screen.getByText('1 hop')).toBeInTheDocument();
    expect(screen.getByText('Org')).toBeInTheDocument();
  });

  it('labels a supplemented edge distinctly from an org edge', () => {
    renderList({ nodes: [node({ viaEdge: { ...node().viaEdge, provenance: 'supplemented', supplementKind: 'layout-field-reference' } })] });
    expect(screen.getByText('Supplemented')).toBeInTheDocument();
    expect(screen.queryByText('Org')).not.toBeInTheDocument();
  });

  it('clicking a row\'s focus control calls onFocus with that node\'s key', async () => {
    const user = userEvent.setup();
    const { onFocus } = renderList();

    await user.click(screen.getByRole('button', { name: 'Focus on BarHelper' }));

    expect(onFocus).toHaveBeenCalledWith({ type: 'ApexClass', fullName: 'BarHelper' });
  });

  it('shows the truncated-count message when more nodes exist than are rendered', () => {
    renderList({ truncatedCount: 42 });
    expect(screen.getByText(/42 more not shown/)).toBeInTheDocument();
  });

  it('flags managed-package involvement when either endpoint carries a namespace', () => {
    renderList({ nodes: [node({ viaEdge: { ...node().viaEdge, fromNamespace: 'omnistudio' } })] });
    expect(screen.getByText('managed pkg')).toBeInTheDocument();
  });
});
