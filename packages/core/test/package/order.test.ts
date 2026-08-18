import { describe, expect, it } from 'vitest';
import { topologicalOrder } from '../../src/package/order.js';

describe('topologicalOrder', () => {
  it('orders CustomObject before CustomField before ValidationRule', () => {
    const ordered = topologicalOrder([
      { type: 'ValidationRule', fullName: 'Account.VR' },
      { type: 'CustomField', fullName: 'Account.F' },
      { type: 'CustomObject', fullName: 'Account' },
    ]);
    expect(ordered.map((k) => k.type)).toEqual(['CustomObject', 'CustomField', 'ValidationRule']);
  });

  it('orders ApexClass before ApexTrigger', () => {
    const ordered = topologicalOrder([
      { type: 'ApexTrigger', fullName: 'AccountTrigger' },
      { type: 'ApexClass', fullName: 'AccountHandler' },
    ]);
    expect(ordered.map((k) => k.type)).toEqual(['ApexClass', 'ApexTrigger']);
  });

  it('orders Profile/PermissionSet last, after the components they reference', () => {
    const ordered = topologicalOrder([
      { type: 'Profile', fullName: 'Admin' },
      { type: 'ApexClass', fullName: 'Foo' },
      { type: 'CustomObject', fullName: 'Account' },
    ]);
    expect(ordered.map((k) => k.type)).toEqual(['CustomObject', 'ApexClass', 'Profile']);
  });

  it('sorts by fullName within the same type for deterministic, diffable output', () => {
    const ordered = topologicalOrder([
      { type: 'ApexClass', fullName: 'Zebra' },
      { type: 'ApexClass', fullName: 'Alpha' },
      { type: 'ApexClass', fullName: 'Mango' },
    ]);
    expect(ordered.map((k) => k.fullName)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('an unlisted type sorts after every listed type, not first/randomly', () => {
    const ordered = topologicalOrder([
      { type: 'SomeBrandNewPhase2Type', fullName: 'X' },
      { type: 'ApexClass', fullName: 'Foo' },
    ]);
    expect(ordered.map((k) => k.type)).toEqual(['ApexClass', 'SomeBrandNewPhase2Type']);
  });

  it('does not mutate the input array', () => {
    const input = [{ type: 'ApexTrigger', fullName: 'T' }, { type: 'ApexClass', fullName: 'C' }];
    const copy = [...input];
    topologicalOrder(input);
    expect(input).toEqual(copy);
  });
});
