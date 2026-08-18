import { beforeEach, describe, expect, it } from 'vitest';
import { useComparisonFlowStore } from '../src/lib/comparison-flow-store';

const SOURCES = { leftId: 'org-a', leftLabel: 'Org A', rightId: 'org-b', rightLabel: 'Org B' };

describe('comparison-flow-store (wizard state preserved across Back/Forward)', () => {
  beforeEach(() => {
    useComparisonFlowStore.getState().startOver();
  });

  it('setSources commits the pair and clears any stale comparison/deployment from a previous pair', () => {
    useComparisonFlowStore.getState().setComparisonId('cmp-old');
    useComparisonFlowStore.getState().setDeploymentId('dep-old');
    useComparisonFlowStore.getState().setSources(SOURCES);

    const state = useComparisonFlowStore.getState();
    expect(state.leftId).toBe('org-a');
    expect(state.rightId).toBe('org-b');
    expect(state.comparisonId).toBeUndefined();
    expect(state.deploymentId).toBeUndefined();
  });

  it('setSelectedTypes is preserved across repeated reads (simulating Back then Forward)', () => {
    useComparisonFlowStore.getState().setSelectedTypes(['ApexClass', 'Flow']);
    expect(useComparisonFlowStore.getState().selectedTypes).toEqual(['ApexClass', 'Flow']);
    // Simulate navigating away and back — nothing should reset it implicitly.
    expect(useComparisonFlowStore.getState().selectedTypes).toEqual(['ApexClass', 'Flow']);
  });

  it('typesInitialized starts false, so the types step knows to apply the curated default on first load', () => {
    expect(useComparisonFlowStore.getState().typesInitialized).toBe(false);
  });

  it('setSelectedTypes marks typesInitialized true, even when clearing to an empty selection', () => {
    useComparisonFlowStore.getState().setSelectedTypes(['ApexClass']);
    expect(useComparisonFlowStore.getState().typesInitialized).toBe(true);

    // A deliberate "Clear all" must NOT read as "never touched" — otherwise
    // the default would silently reapply itself on the next visit.
    useComparisonFlowStore.getState().setSelectedTypes([]);
    expect(useComparisonFlowStore.getState().selectedTypes).toEqual([]);
    expect(useComparisonFlowStore.getState().typesInitialized).toBe(true);
  });

  it('setComparisonId resets deployOptions to defaults only when it is actually a different comparison', () => {
    useComparisonFlowStore.getState().setComparisonId('cmp-1');
    useComparisonFlowStore.getState().setDeployOptions({ packageName: 'custom-pkg', checkOnly: false });

    // Re-claiming the SAME comparisonId (e.g. deploy step "claiming" it again) must not wipe the form.
    useComparisonFlowStore.getState().setComparisonId('cmp-1');
    expect(useComparisonFlowStore.getState().deployOptions.packageName).toBe('custom-pkg');
    expect(useComparisonFlowStore.getState().deployOptions.checkOnly).toBe(false);

    // A genuinely different comparison resets to a fresh default.
    useComparisonFlowStore.getState().setComparisonId('cmp-2');
    expect(useComparisonFlowStore.getState().deployOptions.packageName).not.toBe('custom-pkg');
    expect(useComparisonFlowStore.getState().deployOptions.checkOnly).toBe(true);
  });

  it('setComparisonId clears any previous deploymentId (a new comparison invalidates the old result association)', () => {
    useComparisonFlowStore.getState().setComparisonId('cmp-1');
    useComparisonFlowStore.getState().setDeploymentId('dep-1');
    useComparisonFlowStore.getState().setComparisonId('cmp-2');
    expect(useComparisonFlowStore.getState().deploymentId).toBeUndefined();
  });

  it('setDeployOptions merges rather than replaces', () => {
    useComparisonFlowStore.getState().setDeployOptions({ packageName: 'a' });
    useComparisonFlowStore.getState().setDeployOptions({ checkOnly: false });
    const opts = useComparisonFlowStore.getState().deployOptions;
    expect(opts.packageName).toBe('a');
    expect(opts.checkOnly).toBe(false);
    expect(opts.testLevel).toBe('RunLocalTests');
  });

  it('startOver resets every field back to its initial empty state', () => {
    useComparisonFlowStore.getState().setSources(SOURCES);
    useComparisonFlowStore.getState().setSelectedTypes(['ApexClass']);
    useComparisonFlowStore.getState().setComparisonId('cmp-1');
    useComparisonFlowStore.getState().setDeploymentId('dep-1');

    useComparisonFlowStore.getState().startOver();

    const state = useComparisonFlowStore.getState();
    expect(state.leftId).toBeUndefined();
    expect(state.rightId).toBeUndefined();
    expect(state.selectedTypes).toEqual([]);
    expect(state.typesInitialized).toBe(false);
    expect(state.comparisonId).toBeUndefined();
    expect(state.deploymentId).toBeUndefined();
    expect(state.deployOptions.checkOnly).toBe(true);
  });
});
