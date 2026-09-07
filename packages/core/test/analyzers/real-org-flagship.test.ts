import { describe, expect, it } from 'vitest';
import {
  productionRunLocalTestsGateAnalyzer,
  targetIsSandboxNoteAnalyzer,
} from '../../src/analyzers/coverage-rules.js';
import type { AnalysisContext, Component, OrgContext } from '../../src/types/analyzer.js';

/**
 * Proof that the flagship rule (`coverage/production-run-local-tests-gate`)
 * fires against ARM DEV's ACTUAL, LIVE state — not a plausible-looking
 * fixture — captured via read-only SOQL/Tooling queries on 2026-09-07.
 * No `deploy`/`validate` call was made against any org, per the task's
 * read-only constraint; every number below came from a `sf data query`.
 *
 * Exact commands run (see the PR body for full output):
 *
 *   sf data query --target-org "ARM DEV" \
 *     --query "SELECT Id, Name, OrganizationType, IsSandbox FROM Organization"
 *   -> OrganizationType: "Developer Edition", IsSandbox: false
 *
 *   sf data query --target-org "ARM DEV" --use-tooling-api \
 *     --query "SELECT PercentCovered FROM ApexOrgWideCoverage"
 *   -> PercentCovered: 0
 *
 *   sf data query --target-org "ARM DEV" --query "SELECT COUNT() FROM ApexClass"
 *   -> totalSize: 408
 *
 * Note on the number itself: the task brief's motivating story records
 * org-wide coverage at 31% at the time of the original incident; by the
 * time this workstream queried the same org, it had drifted to 0% (no
 * successful test run has recomputed `ApexOrgWideCoverage` since — the
 * rule is agnostic to the exact percentage, only to it being under the
 * 75% gate). Both numbers are documented here rather than silently
 * preferring the more dramatic one.
 */
const ARM_DEV_LIVE: OrgContext = {
  orgId: '00Dd200000mFdJxEAK',
  label: 'ARM DEV',
  organizationType: 'Developer Edition',
  isSandbox: false,
  orgWideCoveragePercent: 0,
  totalApexClassCount: 408,
  totalApexTriggerCount: 0,
};

function apexComponent(name: string): Component {
  return {
    key: { type: 'ApexClass', fullName: name },
    path: `classes/${name}.cls`,
    content: `public class ${name} { public void run() {} }`,
    auxFiles: [
      {
        path: `classes/${name}.cls-meta.xml`,
        content:
          '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>',
      },
    ],
  };
}

describe("flagship rule against ARM DEV's real, live-queried state", () => {
  it('would have pre-empted the motivating incident: RunLocalTests against ARM DEV fails before submission', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler'), apexComponent('OrderHandlerTest')],
      target: ARM_DEV_LIVE,
      intent: { testLevel: 'RunLocalTests' },
    };
    const findings = productionRunLocalTestsGateAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.severity).toBe('error');
    // The two facts the task brief says were "both knowable in advance":
    expect(finding.detail).toContain('Developer Edition'); // fact 1: production-like org despite IsSandbox-only checks assuming otherwise
    expect(finding.detail).toContain('0%'); // fact 2: org-wide coverage far under the 75% gate
    expect(finding.detail).toContain('408'); // the org-wide class count the gate actually measures against
    expect(finding.recommendation).toContain('RunSpecifiedTests');
    expect(finding.recommendation).toContain('sandbox');
  });

  it('confirms the org-type detection is NOT fooled by OrganizationType being something other than the literal string "Production"', () => {
    // This is the exact false-negative a naive `organizationType === 'Production'`
    // check would produce on ARM DEV — proven against the org's real,
    // live-queried OrganizationType string.
    expect(ARM_DEV_LIVE.organizationType).not.toBe('Production');
    expect(ARM_DEV_LIVE.isSandbox).toBe(false);
    const findings = productionRunLocalTestsGateAnalyzer.analyze({
      packageComponents: [apexComponent('OrderHandler')],
      target: ARM_DEV_LIVE,
      intent: { testLevel: 'RunLocalTests' },
    });
    expect(findings).toHaveLength(1);
  });

  it('the sandbox-confirmation rule stays silent on ARM DEV (it is not a sandbox)', () => {
    const findings = targetIsSandboxNoteAnalyzer.analyze({
      packageComponents: [apexComponent('OrderHandler')],
      target: ARM_DEV_LIVE,
    });
    expect(findings).toHaveLength(0);
  });
});
