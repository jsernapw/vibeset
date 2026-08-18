import type { ComponentKey } from '../types/metadata-source.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import { componentKeyString } from '../util/component-key.js';

/**
 * What the target org looked like for one component immediately BEFORE a
 * deployment ran, captured by `deploy/pre-deploy-snapshot.ts`'s
 * `capturePreDeployState` via the content-addressed store. `existed: false`
 * means the component was confirmed absent from the target at deploy time
 * (the deploy created it from nothing); `sha256` is only present when
 * `existed` is `true`.
 */
export interface PreDeployComponentState {
  readonly key: ComponentKey;
  readonly existed: boolean;
  readonly sha256?: string;
}

export interface RollbackInput {
  /** The original deployment's add/update set (`DeploymentPackage.components`). */
  readonly components: readonly ComponentKey[];
  /** The original deployment's destructive set (`DeploymentPackage.destructiveComponents`). */
  readonly destructiveComponents: readonly ComponentKey[];
  /** Pre-deploy state for every key in `components` and `destructiveComponents`, keyed by `componentKeyString`. */
  readonly preDeployState: ReadonlyMap<string, PreDeployComponentState>;
}

export interface RollbackSkippedEntry {
  readonly key: ComponentKey;
  readonly reason: string;
}

export interface RollbackPlan {
  /** Components to restore to their pre-deploy content (an add/update deploy, going through the same validate/deploy path as any other package). */
  readonly components: ComponentKey[];
  /** Components to delete: originally-added components that didn't exist before the deploy (undoing an add), via a normal destructive-changes manifest. */
  readonly destructiveComponents: ComponentKey[];
  /** Canonical content to write back for every key in `components`, keyed by `componentKeyString`. */
  readonly restoreContent: ReadonlyMap<string, string>;
  /** Components that could not be included in the rollback, with a human-readable reason — surfaced to the user rather than silently dropped. */
  readonly skipped: readonly RollbackSkippedEntry[];
}

/**
 * Generates the inverse of a completed deployment: an add/update set that
 * restores every changed component to its pre-deploy content, and a
 * destructive set that removes whatever the original deploy newly created.
 * Built entirely from `PreDeployComponentState` + the content-addressed
 * `SnapshotStore` — no network access, no re-retrieve, which is the whole
 * point of capturing pre-deploy state up front (see `ARCHITECTURE.md`'s
 * content-addressing note: "this is what makes rollback-package generation
 * ... nearly free").
 *
 * Inversion rules:
 *  - Original ADD/UPDATE (`input.components`) of a component that did NOT
 *    exist before the deploy → rollback DELETES it (undoes the add).
 *  - Original ADD/UPDATE of a component that DID exist before → rollback
 *    restores its prior content (an update, going through the same
 *    add/update path).
 *  - Original DESTRUCTIVE delete (`input.destructiveComponents`) of a
 *    component that existed before → rollback RECREATES it from its prior
 *    content.
 *  - Original DESTRUCTIVE delete of a component with no pre-deploy record
 *    of ever having existed (the "was deleted but never previously
 *    existed" edge case named in the task brief — e.g. state capture
 *    raced with an out-of-band deletion, or a destructive entry referenced
 *    a component that was already gone) → nothing to restore; recorded in
 *    `skipped`, not silently dropped, and not treated as an error.
 */
export async function generateRollbackPlan(input: RollbackInput, store: SnapshotStore): Promise<RollbackPlan> {
  const components: ComponentKey[] = [];
  const destructiveComponents: ComponentKey[] = [];
  const restoreContent = new Map<string, string>();
  const skipped: RollbackSkippedEntry[] = [];

  const restore = async (key: ComponentKey, pre: PreDeployComponentState | undefined, contextLabel: string): Promise<void> => {
    if (!pre?.existed || !pre.sha256) {
      skipped.push({
        key,
        reason: `No pre-deploy content on record for this component (${contextLabel}) — nothing to restore.`,
      });
      return;
    }
    const blob = await store.getBlob(pre.sha256);
    if (!blob) {
      skipped.push({ key, reason: `Pre-deploy snapshot ${pre.sha256} is no longer present in the snapshot store.` });
      return;
    }
    components.push(key);
    restoreContent.set(componentKeyString(key), blob.content);
  };

  for (const key of input.components) {
    const pre = input.preDeployState.get(componentKeyString(key));
    if (!pre || !pre.existed) {
      // Original deploy created this from nothing -> rollback deletes it.
      destructiveComponents.push(key);
      continue;
    }
    await restore(key, pre, 'originally added/updated');
  }

  for (const key of input.destructiveComponents) {
    const pre = input.preDeployState.get(componentKeyString(key));
    // A delete of something that never existed pre-deploy is the "deleted
    // but never previously existed" edge case: no-op both ways, recorded
    // via the shared `restore` path's own skip reasoning.
    await restore(key, pre, 'originally deleted');
  }

  return { components, destructiveComponents, restoreContent, skipped };
}
