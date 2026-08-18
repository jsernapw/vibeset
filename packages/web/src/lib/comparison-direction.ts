/**
 * The one place the wizard's user-facing Source/Target wording is translated
 * into the server's left/right wording. They are OPPOSITE, which is exactly
 * why this lives in a single tested function instead of inline at a call site.
 *
 *   UI      "Source" = where the change comes from (the desired state)
 *           "Target" = the org being changed (its current state)
 *
 *   Server  `left`   = target org / current state
 *           `right`  = desired / source state
 *           (documented on `comparisons.start`, and relied on by
 *            `package/selection.ts` to decide deploy direction)
 *
 * So Source -> right, Target -> left. Getting this backwards does not fail
 * loudly: the comparison still runs and looks plausible, but the resulting
 * deployment package targets the WRONG ORG — potentially deploying a sandbox's
 * state into production. `comparison-direction.test.ts` locks it down; if you
 * are here because the swap "looks wrong", read that test before changing it.
 */
export interface WizardSources {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly targetId: string;
  readonly targetLabel: string;
}

export interface ServerComparisonSides {
  readonly leftId: string;
  readonly leftLabel: string;
  readonly rightId: string;
  readonly rightLabel: string;
}

export function toServerSides(sources: WizardSources): ServerComparisonSides {
  return {
    // left = the org being changed (current state) = the user's Target
    leftId: sources.targetId,
    leftLabel: sources.targetLabel,
    // right = the desired state = the user's Source
    rightId: sources.sourceId,
    rightLabel: sources.sourceLabel,
  };
}
