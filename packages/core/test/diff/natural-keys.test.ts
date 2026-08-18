import { describe, expect, it } from 'vitest';
import {
  computeItemKey,
  resolveCollectionKeyFields,
  stableStringify,
} from '../../src/diff/natural-keys.js';

describe('resolveCollectionKeyFields', () => {
  it("resolves a generic ('*') collection for any root type", () => {
    expect(resolveCollectionKeyFields('CustomObject', 'fields')).toEqual(['fullName']);
    expect(resolveCollectionKeyFields('SomeOtherType', 'fieldPermissions')).toEqual(['field']);
  });

  it('a root-type-specific override wins over the generic bucket', () => {
    expect(resolveCollectionKeyFields('Flow', 'fields')).toEqual(['name']);
    expect(resolveCollectionKeyFields('CustomObject', 'fields')).toEqual(['fullName']);
  });

  it('returns undefined for a tag with no table entry (generic fallback applies at the computeItemKey layer)', () => {
    expect(resolveCollectionKeyFields('CustomObject', 'totallyUnknownTag')).toBeUndefined();
  });

  it('CustomMetadata overrides the generic `values` bucket entry (CustomMetadataValue.field, not PicklistValue.fullName)', () => {
    expect(resolveCollectionKeyFields('CustomMetadata', 'values')).toEqual(['field']);
    // The generic bucket still applies to every other root type that uses
    // the same tag name for a genuinely different shape (RecordType /
    // BusinessProcess picklist values) — this is the ambiguity the
    // CustomMetadata override exists to resolve, not a blanket redefinition.
    expect(resolveCollectionKeyFields('CustomObject', 'values')).toEqual(['fullName']);
  });

  it("ListView's `filters` (ListViewFilter.filter) is distinct from Flow's `filters` (CollectionProcessor field)", () => {
    expect(resolveCollectionKeyFields('CustomObject', 'filters')).toEqual(['filter']);
    expect(resolveCollectionKeyFields('Flow', 'filters')).toEqual(['field']);
  });

  it('resolves composite-key Phase 2 collections (WorkflowRule actions, PlatformActionListItem)', () => {
    expect(resolveCollectionKeyFields('WorkflowRule', 'actions')).toEqual(['name', 'type']);
    expect(resolveCollectionKeyFields('Layout', 'platformActionListItems')).toEqual([
      'actionName',
      'actionType',
    ]);
  });
});

describe('computeItemKey', () => {
  it('uses the explicit key field when given', () => {
    const k = computeItemKey({ fullName: 'My_Field__c', type: 'Text' }, ['fullName']);
    expect(k.displayKey).toBe('My_Field__c');
  });

  it('falls back through GENERIC_KEY_CANDIDATES when no explicit rule is given', () => {
    const k = computeItemKey({ name: 'Foo', somethingElse: 1 }, undefined);
    expect(k.displayKey).toBe('Foo');
  });

  it('builds a composite key from multiple fields, skipping absent optional segments', () => {
    const withBoth = computeItemKey({ layout: 'MyLayout', recordType: 'MyObject.RT1' }, [
      'layout',
      'recordType',
    ]);
    expect(withBoth.displayKey).toBe('MyLayout.MyObject.RT1');
    const layoutOnly = computeItemKey({ layout: 'MyLayout' }, ['layout', 'recordType']);
    expect(layoutOnly.displayKey).toBe('MyLayout');
  });

  it('treats a scalar collection member as its own key', () => {
    const k = computeItemKey('Category1', undefined);
    expect(k.displayKey).toBe('Category1');
    expect(k.sortKey).toBe('scalar:Category1');
  });

  it('falls back to a stable content hash when nothing resolves, and the hash is order-independent', () => {
    const a = computeItemKey({ x: 1, y: 2 }, undefined);
    const b = computeItemKey({ y: 2, x: 1 }, undefined);
    expect(a.sortKey).toBe(b.sortKey);
    expect(a.sortKey.startsWith('hash:')).toBe(true);
  });

  it('unwraps a CDATA leaf before using it as a key field value', () => {
    const k = computeItemKey({ fullName: { __cdata: 'My_Field__c' } }, ['fullName']);
    expect(k.displayKey).toBe('My_Field__c');
  });
});

describe('stableStringify', () => {
  it('is independent of object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('distinguishes genuinely different content', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});
