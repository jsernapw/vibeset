import { describe, expect, it } from 'vitest';
import {
  deletingReferencedComponentAnalyzer,
  deletingFieldReferencedByInPackageLayoutAnalyzer,
  DESTRUCTIVE_ANALYZERS,
} from '../../src/analyzers/destructive-rules.js';
import type { AnalysisContext, Component } from '../../src/types/analyzer.js';
import { FakeDependencyGraph } from './fake-dependency-graph.js';

describe('destructive/deleting-referenced-component', () => {
  const analyzer = deletingReferencedComponentAnalyzer;

  it('flags deleting a field a Layout still references, per the dependency graph', () => {
    const graph = new FakeDependencyGraph();
    const fieldKey = {
      type: 'CustomField',
      fullName: 'Account.Old__c',
      parentFullName: 'Account',
    } as const;
    const layoutKey = { type: 'Layout', fullName: 'Account-Account Layout' } as const;
    graph.addEdge(layoutKey, fieldKey);
    const ctx: AnalysisContext = {
      packageComponents: [],
      destructiveComponents: [fieldKey],
      dependencyGraph: graph,
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.relatedKeys).toEqual([layoutKey]);
  });

  it('does not flag when nothing references the deleted component', () => {
    const graph = new FakeDependencyGraph();
    const fieldKey = {
      type: 'CustomField',
      fullName: 'Account.Unused__c',
      parentFullName: 'Account',
    } as const;
    const ctx: AnalysisContext = {
      packageComponents: [],
      destructiveComponents: [fieldKey],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not count a dependent that is itself also being deleted in the same package', () => {
    const graph = new FakeDependencyGraph();
    const fieldKey = {
      type: 'CustomField',
      fullName: 'Account.Old__c',
      parentFullName: 'Account',
    } as const;
    const layoutKey = { type: 'Layout', fullName: 'Account-Account Layout' } as const;
    graph.addEdge(layoutKey, fieldKey);
    const ctx: AnalysisContext = {
      packageComponents: [],
      destructiveComponents: [fieldKey, layoutKey],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when no dependency graph is supplied', () => {
    const fieldKey = {
      type: 'CustomField',
      fullName: 'Account.Old__c',
      parentFullName: 'Account',
    } as const;
    const ctx: AnalysisContext = { packageComponents: [], destructiveComponents: [fieldKey] };
    expect(analyzer.appliesTo?.(ctx)).toBe(false);
  });

  it('groups multiple referencing types in one finding', () => {
    const graph = new FakeDependencyGraph();
    const fieldKey = {
      type: 'CustomField',
      fullName: 'Account.Old__c',
      parentFullName: 'Account',
    } as const;
    graph.addEdge({ type: 'Layout', fullName: 'Account-Account Layout' }, fieldKey);
    graph.addEdge({ type: 'ApexClass', fullName: 'AccountService' }, fieldKey);
    const ctx: AnalysisContext = {
      packageComponents: [],
      destructiveComponents: [fieldKey],
      dependencyGraph: graph,
    };
    const [finding] = analyzer.analyze(ctx);
    expect(finding!.relatedKeys).toHaveLength(2);
    expect(finding!.detail).toContain('Layout');
    expect(finding!.detail).toContain('ApexClass');
  });
});

describe('destructive/deleting-field-referenced-by-inpackage-layout', () => {
  const analyzer = deletingFieldReferencedByInPackageLayoutAnalyzer;

  function layoutWithField(field: string): Component {
    return {
      key: { type: 'Layout', fullName: 'Account-Account Layout' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Info</label>
        <layoutColumns>
            <layoutItems>
                <field>${field}</field>
                <behavior>Edit</behavior>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
</Layout>`,
    };
  }

  it('flags a field deletion still shown on a Layout in the same package — no dependency graph needed', () => {
    const ctx: AnalysisContext = {
      packageComponents: [layoutWithField('Old__c')],
      destructiveComponents: [
        { type: 'CustomField', fullName: 'Account.Old__c', parentFullName: 'Account' },
      ],
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('does not flag a field deletion the in-package layout does not reference', () => {
    const ctx: AnalysisContext = {
      packageComponents: [layoutWithField('Unrelated__c')],
      destructiveComponents: [
        { type: 'CustomField', fullName: 'Account.Old__c', parentFullName: 'Account' },
      ],
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not fire when there is no Layout in the package', () => {
    const ctx: AnalysisContext = {
      packageComponents: [],
      destructiveComponents: [
        { type: 'CustomField', fullName: 'Account.Old__c', parentFullName: 'Account' },
      ],
    };
    expect(analyzer.appliesTo?.(ctx)).toBe(false);
  });
});

describe('DESTRUCTIVE_ANALYZERS', () => {
  it('exports two rules with unique ids', () => {
    expect(DESTRUCTIVE_ANALYZERS).toHaveLength(2);
    expect(new Set(DESTRUCTIVE_ANALYZERS.map((a) => a.id)).size).toBe(2);
  });
});
