import { z } from 'zod';

/**
 * The tRPC-facing shape of `@vibeset/core`'s `TypeFilter` — shared by
 * `comparisons.ts`, `inventory.ts`, and `filters.ts` (which also validates
 * a saved `FilterSet.filter` against this same schema) rather than each
 * router hand-maintaining its own copy that silently drifts out of sync
 * with `TypeFilter`'s actual fields (exactly what happened before this:
 * `excludeNamespaces` existed on `TypeFilter` since Phase 2 planning but
 * `OrgSource.inventory()` never consulted it — see `sources/type-filter.ts`
 * — and this schema previously didn't even expose `modifiedBy`/
 * `excludeManagedPackages` for the UI to send).
 */
export const TypeFilterSchema = z.object({
  types: z.array(z.string()).optional(),
  namePatterns: z.array(z.string()).optional(),
  modifiedSince: z.string().optional(),
  modifiedBy: z.array(z.string()).optional(),
  excludeNamespaces: z.array(z.string()).optional(),
  excludeManagedPackages: z.boolean().optional(),
});

export const OptionalTypeFilterSchema = TypeFilterSchema.optional();
