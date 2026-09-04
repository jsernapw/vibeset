import { useCallback } from 'react';
import type { TypeFilter } from '@vibeset/core';
import { trpc } from '@/lib/trpc';

/**
 * Adapter boundary for saved filter sets — backed by `packages/server`'s
 * real `filters` tRPC router (`filters.list`/`get`/`save`/`delete`), which
 * persists to `.vibeset/filter-sets/<id>.yml` (see `@vibeset/core`'s
 * `sources/filter-set.ts`). This REPLACES `lib/filter-sets.ts`, a
 * `localStorage`-only implementation that was never connected to the
 * router: a filter set saved there was invisible to the CLI (and to this
 * browser after clearing site data), and vice versa. There is now exactly
 * one store — server-side, shared by every UI surface and the CLI.
 */
export interface SavedFilterSet {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly filter: TypeFilter;
}

/** Every saved filter set, newest `updatedAt` first (already sorted server-side by `filters.list`). */
export function useFilterSets() {
  const query = trpc.filters.list.useQuery();
  return {
    data: (query.data ?? []) as SavedFilterSet[],
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface SaveFilterSetInput {
  /** Omit to create a new filter set; pass an existing id to update it in place. */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly filter: TypeFilter;
}

/** Create-or-update a filter set. Invalidates `filters.list` on success so every open list (wizard dropdown, the `/filters` management page) picks up the change without a manual refetch. */
export function useSaveFilterSet() {
  const utils = trpc.useUtils();
  const mutation = trpc.filters.save.useMutation({
    onSuccess: () => utils.filters.list.invalidate(),
  });
  const save = useCallback((input: SaveFilterSetInput) => mutation.mutateAsync(input), [mutation]);
  return { save, isSaving: mutation.isPending, error: mutation.error };
}

export function useDeleteFilterSet() {
  const utils = trpc.useUtils();
  const mutation = trpc.filters.delete.useMutation({
    onSuccess: () => utils.filters.list.invalidate(),
  });
  const remove = useCallback((id: string) => mutation.mutateAsync({ id }), [mutation]);
  return { remove, isDeleting: mutation.isPending, error: mutation.error };
}
