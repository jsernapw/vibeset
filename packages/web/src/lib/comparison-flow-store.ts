import { create } from 'zustand';
import type { TestLevel } from '@vibeset/core';
import { defaultScopeFilterFields, type ScopeFilterFields } from './filter-set-utils';

/**
 * Cross-step state for the comparison -> deploy wizard (Choose sources ->
 * Select types -> Review differences -> Review & deploy -> Result).
 *
 * This is deliberately separate from `selection-store.ts` (which holds the
 * potentially 50k+ component selection and needs its own perf story) and
 * from `deployment-draft-store.ts` (kept around only for the legacy
 * standalone `/deployments/new` entry point). This store holds the small,
 * cheap-to-copy bits that need to survive Back/Forward navigation between
 * wizard steps: which sources were chosen, which metadata types, which
 * comparison/deployment the user is currently working through, and the
 * deploy options form.
 *
 * A plain Zustand store (not URL search params) because "which comparison
 * a deployment belongs to" needs to persist across a route that doesn't
 * carry the comparisonId in its own URL in every case, and because it's
 * simpler to reset wholesale via `startOver()`.
 */

export interface DeployOptionsDraft {
  packageName: string;
  checkOnly: boolean;
  testLevel: TestLevel;
  /** Only meaningful for `RunSpecifiedTests`; the Metadata API rejects that level with an empty list. */
  runTests: string[];
}

export function defaultPackageName(): string {
  return `package-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

function defaultDeployOptions(): DeployOptionsDraft {
  return { packageName: defaultPackageName(), checkOnly: true, testLevel: 'RunLocalTests', runTests: [] };
}

interface ComparisonFlowState {
  leftId?: string;
  leftLabel?: string;
  rightId?: string;
  rightLabel?: string;
  selectedTypes: string[];
  /**
   * True once `selectedTypes` has been set at least once for the current
   * wizard pass (whether by the auto-applied curated default or by the
   * user editing the picker). Distinguishes "never touched — the types
   * step should pre-populate the curated default when it loads" from
   * "the user deliberately cleared every type" — both states have an
   * empty `selectedTypes` array, so that alone can't tell them apart. See
   * `routes/comparisons.new.types.tsx`.
   */
  typesInitialized: boolean;
  /**
   * The rest of `TypeFilter` beyond type selection — name patterns,
   * modified-since, and namespace exclusion (`ScopeFiltersPanel`). Kept
   * alongside `selectedTypes` for the same reason: Back/Forward between
   * wizard steps must not silently drop a namespace exclusion the user
   * already dialed in. Always starts from `defaultScopeFilterFields()`
   * (`excludeManagedPackages: true`), matching the visible-by-default
   * product default rather than an empty/unset state.
   */
  scopeFilter: ScopeFilterFields;
  comparisonId?: string;
  deploymentId?: string;
  deployOptions: DeployOptionsDraft;

  setSources: (source: { leftId: string; leftLabel: string; rightId: string; rightLabel: string }) => void;
  setSelectedTypes: (types: string[]) => void;
  setScopeFilter: (scopeFilter: ScopeFilterFields) => void;
  /** Called once a comparison run succeeds (or when a step "claims" an existing comparisonId, e.g. reached via deep link). Resets `deploymentId`, and resets `deployOptions` to a fresh default only if this is actually a different comparison than before — so Back/Forward within the same comparison keeps the deploy form intact. */
  setComparisonId: (id: string) => void;
  setDeploymentId: (id: string) => void;
  setDeployOptions: (partial: Partial<DeployOptionsDraft>) => void;
  /** Full reset — used by "Start new comparison" from the Result step. */
  startOver: () => void;
}

export const useComparisonFlowStore = create<ComparisonFlowState>((set, get) => ({
  selectedTypes: [],
  typesInitialized: false,
  scopeFilter: defaultScopeFilterFields(),
  deployOptions: defaultDeployOptions(),

  setSources: (source) =>
    set({
      ...source,
      // Changing sources invalidates any comparison/deployment run against the old pair.
      comparisonId: undefined,
      deploymentId: undefined,
    }),

  setSelectedTypes: (types) => set({ selectedTypes: types, typesInitialized: true }),

  setScopeFilter: (scopeFilter) => set({ scopeFilter }),

  setComparisonId: (id) =>
    set({
      comparisonId: id,
      deploymentId: undefined,
      deployOptions: get().comparisonId === id ? get().deployOptions : defaultDeployOptions(),
    }),

  setDeploymentId: (id) => set({ deploymentId: id }),

  setDeployOptions: (partial) => set((s) => ({ deployOptions: { ...s.deployOptions, ...partial } })),

  startOver: () =>
    set({
      leftId: undefined,
      leftLabel: undefined,
      rightId: undefined,
      rightLabel: undefined,
      selectedTypes: [],
      typesInitialized: false,
      scopeFilter: defaultScopeFilterFields(),
      comparisonId: undefined,
      deploymentId: undefined,
      deployOptions: defaultDeployOptions(),
    }),
}));
