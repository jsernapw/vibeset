import type { PreDeployComponentState } from '@vibeset/core';
import { componentKeyString } from '@vibeset/core';
import type { deploymentComponents } from '../../db/schema.js';

/**
 * Reconstructs `package/rollback.ts`'s `PreDeployComponentState` map from
 * persisted `deployment_components` rows (`beforeExisted`/`beforeSha256`,
 * captured by `capturePreDeployState` at deploy time — see
 * `trpc/routers/deploy.ts`'s job handler). Shared by `deploy.ts` (re-
 * deriving a rollback package's restore content at deploy time) and
 * `history.ts` (`generateRollback`'s preview).
 */
export function preDeployStateFromRows(
  rows: readonly (typeof deploymentComponents.$inferSelect)[],
): Map<string, PreDeployComponentState> {
  const state = new Map<string, PreDeployComponentState>();
  for (const row of rows) {
    const key = { type: row.type, fullName: row.fullName };
    state.set(componentKeyString(key), {
      key,
      existed: row.beforeExisted === true,
      sha256: row.beforeSha256 ?? undefined,
    });
  }
  return state;
}
