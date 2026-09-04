import { describe, expect, it } from 'vitest';
import { mergeProfileLike, requireMergeProfileCoverage, type MergeProfileCoverage } from '../../src/merge/profile-merge.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

const key: ComponentKey = { type: 'Profile', fullName: 'Admin' };

const FULL: MergeProfileCoverage = { left: { mode: 'full' }, right: { mode: 'full' } };

const withClass = (name: string, enabled = 'true') => `
  <classAccesses>
    <apexClass>${name}</apexClass>
    <enabled>${enabled}</enabled>
  </classAccesses>`;

function profileXml(...body: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${body.join('')}\n</Profile>\n`;
}

function classEntry(result: ReturnType<typeof mergeProfileLike>, name: string) {
  const e = result.entries.find((x) => x.path === `classAccesses.${name}`);
  if (!e) throw new Error(`no entry for classAccesses.${name}`);
  return e;
}

describe('mergeProfileLike — requires explicit coverage, no default (the safety invariant)', () => {
  it('throws rather than silently assuming full coverage when coverage is omitted', () => {
    expect(() => requireMergeProfileCoverage(key, undefined)).toThrow(/requires an explicit MergeProfileCoverage/);
  });

  it('passes through valid coverage unchanged', () => {
    expect(requireMergeProfileCoverage(key, FULL)).toBe(FULL);
  });
});

describe('mergeProfileLike — permission grid, two-way', () => {
  it('merges non-overlapping permission edits cleanly (different classes touched by each side)', () => {
    const left = profileXml(withClass('OnlyLeft'));
    const right = profileXml(withClass('OnlyRight'));
    const result = mergeProfileLike(key, { mode: 'two-way', left, right }, FULL);
    expect(classEntry(result, 'OnlyLeft').status).toBe('take-left');
    expect(classEntry(result, 'OnlyRight').status).toBe('take-right');
  });

  it('conflicts when the SAME class access is edited differently on both sides', () => {
    const left = profileXml(withClass('Shared', 'true'));
    const right = profileXml(withClass('Shared', 'false'));
    const result = mergeProfileLike(key, { mode: 'two-way', left, right }, FULL);
    expect(classEntry(result, 'Shared').status).toBe('conflict');
  });

  it('THE CENTRAL HAZARD: never proposes take-right/conflict for an entry absent purely because that side never retrieved it', () => {
    const left = profileXml(withClass('NotRetrieved'));
    const right = profileXml();
    const coverage: MergeProfileCoverage = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set() }, // right's retrieve never touched ApexClass:NotRetrieved
    };
    const result = mergeProfileLike(key, { mode: 'two-way', left, right }, coverage);
    const entry = classEntry(result, 'NotRetrieved');
    expect(entry.status).toBe('unchanged');
    // Resolves to the one side we DO know about (left) — never proposes
    // deleting it just because right's retrieve happened not to cover it.
    expect(entry.resolved).toEqual({ apexClass: 'NotRetrieved', enabled: 'true' });
  });

  it('still reports a genuine two-way difference when the missing side DID cover the ref', () => {
    const left = profileXml(withClass('Retrieved'));
    const right = profileXml();
    const coverage: MergeProfileCoverage = {
      left: { mode: 'full' },
      right: { mode: 'scoped', retrievedComponents: new Set(['ApexClass:Retrieved']) },
    };
    const result = mergeProfileLike(key, { mode: 'two-way', left, right }, coverage);
    expect(classEntry(result, 'Retrieved').status).toBe('take-left');
  });
});

describe('mergeProfileLike — permission grid, three-way', () => {
  it('only conflicts when the SAME permission changed on both sides relative to base', () => {
    const base = profileXml(withClass('A', 'true'), withClass('B', 'true'), withClass('C', 'true'));
    const left = profileXml(withClass('A', 'false'), withClass('B', 'true'), withClass('C', 'true')); // left flips A
    const right = profileXml(withClass('A', 'true'), withClass('B', 'true'), withClass('C', 'false')); // right flips C
    const result = mergeProfileLike(key, { mode: 'three-way', base, left, right }, FULL);

    expect(classEntry(result, 'A').status).toBe('take-left');
    expect(classEntry(result, 'B').status).toBe('unchanged');
    expect(classEntry(result, 'C').status).toBe('take-right');
    expect(result.summary.conflict).toBe(0);
  });

  it('THE CENTRAL HAZARD in three-way: an unretrieved side never manufactures a deletion when the other side did not touch the permission either', () => {
    const base = profileXml(withClass('Sensitive', 'true'));
    const left = profileXml(); // left's retrieve never covered ApexClass:Sensitive
    const right = profileXml(withClass('Sensitive', 'true')); // right unchanged from base
    const coverage: MergeProfileCoverage = {
      left: { mode: 'scoped', retrievedComponents: new Set() },
      right: { mode: 'full' },
    };
    const result = mergeProfileLike(key, { mode: 'three-way', base, left, right }, coverage);
    const entry = classEntry(result, 'Sensitive');
    // A naive 3-way merge would see left's absence as "left deleted it" and
    // right as unchanged, and confidently take-left — deploying a deletion
    // of a permission nobody actually revoked. Must not happen.
    expect(entry.status).toBe('unchanged');
  });

  it('a CONFIRMED deletion on one side, with the other side unchanged, still resolves cleanly', () => {
    const base = profileXml(withClass('Retiring', 'true'));
    const left = profileXml(); // left genuinely deletes it, and DID cover this ref
    const right = profileXml(withClass('Retiring', 'true'));
    const coverage: MergeProfileCoverage = {
      left: { mode: 'scoped', retrievedComponents: new Set(['ApexClass:Retiring']) },
      right: { mode: 'full' },
    };
    const result = mergeProfileLike(key, { mode: 'three-way', base, left, right }, coverage);
    expect(classEntry(result, 'Retiring').status).toBe('take-left');
  });

  it('merges non-ambiguous scalar Profile fields (description) three-way', () => {
    const base = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>Base</description></Profile>\n`;
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>Left edit</description></Profile>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>Base</description></Profile>\n`;
    const result = mergeProfileLike(key, { mode: 'three-way', base, left, right }, FULL);
    const description = result.entries.find((e) => e.path === 'description')!;
    expect(description.status).toBe('take-left');
    expect(description.resolved).toBe('Left edit');
  });

  it('userPermissions are never suppressed by coverage — they are always complete regardless of scoping', () => {
    const base = profileXml(`
  <userPermissions>
    <name>ApiEnabled</name>
    <enabled>true</enabled>
  </userPermissions>`);
    const left = profileXml(); // deleted
    const right = profileXml(); // right also deleted (agrees)
    const coverage: MergeProfileCoverage = {
      left: { mode: 'scoped', retrievedComponents: new Set() }, // no components in scope at all
      right: { mode: 'scoped', retrievedComponents: new Set() },
    };
    const result = mergeProfileLike(key, { mode: 'three-way', base, left, right }, coverage);
    const entry = result.entries.find((e) => e.path === 'userPermissions.ApiEnabled')!;
    // alwaysComplete: true means coverage never suppresses this regardless
    // of scoping — both sides genuinely deleted it, so it's a clean
    // (unchanged/agreed) deletion, not swallowed as "ambiguous".
    expect(entry.status).toBe('unchanged');
    expect(entry.resolved).toBeUndefined();
  });
});
