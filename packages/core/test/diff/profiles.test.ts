import { describe, expect, it } from 'vitest';
import {
  diffProfileLike,
  FULL_COVERAGE_CONTEXT,
  type ProfileDiffContext,
} from '../../src/diff/profiles.js';

const withClass = (name: string, enabled = 'true') => `
  <classAccesses>
    <apexClass>${name}</apexClass>
    <enabled>${enabled}</enabled>
  </classAccesses>`;

function profileXml(...body: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${body.join('')}\n</Profile>\n`;
}

// `ctx` is now a required parameter of `diffProfileLike` (no default) — the
// inverted-default safety fix. Every call in this file below passes it
// explicitly; the type signature itself is what proves omitting it is a
// compile-time error now (see `pnpm --filter @vibeset/core typecheck`).
// The runtime half of the same guarantee — `diffComponent` throwing instead
// of silently defaulting when a Profile/PermissionSet context is omitted —
// is covered in `test/diff/dispatch.test.ts`.
describe('diffProfileLike — absent-vs-removed handling', () => {
  it('reports naive absence-as-removed when FULL_COVERAGE_CONTEXT is explicitly opted into', () => {
    const left = profileXml(withClass('OnlyOnLeft'));
    const right = profileXml();
    const entries = diffProfileLike('Profile', left, right, FULL_COVERAGE_CONTEXT);
    const classAccesses = entries.find((e) => e.key === 'classAccesses')!;
    expect(classAccesses.children).toEqual([
      expect.objectContaining({ key: 'OnlyOnLeft', status: 'deleted' }),
    ]);
  });

  it('suppresses a missing entry to identical when the referenced component was not in the retrieve package on that side', () => {
    const left = profileXml(withClass('NotRetrieved'));
    const right = profileXml();
    const ctx: ProfileDiffContext = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set() }, // right's retrieve never touched ApexClass:NotRetrieved
    };
    const entries = diffProfileLike('Profile', left, right, ctx);
    const classAccesses = entries.find((e) => e.key === 'classAccesses')!;
    const entry = classAccesses.children!.find((e) => e.key === 'NotRetrieved')!;
    expect(entry.status).toBe('identical');
    // The whole component's diff must not register a change purely from
    // an ambiguous absence — this is the exact scenario that would
    // otherwise produce a deployment that strips access nobody touched.
    expect(classAccesses.status).toBe('identical');
  });

  it('still reports a genuine removal when the component WAS retrieved on the scoped side but the permission entry is truly gone', () => {
    const left = profileXml(withClass('Retrieved'));
    const right = profileXml();
    const ctx: ProfileDiffContext = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set(['ApexClass:Retrieved']) },
    };
    const entries = diffProfileLike('Profile', left, right, ctx);
    const classAccesses = entries.find((e) => e.key === 'classAccesses')!;
    expect(classAccesses.children).toEqual([
      expect.objectContaining({ key: 'Retrieved', status: 'deleted' }),
    ]);
  });

  it('never suppresses userPermissions — they are always complete regardless of scoping', () => {
    const left = profileXml(`
  <userPermissions>
    <name>ApiEnabled</name>
    <enabled>true</enabled>
  </userPermissions>`);
    const right = profileXml();
    const ctx: ProfileDiffContext = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set() }, // no components at all in scope
    };
    const entries = diffProfileLike('Profile', left, right, ctx);
    const userPerms = entries.find((e) => e.key === 'userPermissions')!;
    expect(userPerms.children).toEqual([
      expect.objectContaining({ key: 'ApiEnabled', status: 'deleted' }),
    ]);
  });

  it('diffs non-ambiguous scalar Profile fields (description, custom, userLicense) — previously silently invisible', () => {
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>Old</description><custom>true</custom><userLicense>Salesforce</userLicense></Profile>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>New</description><custom>true</custom><userLicense>Salesforce</userLicense></Profile>\n`;
    const entries = diffProfileLike('Profile', left, right, FULL_COVERAGE_CONTEXT);
    const description = entries.find((e) => e.key === 'description')!;
    expect(description).toEqual(
      expect.objectContaining({ status: 'changed', before: 'Old', after: 'New' }),
    );
    const userLicense = entries.find((e) => e.key === 'userLicense')!;
    expect(userLicense.status).toBe('identical');
  });

  it('diffs non-ambiguous scalar PermissionSet fields (description, label, license, hasActivationRequired)', () => {
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>Old Label</label></PermissionSet>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>New Label</label></PermissionSet>\n`;
    const entries = diffProfileLike('PermissionSet', left, right, FULL_COVERAGE_CONTEXT);
    const label = entries.find((e) => e.key === 'label')!;
    expect(label).toEqual(
      expect.objectContaining({ status: 'changed', before: 'Old Label', after: 'New Label' }),
    );
  });

  it('produces a full addressable grid including identical entries, not just deltas', () => {
    const left = profileXml(withClass('A'), withClass('B'));
    const right = profileXml(withClass('A'), withClass('B', 'false'));
    const entries = diffProfileLike('Profile', left, right, FULL_COVERAGE_CONTEXT);
    const classAccesses = entries.find((e) => e.key === 'classAccesses')!;
    expect(classAccesses.children).toHaveLength(2);
    expect(classAccesses.children!.find((e) => e.key === 'A')!.status).toBe('identical');
    expect(classAccesses.children!.find((e) => e.key === 'B')!.status).toBe('changed');
  });
});
