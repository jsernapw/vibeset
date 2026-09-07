import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_ANALYZERS,
  layoutMissingFieldAnalyzer,
  layoutMissingRecordTypeAnalyzer,
  validationRuleMissingFieldAnalyzer,
  formulaFieldMissingFieldAnalyzer,
  flowMissingApexActionAnalyzer,
  quickActionMissingFieldAnalyzer,
} from '../../src/analyzers/dependency-rules.js';
import type { AnalysisContext, Component } from '../../src/types/analyzer.js';
import { FakeDependencyGraph } from './fake-dependency-graph.js';

/** Real shape verified against `test/fixtures/layout-item-behavior-changed`. */
function layoutComponent(fullName: string, fieldApiName: string): Component {
  return {
    key: { type: 'Layout', fullName },
    path: `layouts/${fullName}.layout-meta.xml`,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Information</label>
        <layoutColumns>
            <layoutItems>
                <field>${fieldApiName}</field>
                <behavior>Edit</behavior>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
</Layout>`,
  };
}

describe('dependencies/layout-missing-field', () => {
  const analyzer = layoutMissingFieldAnalyzer;

  it('flags a custom field the Layout references that is confirmed absent from the target and not in the package', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Missing__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Missing__c')],
      dependencyGraph: graph,
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.relatedKeys).toEqual([
      { type: 'CustomField', fullName: 'Account.Missing__c', parentFullName: 'Account' },
    ]);
  });

  it('does not flag when the field is also in the package', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Present__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [
        layoutComponent('Account-Account Layout', 'Present__c'),
        {
          key: { type: 'CustomField', fullName: 'Account.Present__c', parentFullName: 'Account' },
          path: 'x',
          content: '<CustomField/>',
        },
      ],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when existence is unknown (not indexed) rather than assuming absence', () => {
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Unknown__c')],
      dependencyGraph: new FakeDependencyGraph(),
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when the dependency graph is not supplied at all', () => {
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Whatever__c')],
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when the field is confirmed present in the target', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Existing__c' }, true);
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Existing__c')],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('ignores standard fields (no __c suffix) entirely', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Name' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Name')],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('autofix proposes adding the missing field to the package', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Missing__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [layoutComponent('Account-Account Layout', 'Missing__c')],
      dependencyGraph: graph,
    };
    const [finding] = analyzer.analyze(ctx);
    const mutations = analyzer.autofix?.(ctx, finding!) ?? [];
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.addToPackage).toEqual([
      { type: 'CustomField', fullName: 'Account.Missing__c', parentFullName: 'Account' },
    ]);
  });
});

describe('dependencies/layout-missing-recordtype', () => {
  function layoutWithAssignment(recordType: string): Component {
    return {
      key: { type: 'Layout', fullName: 'Account-Account Layout' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutAssignments>
        <layout>Account-Account Layout</layout>
        <recordType>${recordType}</recordType>
    </layoutAssignments>
</Layout>`,
    };
  }

  it('flags a confirmed-missing record type assignment', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'RecordType', fullName: 'Account.Enterprise' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [layoutWithAssignment('Account.Enterprise')],
      dependencyGraph: graph,
    };
    expect(layoutMissingRecordTypeAnalyzer.analyze(ctx)).toHaveLength(1);
  });

  it('does not flag when unknown', () => {
    const ctx: AnalysisContext = {
      packageComponents: [layoutWithAssignment('Account.Enterprise')],
      dependencyGraph: new FakeDependencyGraph(),
    };
    expect(layoutMissingRecordTypeAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('dependencies/validation-rule-missing-field', () => {
  function validationRule(fullName: string, formula: string): Component {
    return {
      key: { type: 'ValidationRule', fullName },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <errorConditionFormula>${formula}</errorConditionFormula>
    <errorMessage>Nope.</errorMessage>
</ValidationRule>`,
    };
  }

  it('flags a formula field reference confirmed absent', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Missing__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [validationRule('Account.My_Rule', 'ISBLANK(Missing__c)')],
      dependencyGraph: graph,
    };
    const findings = validationRuleMissingFieldAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.key).toEqual({ type: 'ValidationRule', fullName: 'Account.My_Rule' });
  });

  it('does not treat a dotted relationship traversal tail as a same-object field', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Region__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [validationRule('Account.My_Rule', 'ISBLANK(Owner.Region__c)')],
      dependencyGraph: graph,
    };
    expect(validationRuleMissingFieldAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('dependencies/formula-field-missing-field', () => {
  function formulaField(objectApiName: string, fieldApiName: string, formula: string): Component {
    return {
      key: {
        type: 'CustomField',
        fullName: `${objectApiName}.${fieldApiName}`,
        parentFullName: objectApiName,
      },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${fieldApiName}</fullName>
    <formula>${formula}</formula>
    <type>Text</type>
</CustomField>`,
    };
  }

  it('flags a formula referencing a missing sibling field', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Missing__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [formulaField('Account', 'Computed__c', 'Missing__c + 1')],
      dependencyGraph: graph,
    };
    expect(formulaFieldMissingFieldAnalyzer.analyze(ctx)).toHaveLength(1);
  });

  it('does not flag a formula that only references itself', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Self__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [formulaField('Account', 'Self__c', 'Self__c')],
      dependencyGraph: graph,
    };
    expect(formulaFieldMissingFieldAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('dependencies/flow-missing-apex-action', () => {
  function flowWithApexAction(actionName: string): Component {
    return {
      key: { type: 'Flow', fullName: 'My_Flow' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Flow</label>
    <status>Active</status>
    <actionCalls>
        <name>Call_Apex</name>
        <actionName>${actionName}</actionName>
        <actionType>apex</actionType>
    </actionCalls>
</Flow>`,
    };
  }

  it('flags a Flow apex action-call confirmed missing', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'ApexClass', fullName: 'MissingInvocable' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [flowWithApexAction('MissingInvocable')],
      dependencyGraph: graph,
    };
    expect(flowMissingApexActionAnalyzer.analyze(ctx)).toHaveLength(1);
  });

  it('does not flag when the Apex class is in the package', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'ApexClass', fullName: 'Present' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [
        flowWithApexAction('Present'),
        {
          key: { type: 'ApexClass', fullName: 'Present' },
          path: 'x',
          content: 'public class Present{}',
        },
      ],
      dependencyGraph: graph,
    };
    expect(flowMissingApexActionAnalyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('dependencies/quickaction-missing-field', () => {
  function quickAction(targetObject: string, field: string): Component {
    return {
      key: { type: 'QuickAction', fullName: `${targetObject}.Update_Deal` },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<QuickAction xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Update Deal</label>
    <type>Update</type>
    <targetObject>${targetObject}</targetObject>
    <fieldOverrides>
        <field>${field}</field>
        <formula>0</formula>
    </fieldOverrides>
</QuickAction>`,
    };
  }

  it('flags a field override referencing a confirmed-missing field', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Deal__c.Missing__c' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [quickAction('Deal__c', 'Missing__c')],
      dependencyGraph: graph,
    };
    expect(quickActionMissingFieldAnalyzer.analyze(ctx)).toHaveLength(1);
  });
});

describe('DEPENDENCY_ANALYZERS', () => {
  it('exports exactly the six dependency rules, each with a unique id', () => {
    expect(DEPENDENCY_ANALYZERS).toHaveLength(6);
    expect(new Set(DEPENDENCY_ANALYZERS.map((a) => a.id)).size).toBe(6);
  });
});
