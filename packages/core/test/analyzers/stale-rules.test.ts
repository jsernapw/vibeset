import { describe, expect, it } from 'vitest';
import {
  apiVersionFarBehindAnalyzer,
  inactiveValidationRuleAnalyzer,
  flowVersionStatusAnalyzer,
  inactiveWorkflowRuleAnalyzer,
  STALE_ANALYZERS,
} from '../../src/analyzers/stale-rules.js';
import type { AnalysisContext, Component } from '../../src/types/analyzer.js';

/** Real ApexClass source-format shape: body + `-meta.xml` sidecar carrying `apiVersion`. `61.0` is the REAL apiVersion of ARM DEV's `ChangePasswordController`, retrieved read-only via `sf project retrieve start` on 2026-09-07 — see the PR body. */
function apexComponent(name: string, apiVersion: string): Component {
  return {
    key: { type: 'ApexClass', fullName: name },
    path: `classes/${name}.cls`,
    content: 'public class X {}',
    auxFiles: [
      {
        path: `classes/${name}.cls-meta.xml`,
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVersion}</apiVersion>\n    <status>Active</status>\n</ApexClass>`,
      },
    ],
  };
}

describe('stale/api-version-far-behind', () => {
  it('flags real ARM DEV apiVersion 61.0 as far behind a current org version of 67.0 (real org number, live-queried 2026-09-07)', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('ChangePasswordController', '61.0')],
      target: { currentApiVersion: '67.0' },
    };
    const findings = apiVersionFarBehindAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.title).toContain('61');
    expect(findings[0]!.title).toContain('67');
  });

  it('does not flag a gap under the threshold', () => {
    const ctx: AnalysisContext = {
      packageComponents: [apexComponent('Recent', '65.0')],
      target: { currentApiVersion: '67.0' },
    };
    expect(apiVersionFarBehindAnalyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when the org current version is unknown', () => {
    const ctx: AnalysisContext = { packageComponents: [apexComponent('Old', '40.0')] };
    expect(apiVersionFarBehindAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('stale/inactive-validation-rule', () => {
  function rule(active: string): Component {
    return {
      key: { type: 'ValidationRule', fullName: 'Account.My_Rule' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">\n    <active>${active}</active>\n    <errorConditionFormula>1=1</errorConditionFormula>\n    <errorMessage>x</errorMessage>\n</ValidationRule>`,
    };
  }

  it('flags an inactive validation rule', () => {
    expect(
      inactiveValidationRuleAnalyzer.analyze({ packageComponents: [rule('false')] }),
    ).toHaveLength(1);
  });

  it('does not flag an active validation rule', () => {
    expect(
      inactiveValidationRuleAnalyzer.analyze({ packageComponents: [rule('true')] }),
    ).toHaveLength(0);
  });
});

describe('stale/flow-version-status', () => {
  function flow(status: string): Component {
    return {
      key: { type: 'Flow', fullName: 'My_Flow' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>My Flow</label>\n    <status>${status}</status>\n</Flow>`,
    };
  }

  it('flags an Obsolete flow version with warning severity', () => {
    const findings = flowVersionStatusAnalyzer.analyze({ packageComponents: [flow('Obsolete')] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
  });

  it('flags a Draft flow version with info severity', () => {
    const findings = flowVersionStatusAnalyzer.analyze({ packageComponents: [flow('Draft')] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
  });

  it('does not flag an Active flow version', () => {
    expect(flowVersionStatusAnalyzer.analyze({ packageComponents: [flow('Active')] })).toHaveLength(
      0,
    );
  });
});

describe('stale/inactive-workflow-rule', () => {
  function rule(active: string): Component {
    return {
      key: { type: 'WorkflowRule', fullName: 'Account.My_Rule' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<WorkflowRule xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>My_Rule</fullName>\n    <active>${active}</active>\n    <triggerType>onCreateOnly</triggerType>\n</WorkflowRule>`,
    };
  }

  it('flags an inactive workflow rule', () => {
    expect(
      inactiveWorkflowRuleAnalyzer.analyze({ packageComponents: [rule('false')] }),
    ).toHaveLength(1);
  });

  it('does not flag an active workflow rule', () => {
    expect(
      inactiveWorkflowRuleAnalyzer.analyze({ packageComponents: [rule('true')] }),
    ).toHaveLength(0);
  });
});

describe('STALE_ANALYZERS', () => {
  it('exports four rules with unique ids', () => {
    expect(STALE_ANALYZERS).toHaveLength(4);
    expect(new Set(STALE_ANALYZERS.map((a) => a.id)).size).toBe(4);
  });
});
