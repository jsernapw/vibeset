import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadManifest,
  manifestFilePath,
  manifestFromYaml,
  manifestToDeploymentPackage,
  manifestToYaml,
  MANIFEST_SCHEMA_VERSION,
  saveManifest,
  toManifest,
} from '../../src/package/manifest.js';
import type { DeploymentPackage } from '../../src/types/deployment.js';

const samplePackage: DeploymentPackage = {
  id: 'pkg_123',
  name: 'Sprint 42 release',
  comparisonId: 'cmp_abc',
  components: [
    { type: 'ApexClass', fullName: 'MyClass' },
    { type: 'CustomField', fullName: 'Account.My_Field__c', parentFullName: 'Account' },
  ],
  destructiveComponents: [{ type: 'ApexClass', fullName: 'OldClass' }],
  createdAt: '2026-08-14T12:00:00.000Z',
};

describe('package manifest — YAML schema round-trip', () => {
  it('toManifest -> manifestToYaml -> manifestFromYaml -> manifestToDeploymentPackage is lossless for the DeploymentPackage shape', () => {
    const manifest = toManifest(samplePackage);
    expect(manifest.vibesetManifestVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.destructiveMode).toBe('post');

    const yaml = manifestToYaml(manifest);
    expect(yaml).toContain('vibesetManifestVersion: 1');
    expect(yaml).toContain('id: pkg_123');
    expect(yaml).toContain('parentFullName: Account');

    const revived = manifestFromYaml(yaml);
    expect(revived).toEqual(manifest);

    const pkg = manifestToDeploymentPackage(revived);
    expect(pkg.id).toBe(samplePackage.id);
    expect(pkg.name).toBe(samplePackage.name);
    expect(pkg.comparisonId).toBe(samplePackage.comparisonId);
    expect(pkg.components).toEqual(samplePackage.components);
    expect(pkg.destructiveComponents).toEqual(samplePackage.destructiveComponents);
  });

  it('rejects a manifest with an unsupported schema version', () => {
    const yaml = 'vibesetManifestVersion: 999\nid: x\nname: y\ncreatedAt: z\n';
    expect(() => manifestFromYaml(yaml)).toThrow(/version/i);
  });

  it('rejects a manifest missing required fields', () => {
    expect(() => manifestFromYaml('vibesetManifestVersion: 1\n')).toThrow(/missing required field/i);
  });

  it('defaults destructiveMode to "post" when absent from the YAML', () => {
    const yaml = 'vibesetManifestVersion: 1\nid: x\nname: y\ncreatedAt: 2026-01-01T00:00:00.000Z\n';
    expect(manifestFromYaml(yaml).destructiveMode).toBe('post');
  });
});

describe('package manifest — filesystem save/load under .vibeset/', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibeset-manifest-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves to <dir>/packages/<id>.yml and loads back an equal manifest', async () => {
    const manifest = toManifest(samplePackage);
    const filePath = await saveManifest(manifest, dir);
    expect(filePath).toBe(manifestFilePath(dir, manifest.id));
    expect(filePath).toBe(join(dir, 'packages', 'pkg_123.yml'));

    const loaded = await loadManifest(filePath);
    expect(loaded).toEqual(manifest);
  });
});
