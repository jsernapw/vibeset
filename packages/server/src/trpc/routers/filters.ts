import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  deleteFilterSet,
  filterSetFilePath,
  FILTER_SET_SCHEMA_VERSION,
  listFilterSets,
  loadFilterSet,
  saveFilterSet,
  type FilterSet,
} from '@vibeset/core';
import { vibesetHome } from '../../db/paths.js';
import { publicProcedure, router } from '../trpc.js';
import { OptionalTypeFilterSchema } from './shared/type-filter-schema.js';

/**
 * Phase 2 Workstream C, item 3: `TypeFilter`'s dimensions (`types`,
 * `namePatterns`, `modifiedSince`, `modifiedBy`, `excludeNamespaces`,
 * `excludeManagedPackages`) as first-class, SAVEABLE, named filter sets —
 * reviewable, git-committable YAML under `.vibeset/filter-sets/` (same
 * convention `deploy.ts`/`history.ts` already use for deployment package
 * manifests under `.vibeset/packages/`), exposed here so `@vibeset/web`
 * can list, apply, and manage them without touching the filesystem
 * directly.
 *
 * Deliberately file-backed, not a `connections`/`comparisons`-style SQLite
 * table: the whole point of "reviewable, git-committable YAML" is that a
 * filter set is meant to be inspected, diffed, and optionally checked into
 * version control by a human outside VibeSet, not hidden inside the app's
 * private database. `vibesetHome()` still resolves to `~/.vibeset` (or
 * `VIBESET_HOME` in tests) — the same "home", not a project-local
 * `.vibeset/`, that `manifestFilePath`/`saveManifest` already use.
 */
export const filtersRouter = router({
  /** Every saved filter set, newest `updatedAt` first. */
  list: publicProcedure.query(async () => listFilterSets(vibesetHome())),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    return loadFilterSet(filterSetFilePath(vibesetHome(), input.id));
  }),

  /**
   * Creates a new filter set (no `id` given) or updates an existing one
   * (`id` given — `createdAt` is preserved from the existing file,
   * `updatedAt` bumped to now). Upserts by filename, so saving with an
   * unknown `id` is also accepted as "create with this id" rather than
   * erroring — useful for a client that generated its own id optimistically.
   */
  save: publicProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        filter: OptionalTypeFilterSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const now = new Date().toISOString();
      const home = vibesetHome();

      let createdAt = now;
      const id = input.id ?? nanoid();
      if (input.id) {
        try {
          const existing = await loadFilterSet(filterSetFilePath(home, input.id));
          createdAt = existing.createdAt;
        } catch {
          // No existing file at this id (or it failed to parse) — treat as
          // a fresh create rather than failing the save, same "upsert by
          // filename" posture documented above.
        }
      }

      const filterSet: FilterSet = {
        vibesetFilterSetVersion: FILTER_SET_SCHEMA_VERSION,
        id,
        name: input.name,
        description: input.description,
        createdAt,
        updatedAt: now,
        filter: input.filter ?? {},
      };

      const filePath = await saveFilterSet(home, filterSet);
      return { filterSet, filePath };
    }),

  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await deleteFilterSet(vibesetHome(), input.id);
    return { deleted: true };
  }),
});
