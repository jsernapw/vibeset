import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVENTORY_TYPES,
  listAllInventoryTypeNames,
  resolveInventoryTypes,
} from '../../src/sources/registry.js';

describe('DEFAULT_INVENTORY_TYPES', () => {
  it('has no duplicate entries', () => {
    expect(new Set(DEFAULT_INVENTORY_TYPES).size).toBe(DEFAULT_INVENTORY_TYPES.length);
  });

  it('every entry resolves against the real SDR RegistryAccess (never silently drifts from what SDR knows)', () => {
    const registry = new RegistryAccess();
    expect(() => resolveInventoryTypes({ types: [...DEFAULT_INVENTORY_TYPES] }, registry)).not.toThrow();
    const resolved = resolveInventoryTypes({ types: [...DEFAULT_INVENTORY_TYPES] }, registry);
    expect(resolved).toHaveLength(DEFAULT_INVENTORY_TYPES.length);
  });

  it('grew from Phase 1s 11-type default without dropping any of it', () => {
    const phase1Default = [
      'ApexClass',
      'ApexTrigger',
      'CustomObject',
      'CustomField',
      'Layout',
      'ValidationRule',
      'Flow',
      'PermissionSet',
      'Profile',
      'LightningComponentBundle',
      'CustomLabels',
    ];
    for (const t of phase1Default) {
      expect(DEFAULT_INVENTORY_TYPES).toContain(t);
    }
    expect(DEFAULT_INVENTORY_TYPES.length).toBeGreaterThan(phase1Default.length);
  });

  it('includes every folder-based type org-source.ts is documented to handle (Report/Dashboard/EmailTemplate/Document)', () => {
    for (const t of ['Report', 'Dashboard', 'EmailTemplate', 'Document']) {
      expect(DEFAULT_INVENTORY_TYPES).toContain(t);
    }
  });

  it('includes StandardValueSet and CustomLabels, the non-listable-singleton special cases org-source.ts handles explicitly', () => {
    expect(DEFAULT_INVENTORY_TYPES).toContain('StandardValueSet');
    expect(DEFAULT_INVENTORY_TYPES).toContain('CustomLabels');
  });

  it('includes the two binary-bodied types the content-reader fix covers (StaticResource, Document)', () => {
    expect(DEFAULT_INVENTORY_TYPES).toContain('StaticResource');
    expect(DEFAULT_INVENTORY_TYPES).toContain('Document');
  });

  it('does not default to a decomposed-bundle type name that is not actually independently listable (AuraDefinitionBundle, not AuraDefinition)', () => {
    expect(DEFAULT_INVENTORY_TYPES).toContain('AuraDefinitionBundle');
    expect(DEFAULT_INVENTORY_TYPES).not.toContain('AuraDefinition');
  });
});

describe('listAllInventoryTypeNames', () => {
  it('returns a superset of DEFAULT_INVENTORY_TYPES', async () => {
    const all = await listAllInventoryTypeNames();
    for (const t of DEFAULT_INVENTORY_TYPES) {
      expect(all).toContain(t);
    }
  });

  it('includes decomposed CustomObject/Workflow children that are independently addressable but not top-level registry keys', async () => {
    const all = await listAllInventoryTypeNames();
    for (const t of ['CustomField', 'ValidationRule', 'RecordType', 'WorkflowRule', 'WorkflowTask']) {
      expect(all).toContain(t);
    }
  });

  it('is much larger than the curated default — the "available" side of available-and-selectable', async () => {
    const all = await listAllInventoryTypeNames();
    expect(all.length).toBeGreaterThan(DEFAULT_INVENTORY_TYPES.length * 5);
  });

  it('has no duplicates', async () => {
    const all = await listAllInventoryTypeNames();
    expect(new Set(all).size).toBe(all.length);
  });
});
