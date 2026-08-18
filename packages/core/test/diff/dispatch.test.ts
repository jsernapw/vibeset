import { describe, expect, it } from 'vitest';
import { diffComponent } from '../../src/diff/dispatch.js';
import { FULL_COVERAGE_CONTEXT, type ProfileDiffContext } from '../../src/diff/profiles.js';

const withClass = (name: string, enabled = 'true') => `
  <classAccesses>
    <apexClass>${name}</apexClass>
    <enabled>${enabled}</enabled>
  </classAccesses>`;

function profileXml(...body: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${body.join('')}\n</Profile>\n`;
}

/**
 * Covers the runtime half of the inverted-default safety fix: `diffComponent`
 * (the entry point virtually everything calls, unlike the lower-level
 * `diffProfileLike`) must fail loudly rather than silently defaulting to
 * full coverage when a Profile/PermissionSet comparison omits
 * `ProfileDiffContext`. See profiles.ts and dispatch.ts for the full hazard
 * writeup: silently defaulting here is what lets a deployment package
 * silently strip real user permissions.
 */
describe('diffComponent — Profile/PermissionSet coverage is required, not defaulted', () => {
  it('throws a descriptive error when comparing two different Profile bodies with no ProfileDiffContext supplied', () => {
    const left = profileXml(withClass('OnlyOnLeft'));
    const right = profileXml();
    expect(() => diffComponent({ type: 'Profile', fullName: 'Admin' }, left, right)).toThrow(
      /requires an explicit ProfileDiffContext/,
    );
  });

  it('throws for PermissionSet too, not just Profile', () => {
    const left = profileXml(withClass('OnlyOnLeft'));
    const right = profileXml();
    expect(() => diffComponent({ type: 'PermissionSet', fullName: 'MyPermSet' }, left, right)).toThrow(
      /requires an explicit ProfileDiffContext/,
    );
  });

  it('does NOT throw for non-Profile-like types when profileContext is omitted — the param is optional and ignored for everything else', () => {
    expect(() =>
      diffComponent(
        { type: 'CustomObject', fullName: 'Account' },
        '<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>A</label></CustomObject>',
        '<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>B</label></CustomObject>',
      ),
    ).not.toThrow();
  });

  it('does NOT throw when both sides hash-equal, even for Profile — the short-circuit never touches profileContext', () => {
    const same = profileXml(withClass('X'));
    expect(() => diffComponent({ type: 'Profile', fullName: 'Admin' }, same, same)).not.toThrow();
  });

  it('does NOT throw when the whole component is added/deleted (one side entirely undefined) — coverage only matters for within-file entry ambiguity', () => {
    const left = profileXml(withClass('X'));
    expect(() => diffComponent({ type: 'Profile', fullName: 'Admin' }, left, undefined)).not.toThrow();
    expect(() => diffComponent({ type: 'Profile', fullName: 'Admin' }, undefined, left)).not.toThrow();
  });

  it('succeeds and reports the naive absence-as-removed result when FULL_COVERAGE_CONTEXT is explicitly opted into', () => {
    const left = profileXml(withClass('OnlyOnLeft'));
    const right = profileXml();
    const result = diffComponent({ type: 'Profile', fullName: 'Admin' }, left, right, FULL_COVERAGE_CONTEXT);
    expect(result.status).toBe('changed');
    const classAccesses = result.entries!.find((e) => e.key === 'classAccesses')!;
    expect(classAccesses.children).toEqual([
      expect.objectContaining({ key: 'OnlyOnLeft', status: 'deleted' }),
    ]);
  });

  it('succeeds and suppresses the ambiguous absence when a computed scoped context is supplied', () => {
    const left = profileXml(withClass('NotRetrieved'));
    const right = profileXml();
    const ctx: ProfileDiffContext = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set() },
    };
    const result = diffComponent({ type: 'Profile', fullName: 'Admin' }, left, right, ctx);
    // The referenced ApexClass was never retrieved on the right — absence
    // there is ambiguous, not a genuine removal, so the whole component
    // must not register as changed purely from that ambiguity.
    expect(result.status).toBe('identical');
  });
});
