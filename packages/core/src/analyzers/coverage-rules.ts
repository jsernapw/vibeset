import type { Analyzer, AnalysisContext, Finding } from '../types/analyzer.js';
import { isProductionLikeOrg } from '../types/analyzer.js';

/**
 * The flagship rule this whole workstream exists to ship — see the task
 * brief's motivating story: two Apex classes validated clean (28 tests,
 * 0 failures) but the validation still failed after 8 seconds because
 * `RunLocalTests` computes coverage across every local Apex class in the
 * ORG (408 of them, largely untested), not the handful being deployed —
 * and because the target was a Developer Edition org, which the Metadata
 * API gates identically to Production even though `IsSandbox` is the only
 * field a naive check would look at that actually says so.
 *
 * Both facts were knowable before the validation was ever submitted:
 * `target.isSandbox` and `target.orgWideCoveragePercent` are exactly the
 * two numbers a read-only org query already has by the time a user is
 * choosing a test level. This rule exists so that query happens BEFORE
 * the 8-second round trip, not after.
 */
const PRODUCTION_RUN_LOCAL_TESTS_GATE_ID = 'coverage/production-run-local-tests-gate';
const COVERAGE_THRESHOLD_PERCENT = 75;

function isApexKey(type: string): boolean {
  return type === 'ApexClass' || type === 'ApexTrigger';
}

function apexNames(ctx: AnalysisContext): string[] {
  return ctx.packageComponents.filter((c) => isApexKey(c.key.type)).map((c) => c.key.fullName);
}

function formatOrgLabel(ctx: AnalysisContext): string {
  return ctx.target?.label ?? ctx.target?.orgId ?? 'the target org';
}

function formatApexCountPhrase(ctx: AnalysisContext): string {
  const total = (ctx.target?.totalApexClassCount ?? 0) + (ctx.target?.totalApexTriggerCount ?? 0);
  return total > 0
    ? `${total} Apex classes and triggers`
    : 'every Apex class and trigger in the org';
}

export const productionRunLocalTestsGateAnalyzer: Analyzer = {
  id: PRODUCTION_RUN_LOCAL_TESTS_GATE_ID,
  title: 'RunLocalTests/RunAllTestsInOrg will fail the org-wide coverage gate',
  category: 'coverage',
  defaultSeverity: 'error',
  appliesTo(ctx) {
    return ctx.packageComponents.some((c) => isApexKey(c.key.type));
  },
  analyze(ctx): Finding[] {
    if (!ctx.packageComponents.some((c) => isApexKey(c.key.type))) return [];
    const org = ctx.target;
    if (!org) return [];
    if (isProductionLikeOrg(org) !== true) return []; // unknown or confirmed sandbox: no gate to warn about
    const coverage = org.orgWideCoveragePercent;
    if (coverage === undefined || coverage >= COVERAGE_THRESHOLD_PERCENT) return [];

    const testLevel = ctx.intent?.testLevel;
    // RunSpecifiedTests and NoTestRun don't compute org-wide coverage the
    // same way — those have their own rules below. This rule is about the
    // two test levels (or "not chosen yet", which currently means one of
    // these two by omission) that DO run the org-wide gate.
    if (testLevel === 'RunSpecifiedTests' || testLevel === 'NoTestRun') return [];

    const deployed = apexNames(ctx);
    const orgLabel = formatOrgLabel(ctx);
    const editionNote = org.organizationType
      ? `a ${org.organizationType} org`
      : 'a non-sandbox org';
    const chosenLevelText = testLevel ? `"${testLevel}"` : 'RunLocalTests or RunAllTestsInOrg';
    const severity = testLevel ? 'error' : 'warning';

    const title = testLevel
      ? `${chosenLevelText} will fail ${orgLabel}'s ${COVERAGE_THRESHOLD_PERCENT}% coverage gate`
      : `Choosing RunLocalTests here will fail ${orgLabel}'s ${COVERAGE_THRESHOLD_PERCENT}% coverage gate`;

    const detail =
      `${orgLabel} is ${editionNote}, and the Salesforce Metadata API enforces the org-wide ` +
      `${COVERAGE_THRESHOLD_PERCENT}% Apex coverage requirement on every non-sandbox org — Developer ` +
      `Edition included, not only orgs whose OrganizationType is literally "Production". Org-wide ` +
      `coverage is currently ${coverage}% across ${formatApexCountPhrase(ctx)}, below the ` +
      `${COVERAGE_THRESHOLD_PERCENT}% minimum. ${chosenLevelText} computes coverage across every local ` +
      `Apex class and trigger in the org, not just the ${deployed.length || 'component(s)'} being ` +
      `deployed here${deployed.length ? ` (${deployed.join(', ')})` : ''} — so this validation will ` +
      `fail even if those specific components are fully covered by their own tests.`;

    const recommendation =
      deployed.length > 0
        ? `Use RunSpecifiedTests naming a test class that covers ${deployed.join(', ')} — Salesforce ` +
          `still requires the deployed classes to individually reach ${COVERAGE_THRESHOLD_PERCENT}% under ` +
          `RunSpecifiedTests, but does NOT require org-wide coverage. Alternatively, target a sandbox: ` +
          `sandboxes are exempt from this gate entirely.`
        : `Use RunSpecifiedTests with tests that cover the components being deployed, or target a sandbox — ` +
          `sandboxes are exempt from this gate entirely.`;

    return [
      {
        analyzerId: PRODUCTION_RUN_LOCAL_TESTS_GATE_ID,
        severity,
        title,
        detail,
        recommendation,
      },
    ];
  },
};

const NOTESTRUN_INVALID_ID = 'coverage/production-notestrun-invalid';

export const productionNoTestRunInvalidAnalyzer: Analyzer = {
  id: NOTESTRUN_INVALID_ID,
  title: 'NoTestRun is rejected for Apex deployments to a production-like org',
  category: 'coverage',
  defaultSeverity: 'error',
  appliesTo(ctx) {
    return (
      ctx.packageComponents.some((c) => isApexKey(c.key.type)) &&
      ctx.intent?.testLevel === 'NoTestRun'
    );
  },
  analyze(ctx): Finding[] {
    if (ctx.intent?.testLevel !== 'NoTestRun') return [];
    const org = ctx.target;
    if (!org || isProductionLikeOrg(org) !== true) return [];
    const deployed = apexNames(ctx);
    const orgLabel = formatOrgLabel(ctx);
    return [
      {
        analyzerId: NOTESTRUN_INVALID_ID,
        severity: 'error',
        title: `NoTestRun is not a valid test level for this deployment to ${orgLabel}`,
        detail:
          `The package deploys ${deployed.length} Apex component(s) (${deployed.join(', ')}) to ${orgLabel}, ` +
          `a production-like org. Salesforce's Metadata API rejects "NoTestRun" outright whenever a ` +
          `deployment contains Apex classes or triggers and the target is not a sandbox — this will fail ` +
          `before any test even runs.`,
        recommendation: `Choose RunSpecifiedTests (naming tests that cover ${deployed.join(', ')}) or RunLocalTests instead.`,
      },
    ];
  },
};

const SPECIFIED_TESTS_INCOMPLETE_ID = 'coverage/specified-tests-incomplete';

/** Best-effort name-relatedness check: `FooTest`/`TestFoo`/a substring match against the class name being deployed. Documented as a heuristic — a real dependency graph (Maximus's seam) would confirm this by an actual `SeeAllData`/reference edge rather than naming convention. */
function looksRelated(testName: string, className: string): boolean {
  const t = testName.toLowerCase();
  const c = className.toLowerCase();
  return t.includes(c) || c.includes(t);
}

export const specifiedTestsIncompleteAnalyzer: Analyzer = {
  id: SPECIFIED_TESTS_INCOMPLETE_ID,
  title: 'RunSpecifiedTests test list does not obviously cover every deployed Apex class',
  category: 'coverage',
  defaultSeverity: 'warning',
  appliesTo(ctx) {
    return (
      ctx.intent?.testLevel === 'RunSpecifiedTests' &&
      ctx.packageComponents.some((c) => c.key.type === 'ApexClass')
    );
  },
  analyze(ctx): Finding[] {
    if (ctx.intent?.testLevel !== 'RunSpecifiedTests') return [];
    const runTests = ctx.intent?.runTests ?? [];
    const findings: Finding[] = [];
    if (runTests.length === 0) {
      return [
        {
          analyzerId: SPECIFIED_TESTS_INCOMPLETE_ID,
          severity: 'error',
          title: 'RunSpecifiedTests is chosen but no test classes are specified',
          detail:
            'Salesforce requires at least one test class name under RunSpecifiedTests; an empty list will be rejected before any test runs.',
          recommendation: 'Name at least one test class that exercises the Apex being deployed.',
        },
      ];
    }
    const nonTestClasses = ctx.packageComponents
      .filter((c) => c.key.type === 'ApexClass' && !/test/i.test(c.key.fullName))
      .map((c) => c.key.fullName);
    for (const className of nonTestClasses) {
      const covered = runTests.some((t) => looksRelated(t, className));
      if (covered) continue;
      findings.push({
        analyzerId: SPECIFIED_TESTS_INCOMPLETE_ID,
        severity: 'warning',
        title: `No specified test appears to cover "${className}"`,
        detail:
          `RunSpecifiedTests names [${runTests.join(', ')}], none of which is obviously related to "${className}" ` +
          `by name. Salesforce still requires ${className} to individually reach ${COVERAGE_THRESHOLD_PERCENT}% ` +
          `coverage under RunSpecifiedTests — if nothing in the run actually exercises it, the deploy will fail ` +
          `the per-class coverage check even though the org-wide gate doesn't apply.`,
        recommendation: `Add a test class that exercises "${className}" to the specified test list (this is a name-based heuristic — confirm the class is genuinely covered, not just similarly named).`,
        key: { type: 'ApexClass', fullName: className },
      });
    }
    return findings;
  },
};

const NEW_TRIGGER_WITHOUT_TEST_ID = 'coverage/trigger-without-apparent-test';

export const triggerWithoutApparentTestAnalyzer: Analyzer = {
  id: NEW_TRIGGER_WITHOUT_TEST_ID,
  title: 'ApexTrigger has no apparent test coverage',
  category: 'coverage',
  defaultSeverity: 'info',
  appliesTo(ctx) {
    return ctx.packageComponents.some((c) => c.key.type === 'ApexTrigger');
  },
  analyze(ctx): Finding[] {
    const org = ctx.target;
    const findings: Finding[] = [];
    for (const trigger of ctx.packageComponents.filter((c) => c.key.type === 'ApexTrigger')) {
      const inPackageTest = ctx.packageComponents.some(
        (c) =>
          c.key.type === 'ApexClass' &&
          looksRelated(c.key.fullName, trigger.key.fullName) &&
          /test/i.test(c.key.fullName),
      );
      if (inPackageTest) continue;
      const orgCoverageEntry = org?.apexCoverage?.get(trigger.key.fullName);
      if (orgCoverageEntry && orgCoverageEntry.percentCovered > 0) continue;
      findings.push({
        analyzerId: NEW_TRIGGER_WITHOUT_TEST_ID,
        severity: 'info',
        title: `"${trigger.key.fullName}" has no apparent test coverage`,
        detail:
          `Triggers can't be unit-tested directly — coverage comes from a test class that performs DML on ` +
          `the triggering object. Neither the package nor the target org's existing coverage data (this is a ` +
          `naming heuristic, not a real dependency check) shows a related test for "${trigger.key.fullName}".`,
        recommendation: `Confirm a test class exercises "${trigger.key.fullName}" before relying on RunSpecifiedTests/RunLocalTests to pass.`,
        key: trigger.key,
      });
    }
    return findings;
  },
};

const LOW_INDIVIDUAL_COVERAGE_ID = 'coverage/deployed-class-low-individual-coverage';

export const deployedClassLowIndividualCoverageAnalyzer: Analyzer = {
  id: LOW_INDIVIDUAL_COVERAGE_ID,
  title: 'A deployed Apex class already has below-threshold coverage in the target org',
  category: 'coverage',
  defaultSeverity: 'warning',
  appliesTo(ctx) {
    return (
      Boolean(ctx.target?.apexCoverage) && ctx.packageComponents.some((c) => isApexKey(c.key.type))
    );
  },
  analyze(ctx): Finding[] {
    const org = ctx.target;
    if (!org || isProductionLikeOrg(org) !== true || !org.apexCoverage) return [];
    const findings: Finding[] = [];
    for (const component of ctx.packageComponents.filter((c) => isApexKey(c.key.type))) {
      const entry = org.apexCoverage.get(component.key.fullName);
      if (!entry) continue; // never executed by any test yet in the org's coverage snapshot — not this rule's concern
      if (entry.percentCovered >= COVERAGE_THRESHOLD_PERCENT) continue;
      findings.push({
        analyzerId: LOW_INDIVIDUAL_COVERAGE_ID,
        severity: 'warning',
        title: `"${component.key.fullName}" is at ${entry.percentCovered}% coverage, below the ${COVERAGE_THRESHOLD_PERCENT}% per-class minimum`,
        detail:
          `${formatOrgLabel(ctx)}'s last test run measured "${component.key.fullName}" at ` +
          `${entry.percentCovered}% (${entry.linesCovered}/${entry.linesCovered + entry.linesUncovered} lines). ` +
          `A production-like org requires each deployed class to individually reach ${COVERAGE_THRESHOLD_PERCENT}% ` +
          `under RunSpecifiedTests, or contribute to the org-wide gate under RunLocalTests.`,
        recommendation: `Add test assertions that exercise the uncovered lines in "${component.key.fullName}" before deploying.`,
        key: component.key,
      });
    }
    return findings;
  },
};

const TARGET_IS_SANDBOX_ID = 'coverage/target-is-sandbox';

export const targetIsSandboxNoteAnalyzer: Analyzer = {
  id: TARGET_IS_SANDBOX_ID,
  title: 'Target is a sandbox — the org-wide coverage gate does not apply',
  category: 'coverage',
  defaultSeverity: 'info',
  appliesTo(ctx) {
    return (
      ctx.packageComponents.some((c) => isApexKey(c.key.type)) && ctx.target?.isSandbox === true
    );
  },
  analyze(ctx): Finding[] {
    const org = ctx.target;
    if (!org || org.isSandbox !== true) return [];
    return [
      {
        analyzerId: TARGET_IS_SANDBOX_ID,
        severity: 'info',
        title: `${formatOrgLabel(ctx)} is a sandbox — the ${COVERAGE_THRESHOLD_PERCENT}% org-wide coverage gate is not enforced here`,
        detail:
          `${formatOrgLabel(ctx)} reports IsSandbox = true, so the Metadata API does not enforce the ` +
          `org-wide Apex coverage requirement regardless of the org's current coverage${
            org.orgWideCoveragePercent !== undefined
              ? ` (currently ${org.orgWideCoveragePercent}%)`
              : ''
          }. RunLocalTests/RunAllTestsInOrg will still run tests, but a low org-wide percentage will not fail validation here the way it would on a production-like org.`,
        recommendation:
          'No action needed for this gate specifically — this is a confirmation, not a warning.',
      },
    ];
  },
};

export const COVERAGE_ANALYZERS: readonly Analyzer[] = [
  productionRunLocalTestsGateAnalyzer,
  productionNoTestRunInvalidAnalyzer,
  specifiedTestsIncompleteAnalyzer,
  triggerWithoutApparentTestAnalyzer,
  deployedClassLowIndividualCoverageAnalyzer,
  targetIsSandboxNoteAnalyzer,
];
