import { describe, expect, it } from 'vitest';
import {
  isValidId18,
  findHardcodedIds,
  apexHardcodedIdAnalyzer,
  validationRuleHardcodedIdAnalyzer,
  formulaFieldHardcodedIdAnalyzer,
  flowHardcodedIdAnalyzer,
  HARDCODED_ID_ANALYZERS,
} from '../../src/analyzers/hardcoded-id-rules.js';
import type { AnalysisContext, Component } from '../../src/types/analyzer.js';

describe('isValidId18 (Salesforce 18-char case-checksum)', () => {
  it('validates real 18-char ids read from ARM DEV via read-only SOQL (Organization.Id, ApexClass.Id, User.Id)', () => {
    // Captured 2026-09-07 via `sf data query --target-org "ARM DEV"` — see
    // the PR body for the exact commands. These are genuine ids from the
    // real org, used only to prove the checksum algorithm against
    // Salesforce's actual id-generation scheme, not to assert anything
    // about their referents.
    expect(isValidId18('00Dd200000mFdJxEAK')).toBe(true); // Organization
    expect(isValidId18('01pd200000O9aAlAAJ')).toBe(true); // ApexClass (ChangePasswordController)
    expect(isValidId18('005d200000RdqDhAAJ')).toBe(true); // User
  });

  it('rejects a single-character tamper of a valid id (proves the checksum actually discriminates, not just length/charset)', () => {
    expect(isValidId18('00Dd200000mFdJxEAX')).toBe(false);
  });

  it('rejects an arbitrary 18-char alnum string that is not a real Salesforce id', () => {
    expect(isValidId18('ABCDEFGHIJKLMNOPQR')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidId18('00Dd200000mFdJx')).toBe(false);
  });
});

describe('findHardcodedIds', () => {
  it('finds a checksum-valid 18-char id embedded in a larger string', () => {
    expect(findHardcodedIds("Id x = '00Dd200000mFdJxEAK';")).toEqual(['00Dd200000mFdJxEAK']);
  });

  it('finds a 15-char id only when its prefix is a known standard-object prefix', () => {
    expect(findHardcodedIds("String accountId = '001000000000001';")).toEqual(['001000000000001']);
  });

  it('does not flag a 15-char string with an unrecognized prefix (avoids false positives on arbitrary identifiers/hashes)', () => {
    expect(findHardcodedIds("String token = 'zzz000000000001';")).toEqual([]);
  });

  it('does not flag ordinary code with no id-shaped literals', () => {
    expect(findHardcodedIds('public class Foo { Integer x = 1; }')).toEqual([]);
  });

  it('dedupes repeated occurrences of the same id', () => {
    const text = "'00Dd200000mFdJxEAK' and again '00Dd200000mFdJxEAK'";
    expect(findHardcodedIds(text)).toEqual(['00Dd200000mFdJxEAK']);
  });
});

describe('hardcoded-id/apex-body', () => {
  it('flags a hardcoded RecordType-style id literal in an Apex class body', () => {
    const component: Component = {
      key: { type: 'ApexClass', fullName: 'OrderHandler' },
      path: 'classes/OrderHandler.cls',
      content: `public class OrderHandler {\n    Id rtId = '01pd200000O9aAlAAJ';\n}`,
    };
    const ctx: AnalysisContext = { packageComponents: [component] };
    const findings = apexHardcodedIdAnalyzer.analyze(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('01pd200000O9aAlAAJ');
    expect(findings[0]!.recommendation).toMatch(/SOQL|Custom Metadata|Custom Setting/);
  });

  it('does not flag Apex with no id-shaped literals', () => {
    const component: Component = {
      key: { type: 'ApexClass', fullName: 'Clean' },
      path: 'classes/Clean.cls',
      content: 'public class Clean { public Integer add(Integer a, Integer b) { return a + b; } }',
    };
    expect(apexHardcodedIdAnalyzer.analyze({ packageComponents: [component] })).toHaveLength(0);
  });
});

describe('hardcoded-id/validation-rule-formula', () => {
  it('flags a hardcoded id inside errorConditionFormula', () => {
    const component: Component = {
      key: { type: 'ValidationRule', fullName: 'Account.My_Rule' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <errorConditionFormula>RecordTypeId = '01pd200000O9aAlAAJ'</errorConditionFormula>
    <errorMessage>Nope.</errorMessage>
</ValidationRule>`,
    };
    expect(
      validationRuleHardcodedIdAnalyzer.analyze({ packageComponents: [component] }),
    ).toHaveLength(1);
  });
});

describe('hardcoded-id/formula-field', () => {
  it('flags a hardcoded id inside a formula field', () => {
    const component: Component = {
      key: { type: 'CustomField', fullName: 'Account.Computed__c', parentFullName: 'Account' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Computed__c</fullName>
    <formula>IF(RecordTypeId = '01pd200000O9aAlAAJ', 1, 0)</formula>
    <type>Number</type>
</CustomField>`,
    };
    expect(
      formulaFieldHardcodedIdAnalyzer.analyze({ packageComponents: [component] }),
    ).toHaveLength(1);
  });
});

describe('hardcoded-id/flow-literal-value', () => {
  it('flags a hardcoded id inside a Flow literal stringValue, wherever it is nested', () => {
    const component: Component = {
      key: { type: 'Flow', fullName: 'My_Flow' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Flow</label>
    <status>Active</status>
    <assignments>
        <name>Set_Owner</name>
        <assignmentItems>
            <assignToReference>myVar.OwnerId</assignToReference>
            <value>
                <stringValue>00Dd200000mFdJxEAK</stringValue>
            </value>
        </assignmentItems>
    </assignments>
</Flow>`,
    };
    const findings = flowHardcodedIdAnalyzer.analyze({ packageComponents: [component] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('00Dd200000mFdJxEAK');
  });

  it('does not flag a Flow with only structural values (names, labels, references)', () => {
    const component: Component = {
      key: { type: 'Flow', fullName: 'Clean_Flow' },
      path: 'x',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Clean Flow</label>
    <status>Active</status>
    <variables>
        <name>amount</name>
        <dataType>Currency</dataType>
    </variables>
</Flow>`,
    };
    expect(flowHardcodedIdAnalyzer.analyze({ packageComponents: [component] })).toHaveLength(0);
  });
});

describe('HARDCODED_ID_ANALYZERS', () => {
  it('exports six rules with unique ids', () => {
    expect(HARDCODED_ID_ANALYZERS).toHaveLength(6);
    expect(new Set(HARDCODED_ID_ANALYZERS.map((a) => a.id)).size).toBe(6);
  });
});
