import { describe, expect, it } from 'vitest';
import { generatePackageXml } from '../../src/package/package-xml.js';

describe('generatePackageXml — destructive-change generation via SDR ComponentSet.getPackageXml', () => {
  it('generates a package.xml listing every add/update component, grouped by type', async () => {
    const { packageXml, destructiveChangesXml } = await generatePackageXml({
      components: [
        { type: 'ApexClass', fullName: 'Foo' },
        { type: 'ApexClass', fullName: 'Bar' },
        { type: 'CustomObject', fullName: 'Account' },
      ],
      destructiveComponents: [],
      apiVersion: '62.0',
    });

    expect(packageXml).toContain('<?xml');
    expect(packageXml).toContain('<name>ApexClass</name>');
    expect(packageXml).toContain('<members>Foo</members>');
    expect(packageXml).toContain('<members>Bar</members>');
    expect(packageXml).toContain('<name>CustomObject</name>');
    expect(packageXml).toContain('<members>Account</members>');
    expect(packageXml).toContain('<version>62.0</version>');
    expect(destructiveChangesXml).toBeUndefined();
  });

  it('generates destructiveChangesPost.xml (default mode) for destructiveComponents, separate from package.xml', async () => {
    const { packageXml, destructiveChangesXml, destructiveMode } = await generatePackageXml({
      components: [{ type: 'ApexClass', fullName: 'KeepMe' }],
      destructiveComponents: [{ type: 'ApexClass', fullName: 'RemoveMe' }],
      apiVersion: '62.0',
    });

    expect(destructiveMode).toBe('post');
    expect(packageXml).toContain('<members>KeepMe</members>');
    expect(packageXml).not.toContain('RemoveMe');
    expect(destructiveChangesXml).toBeDefined();
    expect(destructiveChangesXml).toContain('<members>RemoveMe</members>');
    expect(destructiveChangesXml).not.toContain('KeepMe');
  });

  it('honors destructiveMode: "pre" when explicitly requested', async () => {
    const { destructiveMode, destructiveChangesXml } = await generatePackageXml({
      components: [],
      destructiveComponents: [{ type: 'ApexClass', fullName: 'RemoveMe' }],
      destructiveMode: 'pre',
      apiVersion: '62.0',
    });
    expect(destructiveMode).toBe('pre');
    expect(destructiveChangesXml).toContain('<members>RemoveMe</members>');
  });

  it('produces a valid empty package.xml when there are no components at all', async () => {
    const { packageXml, destructiveChangesXml } = await generatePackageXml({
      components: [],
      destructiveComponents: [],
    });
    expect(packageXml).toContain('<Package');
    expect(destructiveChangesXml).toBeUndefined();
  });
});
