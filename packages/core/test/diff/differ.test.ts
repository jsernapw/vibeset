import { describe, expect, it } from 'vitest';
import { diffComponentTree, diffXml, isAllIdentical, unwrapRoot } from '../../src/diff/differ.js';

describe('diffComponentTree', () => {
  it('matches collection items by natural key, not array position', () => {
    const left = {
      fields: [
        { fullName: 'A__c', required: 'false' },
        { fullName: 'B__c', required: 'true' },
      ],
    };
    const right = {
      fields: [
        { fullName: 'B__c', required: 'true' },
        { fullName: 'A__c', required: 'false' },
      ],
    };
    const entries = diffComponentTree('CustomObject', left, right);
    expect(isAllIdentical(entries)).toBe(true);
  });

  it('reports a scalar leaf change with a dotted path', () => {
    const left = { fields: [{ fullName: 'A__c', required: 'false' }] };
    const right = { fields: [{ fullName: 'A__c', required: 'true' }] };
    const entries = diffComponentTree('CustomObject', left, right);
    const fieldsEntry = entries.find((e) => e.key === 'fields')!;
    const item = fieldsEntry.children!.find((e) => e.key === 'A__c')!;
    const requiredEntry = item.children!.find((e) => e.key === 'required')!;
    expect(requiredEntry).toMatchObject({
      path: 'fields.A__c.required',
      status: 'changed',
      before: 'false',
      after: 'true',
    });
  });

  it('marks an added collection item as new, a removed one as deleted', () => {
    const left = { fields: [{ fullName: 'Keep__c' }, { fullName: 'Gone__c' }] };
    const right = { fields: [{ fullName: 'Keep__c' }, { fullName: 'Fresh__c' }] };
    const entries = diffComponentTree('CustomObject', left, right);
    const items = entries.find((e) => e.key === 'fields')!.children!;
    expect(items.find((i) => i.key === 'Gone__c')).toMatchObject({ status: 'deleted' });
    expect(items.find((i) => i.key === 'Fresh__c')).toMatchObject({ status: 'new' });
    expect(items.find((i) => i.key === 'Keep__c')).toMatchObject({ status: 'identical' });
  });

  it('uses the Flow-specific override so Flow screen `fields` are keyed by name, not fullName', () => {
    const left = {
      screens: [{ name: 'Screen1', fields: [{ name: 'Input1' }, { name: 'Input2' }] }],
    };
    const right = {
      screens: [{ name: 'Screen1', fields: [{ name: 'Input2' }, { name: 'Input1' }] }],
    };
    const entries = diffComponentTree('Flow', left, right);
    expect(isAllIdentical(entries)).toBe(true);
  });

  it('does not confuse CustomObject `fields` (keyed by fullName) with Flow `fields` (keyed by name) across root types', () => {
    // Same shape, different root type — CustomObject fields lack a `name`
    // property, so if the differ ever fell back to the Flow key rule here
    // it would silently mismatch every item (all resolving to the same
    // empty/hash key) instead of matching by fullName.
    const left = {
      fields: [
        { fullName: 'A__c', label: 'A' },
        { fullName: 'B__c', label: 'B' },
      ],
    };
    const right = {
      fields: [
        { fullName: 'B__c', label: 'B changed' },
        { fullName: 'A__c', label: 'A' },
      ],
    };
    const entries = diffComponentTree('CustomObject', left, right);
    const items = entries.find((e) => e.key === 'fields')!.children!;
    expect(items.find((i) => i.key === 'A__c')).toMatchObject({ status: 'identical' });
    expect(items.find((i) => i.key === 'B__c')).toMatchObject({ status: 'changed' });
  });

  it('falls back to a content hash key for an untabled collection, still matching identical items across reordering', () => {
    const left = {
      weirdThings: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    };
    const right = {
      weirdThings: [
        { x: 3, y: 4 },
        { x: 1, y: 2 },
      ],
    };
    const entries = diffComponentTree('SomeUnknownType', left, right);
    expect(isAllIdentical(entries)).toBe(true);
  });
});

describe('unwrapRoot', () => {
  it('unwraps the single root-tag wrapper fast-xml-parser produces', () => {
    expect(unwrapRoot({ CustomObject: { label: 'x' } })).toEqual({ label: 'x' });
  });
});

describe('diffXml', () => {
  it('is a no-op for identical documents regardless of formatting', () => {
    const left = `<?xml version="1.0"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>X</label></CustomObject>`;
    const right = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\r\n  <label>X</label>\r\n</CustomObject>\r\n`;
    expect(isAllIdentical(diffXml('CustomObject', left, right))).toBe(true);
  });
});
