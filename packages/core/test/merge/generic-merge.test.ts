import { describe, expect, it } from 'vitest';
import { mergeGeneric } from '../../src/merge/generic-merge.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

const key: ComponentKey = { type: 'CustomObject', fullName: 'Account' };

function customObject(...fields: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label>${fields.join('')}\n</CustomObject>\n`;
}

function field(name: string, type: string, extra = ''): string {
  return `\n  <fields><fullName>${name}</fullName><type>${type}</type>${extra}</fields>`;
}

function entry(result: ReturnType<typeof mergeGeneric>, path: string) {
  const e = result.entries.find((x) => x.path === path);
  if (!e) throw new Error(`no merge entry at path ${path} (have: ${result.entries.map((x) => x.path).join(', ')})`);
  return e;
}

describe('mergeGeneric — CustomObject, two-way (no base)', () => {
  it('merges non-overlapping edits cleanly: two people editing different fields need no decision', () => {
    const left = customObject(field('FieldA__c', 'Text'));
    const right = customObject(field('FieldB__c', 'Checkbox'));
    const result = mergeGeneric(key, { mode: 'two-way', left, right });

    expect(entry(result, 'fields.FieldA__c').status).toBe('take-left');
    expect(entry(result, 'fields.FieldB__c').status).toBe('take-right');
    // label is identical on both sides — genuinely unchanged, not a decision.
    expect(entry(result, 'label').status).toBe('unchanged');
    expect(result.summary.conflict).toBe(0);
  });

  it('reports a conflict — not a wall of XML, just the one row — when the SAME field is edited differently on both sides', () => {
    const left = customObject(field('Shared__c', 'Text'));
    const right = customObject(field('Shared__c', 'Checkbox'));
    const result = mergeGeneric(key, { mode: 'two-way', left, right });

    const shared = entry(result, 'fields.Shared__c');
    expect(shared.status).toBe('conflict');
    expect(shared.resolved).toBeUndefined();
    expect(shared.left).toEqual({ fullName: 'Shared__c', type: 'Text' });
    expect(shared.right).toEqual({ fullName: 'Shared__c', type: 'Checkbox' });
    expect(result.summary.conflict).toBe(1);
  });

  it('treats identical additions on both sides as a clean, non-conflicting merge', () => {
    const left = customObject(field('New__c', 'Text'));
    const right = customObject(field('New__c', 'Text'));
    const result = mergeGeneric(key, { mode: 'two-way', left, right });
    expect(entry(result, 'fields.New__c').status).toBe('unchanged');
  });
});

describe('mergeGeneric — CustomObject, three-way (base supplied)', () => {
  it('only conflicts on entries changed on BOTH sides — everything else merges automatically', () => {
    const base = customObject(field('Untouched__c', 'Text'), field('OnlyLeftChanges__c', 'Text'), field('OnlyRightChanges__c', 'Text'));
    const left = customObject(field('Untouched__c', 'Text'), field('OnlyLeftChanges__c', 'LongTextArea'), field('OnlyRightChanges__c', 'Text'));
    const right = customObject(field('Untouched__c', 'Text'), field('OnlyLeftChanges__c', 'Text'), field('OnlyRightChanges__c', 'Checkbox'));
    const result = mergeGeneric(key, { mode: 'three-way', base, left, right });

    expect(entry(result, 'fields.Untouched__c').status).toBe('unchanged');
    expect(entry(result, 'fields.OnlyLeftChanges__c').status).toBe('take-left');
    expect(entry(result, 'fields.OnlyRightChanges__c').status).toBe('take-right');
    expect(result.summary.conflict).toBe(0);
  });

  it('reports a conflict when the same field is changed on both sides to DIFFERENT values', () => {
    const base = customObject(field('Shared__c', 'Text'));
    const left = customObject(field('Shared__c', 'LongTextArea'));
    const right = customObject(field('Shared__c', 'Checkbox'));
    const result = mergeGeneric(key, { mode: 'three-way', base, left, right });

    const shared = entry(result, 'fields.Shared__c');
    expect(shared.status).toBe('conflict');
    expect(shared.base).toEqual({ fullName: 'Shared__c', type: 'Text' });
  });

  it('deletion-vs-edit is a conflict, never a silently-applied delete or a silently-kept edit', () => {
    const base = customObject(field('Contested__c', 'Text'));
    const leftDeletes = customObject(); // Contested__c removed
    const rightEdits = customObject(field('Contested__c', 'LongTextArea'));
    const result = mergeGeneric(key, { mode: 'three-way', base, left: leftDeletes, right: rightEdits });

    const contested = entry(result, 'fields.Contested__c');
    expect(contested.status).toBe('conflict');
    expect(contested.left).toBeUndefined();
    expect(contested.right).toEqual({ fullName: 'Contested__c', type: 'LongTextArea' });
  });

  it('additions on both sides: identical content converges cleanly, different content conflicts', () => {
    const base = customObject(); // neither field exists at base
    const bothAddSame = customObject(field('Added__c', 'Text'));
    const result1 = mergeGeneric(key, {
      mode: 'three-way',
      base,
      left: bothAddSame,
      right: bothAddSame,
    });
    expect(entry(result1, 'fields.Added__c').status).toBe('unchanged');

    const leftAdds = customObject(field('Added__c', 'Text'));
    const rightAddsDifferently = customObject(field('Added__c', 'Checkbox'));
    const result2 = mergeGeneric(key, { mode: 'three-way', base, left: leftAdds, right: rightAddsDifferently });
    expect(entry(result2, 'fields.Added__c').status).toBe('conflict');
  });

  it('both sides deleting the same field is a clean agreement, not a conflict', () => {
    const base = customObject(field('Doomed__c', 'Text'));
    const bothDelete = customObject();
    const result = mergeGeneric(key, { mode: 'three-way', base, left: bothDelete, right: bothDelete });
    const doomed = entry(result, 'fields.Doomed__c');
    expect(doomed.status).toBe('unchanged');
    expect(doomed.resolved).toBeUndefined();
  });
});

describe('two-way vs three-way produce DIFFERENT results for the SAME left/right content — the mode is not cosmetic', () => {
  it('an entry only left actually changed is a clean take-left in three-way, but an unresolved conflict in two-way, given the identical left/right inputs', () => {
    const base = customObject(field('Contested__c', 'Text'));
    // Left changed it; right is untouched (still equals base).
    const left = customObject(field('Contested__c', 'LongTextArea'));
    const right = customObject(field('Contested__c', 'Text'));

    const threeWay = mergeGeneric(key, { mode: 'three-way', base, left, right });
    const twoWay = mergeGeneric(key, { mode: 'two-way', left, right });

    // Three-way knows right never touched it: clean, no decision needed.
    expect(entry(threeWay, 'fields.Contested__c').status).toBe('take-left');
    expect(threeWay.summary.conflict).toBe(0);

    // Two-way has no base — it can only see that left and right currently
    // disagree, and — correctly — cannot tell who "changed" it, so it must
    // ask. Same left/right bytes, genuinely different verdict.
    expect(entry(twoWay, 'fields.Contested__c').status).toBe('conflict');
    expect(twoWay.summary.conflict).toBe(1);

    expect(twoWay.mode).toBe('two-way');
    expect(threeWay.mode).toBe('three-way');
  });
});
