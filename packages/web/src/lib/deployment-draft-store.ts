import { create } from 'zustand';
import type { ComponentKey } from '@vibeset/core';

interface DeploymentDraftState {
  comparisonId?: string;
  sourceLabel?: string;
  targetLabel?: string;
  components: ComponentKey[];
  destructiveComponents: ComponentKey[];
  setDraft: (draft: {
    comparisonId?: string;
    sourceLabel?: string;
    targetLabel?: string;
    components: ComponentKey[];
    destructiveComponents: ComponentKey[];
  }) => void;
  clear: () => void;
}

/**
 * Carries the selected components from a comparison's results tree over to
 * the deployment review screen. A plain Zustand store rather than router
 * search params because a real selection can be thousands of `ComponentKey`s
 * — too large to round-trip through a URL.
 */
export const useDeploymentDraftStore = create<DeploymentDraftState>((set) => ({
  components: [],
  destructiveComponents: [],
  setDraft: (draft) => set(draft),
  clear: () => set({ comparisonId: undefined, sourceLabel: undefined, targetLabel: undefined, components: [], destructiveComponents: [] }),
}));
