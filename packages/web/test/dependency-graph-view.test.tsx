import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DependencyGraphView } from '../src/components/dependencies/DependencyGraphView';
import type { GraphModel } from '../src/lib/dependency-graph';

const FOCUS_ONLY: GraphModel = {
  nodes: [{ id: 'ApexClass#Foo', key: { type: 'ApexClass', fullName: 'Foo' }, role: 'focus', depth: 0 }],
  edges: [],
  truncatedForward: 0,
  truncatedReverse: 0,
  totalDiscoveredForward: 0,
  totalDiscoveredReverse: 0,
};

const WITH_NEIGHBOR: GraphModel = {
  nodes: [
    { id: 'ApexClass#Foo', key: { type: 'ApexClass', fullName: 'Foo' }, role: 'focus', depth: 0 },
    { id: 'ApexClass#Bar', key: { type: 'ApexClass', fullName: 'Bar' }, role: 'forward', depth: 1 },
  ],
  edges: [{ id: 'e1', source: 'ApexClass#Foo', target: 'ApexClass#Bar', provenance: 'org', discoveredVia: 'forward' }],
  truncatedForward: 0,
  truncatedReverse: 0,
  totalDiscoveredForward: 1,
  totalDiscoveredReverse: 0,
};

describe('DependencyGraphView', () => {
  it('shows a "no recorded edges" placeholder for a focus-only model instead of rendering an empty canvas', () => {
    render(<DependencyGraphView model={FOCUS_ONLY} onFocus={vi.fn()} />);
    expect(screen.getByText('No recorded edges for this component yet.')).toBeInTheDocument();
  });

  it('renders the legend and both node names when the graph has a neighbor', () => {
    render(<DependencyGraphView model={WITH_NEIGHBOR} onFocus={vi.fn()} />);
    expect(screen.getByText('Legend')).toBeInTheDocument();
    expect(screen.getByText('Foo')).toBeInTheDocument();
    expect(screen.getByText('Bar')).toBeInTheDocument();
  });
});
