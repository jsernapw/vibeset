import { describe, expect, it } from 'vitest';
import { mergeComponent } from '../../src/merge/dispatch.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';

describe('mergeComponent — dispatch', () => {
  it('routes CustomObject (and anything else non-Profile-like) through the generic merge path without requiring coverage', () => {
    const key: ComponentKey = { type: 'CustomObject', fullName: 'Account' };
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>L</label></CustomObject>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>R</label></CustomObject>\n`;
    const result = mergeComponent(key, { mode: 'two-way', left, right });
    expect(result.mode).toBe('two-way');
    const label = result.entries.find((e) => e.path === 'label')!;
    expect(label.status).toBe('conflict');
  });

  it('routes Profile through the coverage-aware merge path and throws when coverage is omitted', () => {
    const key: ComponentKey = { type: 'Profile', fullName: 'Admin' };
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>L</description></Profile>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><description>R</description></Profile>\n`;
    expect(() => mergeComponent(key, { mode: 'two-way', left, right })).toThrow(
      /requires an explicit MergeProfileCoverage/,
    );
  });

  it('routes PermissionSet through the coverage-aware merge path too', () => {
    const key: ComponentKey = { type: 'PermissionSet', fullName: 'MyPS' };
    const left = `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>L</label></PermissionSet>\n`;
    const right = `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>R</label></PermissionSet>\n`;
    const coverage = { left: { mode: 'full' as const }, right: { mode: 'full' as const } };
    const result = mergeComponent(key, { mode: 'two-way', left, right }, coverage);
    expect(result.mode).toBe('two-way');
    const label = result.entries.find((e) => e.path === 'label')!;
    expect(label.status).toBe('conflict');
  });

  it('mode on the result echoes the mode on the input, verbatim, for both branches', () => {
    const key: ComponentKey = { type: 'CustomObject', fullName: 'Account' };
    const base = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>B</label></CustomObject>\n`;
    const left = base;
    const right = base;
    const result = mergeComponent(key, { mode: 'three-way', base, left, right });
    expect(result.mode).toBe('three-way');
  });
});
