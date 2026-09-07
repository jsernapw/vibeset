import { describe, expect, it } from 'vitest';
import {
  permissionGrantsNonexistentTargetAnalyzer,
  PERMISSION_ANALYZERS,
} from '../../src/analyzers/permission-rules.js';
import type { AnalysisContext, Component } from '../../src/types/analyzer.js';
import { FakeDependencyGraph } from './fake-dependency-graph.js';

/** Real shape verified against `test/fixtures/profile-field-permission-changed`. */
function profileWithClassAccess(apexClass: string, enabled: boolean): Component {
  return {
    key: { type: 'Profile', fullName: 'Admin' },
    path: 'profiles/Admin.profile-meta.xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>${apexClass}</apexClass>
        <enabled>${enabled}</enabled>
    </classAccesses>
</Profile>`,
  };
}

describe('permissions/grants-nonexistent-target', () => {
  const analyzer = permissionGrantsNonexistentTargetAnalyzer;

  it('flags a Profile granting class access to an Apex class confirmed absent from the target', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'ApexClass', fullName: 'MissingController' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [profileWithClassAccess('MissingController', true)],
      dependencyGraph: graph,
    };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.relatedKeys).toEqual([
      { type: 'ApexClass', fullName: 'MissingController' },
    ]);
  });

  it('does NOT flag a DENY entry (enabled=false) referencing a missing class — absence there is a no-op, not a hazard', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'ApexClass', fullName: 'MissingController' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [profileWithClassAccess('MissingController', false)],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when existence is unknown — the absent-vs-not-retrieved discipline from diff/profiles.ts', () => {
    const ctx: AnalysisContext = {
      packageComponents: [profileWithClassAccess('SomeClass', true)],
      dependencyGraph: new FakeDependencyGraph(),
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('does not flag when the class is also present in the package', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'ApexClass', fullName: 'Present' }, false);
    const ctx: AnalysisContext = {
      packageComponents: [
        profileWithClassAccess('Present', true),
        {
          key: { type: 'ApexClass', fullName: 'Present' },
          path: 'x',
          content: 'public class Present{}',
        },
      ],
      dependencyGraph: graph,
    };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });

  it('flags a PermissionSet fieldPermissions grant to a confirmed-missing custom field', () => {
    const graph = new FakeDependencyGraph();
    graph.setExists({ type: 'CustomField', fullName: 'Account.Missing__c' }, false);
    const permSet: Component = {
      key: { type: 'PermissionSet', fullName: 'My_Perm_Set' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions>
        <field>Account.Missing__c</field>
        <readable>true</readable>
        <editable>false</editable>
    </fieldPermissions>
</PermissionSet>`,
    };
    const ctx: AnalysisContext = { packageComponents: [permSet], dependencyGraph: graph };
    const findings = analyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.relatedKeys).toEqual([
      { type: 'CustomField', fullName: 'Account.Missing__c', parentFullName: 'Account' },
    ]);
  });

  it('does not fire when there is no dependency graph at all', () => {
    const ctx: AnalysisContext = { packageComponents: [profileWithClassAccess('Anything', true)] };
    expect(analyzer.analyze(ctx)).toHaveLength(0);
  });
});

describe('PERMISSION_ANALYZERS', () => {
  it('exports the permission rule(s) with unique ids', () => {
    expect(PERMISSION_ANALYZERS.length).toBeGreaterThan(0);
    expect(new Set(PERMISSION_ANALYZERS.map((a) => a.id)).size).toBe(PERMISSION_ANALYZERS.length);
  });
});
