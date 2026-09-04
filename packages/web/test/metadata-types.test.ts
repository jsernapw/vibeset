import { describe, expect, it } from 'vitest';
import {
  isBinaryDiffType,
  isMergeableType,
  isMergeChildCollectionsUnsupported,
  isPermissionGridType,
  isTextDiffType,
} from '../src/lib/metadata-types';

describe('metadata-types renderer classification', () => {
  it('classifies opaque code-body types as text-diff types', () => {
    expect(isTextDiffType('ApexClass')).toBe(true);
    expect(isTextDiffType('ApexTrigger')).toBe(true);
    expect(isTextDiffType('LightningComponentBundle')).toBe(true);
    expect(isTextDiffType('AuraDefinitionBundle')).toBe(true);
    expect(isTextDiffType('CustomObject')).toBe(false);
  });

  it('classifies Profile/PermissionSet as permission-grid types and nothing else', () => {
    expect(isPermissionGridType('Profile')).toBe(true);
    expect(isPermissionGridType('PermissionSet')).toBe(true);
    expect(isPermissionGridType('ApexClass')).toBe(false);
  });

  it('classifies StaticResource/Document as binary-diff types (fallback, name-based)', () => {
    expect(isBinaryDiffType('StaticResource')).toBe(true);
    expect(isBinaryDiffType('Document')).toBe(true);
    expect(isBinaryDiffType('ApexClass')).toBe(false);
  });

  it('no type is classified as more than one renderer', () => {
    const allNames = ['ApexClass', 'Profile', 'PermissionSet', 'StaticResource', 'Document', 'CustomObject', 'Flow'];
    for (const name of allNames) {
      const hits = [isTextDiffType(name), isPermissionGridType(name), isBinaryDiffType(name)].filter(Boolean).length;
      expect(hits, `${name} should match at most one renderer classification`).toBeLessThanOrEqual(1);
    }
  });

  it('mergeable types are exactly "neither text-diff nor binary" — opaque code bodies and raw bytes have no natural-keyed collections to merge', () => {
    expect(isMergeableType('Profile')).toBe(true);
    expect(isMergeableType('PermissionSet')).toBe(true);
    expect(isMergeableType('CustomObject')).toBe(true);
    expect(isMergeableType('Flow')).toBe(true);
    expect(isMergeableType('ApexClass')).toBe(false);
    expect(isMergeableType('AuraDefinitionBundle')).toBe(false);
    expect(isMergeableType('StaticResource')).toBe(false);
    expect(isMergeableType('Document')).toBe(false);
  });

  it('CustomObject is flagged as merge-child-collections-unsupported and nothing else is', () => {
    expect(isMergeChildCollectionsUnsupported('CustomObject')).toBe(true);
    expect(isMergeChildCollectionsUnsupported('Profile')).toBe(false);
    expect(isMergeChildCollectionsUnsupported('Flow')).toBe(false);
  });
});
