import { describe, expect, it } from 'vitest';
import {
  COVERAGE_ANALYZERS,
  productionRunLocalTestsGateAnalyzer,
  productionNoTestRunInvalidAnalyzer,
  specifiedTestsIncompleteAnalyzer,
  triggerWithoutApparentTestAnalyzer,
  deployedClassLowIndividualCoverageAnalyzer,
  targetIsSandboxNoteAnalyzer,
} from '../../src/analyzers/coverage-rules.js';
import type { AnalysisContext, Component, OrgContext } from '../../src/types/analyzer.js';

/**
 * `OrderHandler` here stands in for the two Apex classes from the task
 * brief's motivating story: real ApexClass source-format shape (body +
 * `-meta.xml` sidecar, verified against a real `sf project retrieve`
 * output — see `test/fixtures/real-retrieve-account` and the PR body for
 * the exact retrieve this was checked against).
 */
function apexComponent(name: string): Component {
  return {
    key: { type: 'ApexClass', fullName: name },
    path: `classes/${name}.cls`,
    content: `public class ${name} {\n    public void run() {}\n}`,
    auxFiles: [
      {
        path: `classes/${name}.cls-meta.xml`,
        content:
          '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>61.0</apiVersion>\n    <status>Active</status>\n</ApexClass>',
      },
    ],
  };
}

/** ARM DEV's own real shape, per the task brief and the read-only org queries the PR body documents: Developer Edition, IsSandbox = false, org-wide coverage well under 75% across ~408 largely-untested Apex classes. */
const armDevLikeOrg: OrgContext = {
  orgId: '00Dd200000mFdJxEAK',
  label: 'ARM DEV',
  organizationType: 'Developer Edition',
  isSandbox: false,
  orgWideCoveragePercent: 31,
  totalApexClassCount: 408,
  totalApexTriggerCount: 0,
};

describe('coverage/production-run-local-tests-gate (flagship rule)', () => {
  const analyzer = productionRunLocalTestsGateAnalyzer;

  it('reproduces the motivating story: 2 classes, DE org, 31% coverage, RunLocalTests -> error before validation is ever submitted', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler'), apexComponent('OrderHandlerTest')],
      target: armDevLikeOrg,
      intent: { testLevel: 'RunLocalTests' },
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.title).toContain('75%');
    expect(findings[0]!.detail).toContain('31%');
    expect(findings[0]!.detail).toContain('Developer Edition');
    expect(findings[0]!.detail).toContain('OrderHandler');
    expect(findings[0]!.recommendation).toContain('RunSpecifiedTests');
    expect(findings[0]!.recommendation).toContain('OrderHandler');
  });

  it('is a warning (not yet a certainty) when no test level has been chosen yet', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
  });

  it('also fires for RunAllTestsInOrg, which computes coverage the same org-wide way', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
      intent: { testLevel: 'RunAllTestsInOrg' },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(1);
  });

  it('does not fire for RunSpecifiedTests (a different rule governs that)', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
      intent: { testLevel: 'RunSpecifiedTests', runTests: ['OrderHandlerTest'] },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire on a confirmed sandbox, however low coverage is', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, isSandbox: true },
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when isSandbox is unknown, rather than guessing production', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, isSandbox: undefined },
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when org-wide coverage is unknown', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, orgWideCoveragePercent: undefined },
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when coverage already meets the threshold', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, orgWideCoveragePercent: 80 },
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when there is no target org context at all', () => {
    const ctx: AnalysisContext = { packageComponents: [apexComponent('OrderHandler')] };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('appliesTo is false for a package with no Apex', () => {
    const ctx: AnalysisContext = {
      packageComponents: [
        { key: { type: 'Layout', fullName: 'Account-Layout' }, path: 'x', content: '<Layout/>' },
      ],
      target: armDevLikeOrg,
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(analyzer.appliesTo?.(ctx)).toBe(false);
  });
});

describe('coverage/production-notestrun-invalid', () => {
  it('flags NoTestRun on a production-like org deploying Apex', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
      intent: { testLevel: 'NoTestRun' },
    };
    const findings = productionNoTestRunInvalidAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('does not fire on a sandbox', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, isSandbox: true },
      intent: { testLevel: 'NoTestRun' },
    };
    expect(productionNoTestRunInvalidAnalyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire for a different test level', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
      intent: { testLevel: 'RunLocalTests' },
    };
    expect(productionNoTestRunInvalidAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('coverage/specified-tests-incomplete', () => {
  it('errors when RunSpecifiedTests has an empty test list', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      intent: { testLevel: 'RunSpecifiedTests', runTests: [] },
    };
    const findings = specifiedTestsIncompleteAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('warns when no specified test looks related to a deployed class by name', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      intent: { testLevel: 'RunSpecifiedTests', runTests: ['SomeUnrelatedTest'] },
    };
    const findings = specifiedTestsIncompleteAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('OrderHandler');
  });

  it('does not warn when a specified test is name-related to the deployed class', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      intent: { testLevel: 'RunSpecifiedTests', runTests: ['OrderHandlerTest'] },
    };
    expect(specifiedTestsIncompleteAnalyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not evaluate test classes themselves against the heuristic', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandlerTest')],
      intent: { testLevel: 'RunSpecifiedTests', runTests: ['OrderHandlerTest'] },
    };
    expect(specifiedTestsIncompleteAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('coverage/trigger-without-apparent-test', () => {
  function triggerComponent(name: string): Component {
    return {
      key: { type: 'ApexTrigger', fullName: name },
      path: `triggers/${name}.trigger`,
      content: 'trigger X on Account (before insert) {}',
    };
  }

  it('flags a trigger with no related in-package test and no org coverage record', () => {
    const ctx: AnalysisContext = { packageComponents: [triggerComponent('AccountTrigger')] };
    const findings = triggerWithoutApparentTestAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
  });

  it('does not flag when a related test class is in the same package', () => {
    const ctx: AnalysisContext = {
      packageComponents: [triggerComponent('AccountTrigger'), apexComponent('AccountTriggerTest')],
    };
    expect(triggerWithoutApparentTestAnalyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when the org already reports nonzero coverage for it', () => {
    const ctx: AnalysisContext = {
      packageComponents: [triggerComponent('AccountTrigger')],
      target: {
        apexCoverage: new Map([
          ['AccountTrigger', { percentCovered: 90, linesCovered: 9, linesUncovered: 1 }],
        ]),
      },
    };
    expect(triggerWithoutApparentTestAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('coverage/deployed-class-low-individual-coverage', () => {
  it('flags a deployed class below 75% in the org apex coverage map, on a production-like org', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: {
        ...armDevLikeOrg,
        apexCoverage: new Map([
          ['OrderHandler', { percentCovered: 40, linesCovered: 4, linesUncovered: 6 }],
        ]),
      },
    };
    const findings = deployedClassLowIndividualCoverageAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('40%');
  });

  it('does not flag a class the org has never executed a test against (absent from the map)', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { ...armDevLikeOrg, apexCoverage: new Map() },
    };
    expect(deployedClassLowIndividualCoverageAnalyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag on a sandbox', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: {
        ...armDevLikeOrg,
        isSandbox: true,
        apexCoverage: new Map([
          ['OrderHandler', { percentCovered: 10, linesCovered: 1, linesUncovered: 9 }],
        ]),
      },
    };
    expect(deployedClassLowIndividualCoverageAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('coverage/target-is-sandbox', () => {
  it('gives a reassuring info note on a confirmed sandbox deploying Apex', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: { label: 'js-sandbox', isSandbox: true, orgWideCoveragePercent: 20 },
    };
    const findings = targetIsSandboxNoteAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
  });

  it('does not fire on a production-like org', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('OrderHandler')],
      target: armDevLikeOrg,
    };
    expect(targetIsSandboxNoteAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('COVERAGE_ANALYZERS', () => {
  it('exports exactly the six coverage rules, each with a unique id', () => {
    expect(COVERAGE_ANALYZERS).toHaveLength(6);
    expect(new Set(COVERAGE_ANALYZERS.map((a) => a.id)).size).toBe(6);
  });
});
