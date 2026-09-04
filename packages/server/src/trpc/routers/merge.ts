import { eq } from 'drizzle-orm';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { z } from 'zod';
import {
  BINARY_BODY_TYPES,
  cleanupSourceTree,
  componentKeyString,
  mergeComponent,
  MERGE_PROFILE_LIKE_TYPES,
  resolveComponentContents,
  type ComponentKey,
  type MergeInput,
  type MergeProfileCoverage,
  type MergeResult,
} from '@vibeset/core';
import type { Db } from '../../db/client.js';
import type { SnapshotStore } from '@vibeset/core';
import { comparisons, connections, diffResults } from '../../db/schema.js';
import { sourceFromConnectionRow } from '../../jobs/shared/source-from-connection.js';
import { publicProcedure, router } from '../trpc.js';

const registry = new RegistryAccess();

/**
 * Locates the `diff_results` row for one component of a comparison — the
 * same (comparisonId, type, fullName[, parentFullName]) lookup
 * `comparisons.componentContent` already uses, reused here rather than
 * duplicated with different matching rules (a decomposed child like a
 * CustomField shares its `fullName`'s dotted form with its parent's rows
 * unless `parentFullName` disambiguates it).
 */
function findDiffResultRow(db: Db, input: { comparisonId: string; type: string; fullName: string; parentFullName?: string }) {
  const row = db
    .select()
    .from(diffResults)
    .where(eq(diffResults.comparisonId, input.comparisonId))
    .all()
    .find((r) => r.type === input.type && r.fullName === input.fullName && (input.parentFullName ? r.parentFullName === input.parentFullName : true));
  return row;
}

/**
 * Resolves one component's raw content from a `MetadataSource`, for the
 * three-way merge base only — a single-key counterpart to
 * `ComparisonEngine.fetchAndCache`'s per-chunk materialize, since a merge
 * request only ever needs ONE component's base content, not a whole
 * comparison's worth. Read-only: `materialize()` is the same retrieve path
 * every comparison already uses.
 */
async function materializeOneComponent(source: { materialize(keys: ComponentKey[]): Promise<any> }, key: ComponentKey): Promise<string | undefined> {
  const tree = await source.materialize([key]);
  try {
    const resolved = await resolveComponentContents(tree, [key], registry);
    return resolved.get(componentKeyString(key));
  } finally {
    await cleanupSourceTree(tree);
  }
}

export const mergeRouter = router({
  /**
   * Entry-level merge for one component of an existing comparison — the
   * tRPC face of `@vibeset/core`'s `mergeComponent` (Cassia's
   * `merge/dispatch.ts`), the headline differentiator over Gearset's
   * "stop at every conflict" behavior. Deliberately a `query`, not a
   * `mutation`: this only reads already-stored comparison content
   * (`diff_results`'/`component_snapshots`' blobs, plus the exact
   * retrieve-pairing coverage the original comparison computed) and, for
   * `baseConnectionId`, a read-only git-ref materialize — it has no side
   * effects and produces the same result given the same inputs.
   *
   * MODE, ENFORCED, NOT ASSERTED: a comparison is fundamentally two-sided
   * (`comparisons.leftConnectionId`/`rightConnectionId` — there is no
   * stored notion of a common ancestor for the pair being compared).
   * `baseConnectionId` is the ONLY way this procedure ever attempts a
   * `mode: 'three-way'` merge, and only after confirming that connection
   * is a `git-ref` source (the one kind that can actually supply a common
   * ancestor — see `types/merge.ts`'s file header in `@vibeset/core`).
   * Passing a non-`git-ref` `baseConnectionId` is a hard error, not a
   * silent downgrade to two-way — a caller that thinks it's getting 3-way
   * safety and silently isn't is exactly the hazard this whole design
   * exists to prevent. Omitting `baseConnectionId` always yields
   * `mode: 'two-way'`, which `MergeInput`'s discriminated union then makes
   * a compile-time-enforced fact for every consumer downstream (this
   * procedure can never construct a `base`-bearing `two-way` input, or a
   * `three-way` input missing one).
   *
   * COVERAGE, REUSED, NOT RECOMPUTED: for Profile/PermissionSet, the
   * `MergeProfileCoverage` passed to `mergeComponent` comes from
   * `comparisons.profileCoverageJson` — the EXACT `SideCoverage` pair
   * `ComparisonEngine` computed (via `compare/coverage.ts`) for THIS
   * component during the original comparison run (see that column's doc
   * comment in `db/schema.ts`). This is deliberate: recomputing coverage
   * live against the org today would risk disagreeing with the diff this
   * merge is supposed to be resolving (the org may have changed, or the
   * connection may not even resolve anymore), and would duplicate a
   * retrieval-planning computation this procedure has no business
   * repeating. The one exception is content proven byte-identical
   * (`leftSha256 === rightSha256`): coverage ambiguity cannot matter when
   * both sides are the literal same bytes (parsing the same string twice
   * can never disagree with itself on which entries are present), so that
   * case uses `{ mode: 'full' }` directly rather than requiring a stored
   * coverage entry a same-content component may never have needed. Every
   * other Profile/PermissionSet path requires the persisted coverage or
   * throws via `requireMergeProfileCoverage` — never silently assumes full
   * coverage, matching the diff-side guarantee this mirrors.
   */
  resolve: publicProcedure
    .input(
      z.object({
        comparisonId: z.string(),
        type: z.string(),
        fullName: z.string(),
        parentFullName: z.string().optional(),
        /**
         * A connection to supply a genuine 3-way merge base. MUST be a
         * `git-ref` connection — the only kind that can honestly supply a
         * common ancestor (see the procedure doc comment). Omit for the
         * (always-available) two-way merge.
         */
        baseConnectionId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const row = findDiffResultRow(ctx.db, input);
      if (!row) {
        throw new Error(
          `No diff result for ${input.type} "${input.fullName}"${input.parentFullName ? ` (parent ${input.parentFullName})` : ''} in comparison ${input.comparisonId}.`,
        );
      }

      const key: ComponentKey = { type: row.type, fullName: row.fullName, parentFullName: row.parentFullName ?? undefined };

      if (BINARY_BODY_TYPES.has(key.type)) {
        throw new Error(
          `${key.type} "${key.fullName}" is a binary-bodied component (StaticResource/Document) — there is no entry-level ` +
            `merge for opaque bytes. Resolve it as a whole-file choice (take left or take right) instead of via merge.resolve.`,
        );
      }

      const [leftContent, rightContent] = await Promise.all([
        row.leftSha256 ? ctx.snapshotStore.getBlob(row.leftSha256).then((b) => b?.content) : Promise.resolve(undefined),
        row.rightSha256 ? ctx.snapshotStore.getBlob(row.rightSha256).then((b) => b?.content) : Promise.resolve(undefined),
      ]);

      let mergeInput: MergeInput;
      if (input.baseConnectionId) {
        const baseRow = ctx.db.select().from(connections).where(eq(connections.id, input.baseConnectionId)).get();
        if (!baseRow) throw new Error(`No connection with id ${input.baseConnectionId}.`);
        if (baseRow.kind !== 'git-ref') {
          throw new Error(
            `merge.resolve: baseConnectionId ${input.baseConnectionId} is a "${baseRow.kind}" connection, not "git-ref". ` +
              `Only a git-ref source can supply a genuine common ancestor for a three-way merge (see MergeMode's doc ` +
              `comment in @vibeset/core) — Org<->Org has no ancestor, so this request cannot honestly be treated as ` +
              `three-way. Omit baseConnectionId for a two-way merge instead of pointing it at a non-git-ref connection.`,
          );
        }
        const baseSource = sourceFromConnectionRow(baseRow);
        const baseContent = await materializeOneComponent(baseSource, key);
        mergeInput = { mode: 'three-way', base: baseContent, left: leftContent, right: rightContent };
      } else {
        mergeInput = { mode: 'two-way', left: leftContent, right: rightContent };
      }

      let coverage: MergeProfileCoverage | undefined;
      if (MERGE_PROFILE_LIKE_TYPES.has(key.type)) {
        if (row.leftSha256 && row.rightSha256 && row.leftSha256 === row.rightSha256) {
          // Byte-identical on both sides — see the procedure doc comment
          // above for why coverage ambiguity provably cannot matter here.
          coverage = { left: { mode: 'full' }, right: { mode: 'full' } };
        } else {
          const comparisonRow = ctx.db.select().from(comparisons).where(eq(comparisons.id, input.comparisonId)).get();
          const stored = comparisonRow?.profileCoverageJson
            ? (JSON.parse(comparisonRow.profileCoverageJson) as Record<string, MergeProfileCoverage>)
            : undefined;
          const entry = stored?.[componentKeyString(key)];
          if (!entry) {
            throw new Error(
              `merge.resolve: no recorded retrieve-pairing coverage for ${key.type} "${key.fullName}" in comparison ` +
                `${input.comparisonId}. This comparison may predate coverage capture, or this component's coverage was ` +
                `never recorded. Refusing to guess or default to full coverage — see MergeProfileCoverage's doc comment ` +
                `in @vibeset/core: an unretrieved permission mistakenly treated as a deletion silently strips access on ` +
                `deploy. Re-run the comparison to capture coverage, then retry.`,
            );
          }
          coverage = entry;
        }
      }

      const result: MergeResult = mergeComponent(key, mergeInput, coverage);
      return { comparisonId: input.comparisonId, diffStatus: row.status, ...result };
    }),
});
