import { describe, expect, it } from 'vitest';
import { extractLayoutFieldEdges, extractProfileLikeEdges } from '../../src/dependencies/supplement.js';

const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OtherController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <pageAccesses>
        <apexPage>MyPage</apexPage>
        <enabled>true</enabled>
    </pageAccesses>
    <fieldPermissions>
        <field>Account.Custom_Field__c</field>
        <editable>false</editable>
        <readable>true</readable>
    </fieldPermissions>
    <objectPermissions>
        <object>Account</object>
        <allowRead>true</allowRead>
    </objectPermissions>
    <recordTypeVisibilities>
        <recordType>Account.Business</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
    <layoutAssignments>
        <layout>Account-Account Layout</layout>
    </layoutAssignments>
    <tabVisibilities>
        <tab>Custom_Tab__c</tab>
        <visibility>DefaultOn</visibility>
    </tabVisibilities>
    <userPermissions>
        <name>ApiEnabled</name>
        <enabled>true</enabled>
    </userPermissions>
</Profile>
`;

describe('extractProfileLikeEdges', () => {
  it('extracts one edge per grant type, tagged provenance: supplemented, supplementKind: profile-grant', () => {
    const edges = extractProfileLikeEdges('Profile', 'Admin', PROFILE_XML);

    expect(edges).toEqual(
      expect.arrayContaining([
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'ApexClass', toFullName: 'MyController', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'ApexClass', toFullName: 'OtherController', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'ApexPage', toFullName: 'MyPage', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'CustomField', toFullName: 'Account.Custom_Field__c', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'CustomObject', toFullName: 'Account', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'RecordType', toFullName: 'Account.Business', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'Layout', toFullName: 'Account-Account Layout', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Profile', fromFullName: 'Admin', toType: 'CustomTab', toFullName: 'Custom_Tab__c', provenance: 'supplemented', supplementKind: 'profile-grant', fromNamespace: undefined, toNamespace: undefined },
      ]),
    );
    // userPermissions must never appear as a component reference.
    expect(edges.some((e) => e.toType === 'ApiEnabled' || e.toFullName === 'ApiEnabled')).toBe(false);
    expect(edges).toHaveLength(8);
  });

  it('tags PermissionSet edges with supplementKind: permission-set-grant instead', () => {
    const xml = PROFILE_XML.replace(/Profile/g, 'PermissionSet');
    const edges = extractProfileLikeEdges('PermissionSet', 'My_Perm_Set', xml);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.supplementKind).toBe('permission-set-grant');
      expect(e.fromType).toBe('PermissionSet');
    }
  });

  it('returns no edges for a Profile with no grant sections', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Profile xmlns="http://soap.sforce.com/2006/04/metadata"><userLicense>Salesforce</userLicense></Profile>`;
    expect(extractProfileLikeEdges('Profile', 'Minimal', xml)).toEqual([]);
  });
});

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Information</label>
        <layoutColumns>
            <layoutItems>
                <field>Custom_Field__c</field>
                <behavior>Edit</behavior>
            </layoutItems>
            <layoutItems>
                <field>Name</field>
                <behavior>Required</behavior>
            </layoutItems>
        </layoutColumns>
        <layoutColumns>
            <layoutItems>
                <field>Description__c</field>
                <behavior>Edit</behavior>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
    <relatedLists>
        <fields>ACTIVITY.TASK</fields>
        <relatedList>RelatedContactList</relatedList>
    </relatedLists>
</Layout>
`;

describe('extractLayoutFieldEdges', () => {
  it('extracts one edge per field placement across sections/columns, tagged layout-field-reference', () => {
    const edges = extractLayoutFieldEdges('Account-Account Layout', LAYOUT_XML);

    expect(edges).toEqual(
      expect.arrayContaining([
        { fromType: 'Layout', fromFullName: 'Account-Account Layout', toType: 'CustomField', toFullName: 'Custom_Field__c', provenance: 'supplemented', supplementKind: 'layout-field-reference', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Layout', fromFullName: 'Account-Account Layout', toType: 'CustomField', toFullName: 'Name', provenance: 'supplemented', supplementKind: 'layout-field-reference', fromNamespace: undefined, toNamespace: undefined },
        { fromType: 'Layout', fromFullName: 'Account-Account Layout', toType: 'CustomField', toFullName: 'Description__c', provenance: 'supplemented', supplementKind: 'layout-field-reference', fromNamespace: undefined, toNamespace: undefined },
      ]),
    );
  });

  it('de-duplicates the same field referenced more than once', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <layoutColumns>
            <layoutItems><field>Name</field></layoutItems>
        </layoutColumns>
    </layoutSections>
    <relatedLists>
        <fields>Name</fields>
    </relatedLists>
</Layout>`;
    const edges = extractLayoutFieldEdges('Account-Account Layout', xml);
    expect(edges).toHaveLength(1);
  });

  it('returns no edges for a Layout with no field items (e.g. only buttons)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Layout xmlns="http://soap.sforce.com/2006/04/metadata"><showEmailCheckbox>false</showEmailCheckbox></Layout>`;
    expect(extractLayoutFieldEdges('Account-Account Layout', xml)).toEqual([]);
  });
});
