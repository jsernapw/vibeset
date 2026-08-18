import { describe, expect, it } from 'vitest';
import { canonicalizeText, canonicalizeXml, parseXml } from '../../src/diff/normalize.js';

describe('canonicalizeXml', () => {
  it('strips known audit/volatile fields so they never affect the hash', () => {
    const withAudit = `<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
      <apiVersion>58.0</apiVersion>
      <status>Active</status>
      <createdDate>2020-01-01T00:00:00.000Z</createdDate>
      <createdById>0051x000000AAAA</createdById>
      <lastModifiedDate>2024-06-01T00:00:00.000Z</lastModifiedDate>
      <lastModifiedById>0051x000000BBBB</lastModifiedById>
    </ApexClass>`;
    const withoutAudit = `<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
      <apiVersion>58.0</apiVersion>
      <status>Active</status>
    </ApexClass>`;
    expect(canonicalizeXml(withAudit, 'ApexClass').sha256).toBe(
      canonicalizeXml(withoutAudit, 'ApexClass').sha256,
    );
  });

  it('does NOT strip apiVersion — a deliberate judgement call, since it can be a real, meaningful change', () => {
    const v58 = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>58.0</apiVersion></CustomObject>`;
    const v59 = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion></CustomObject>`;
    expect(canonicalizeXml(v58, 'CustomObject').sha256).not.toBe(
      canonicalizeXml(v59, 'CustomObject').sha256,
    );
  });

  it('unwraps CDATA to plain text for hashing, so a CDATA-wrapped and entity-escaped equivalent hash the same', () => {
    const cdata = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><description><![CDATA[a & b]]></description></CustomObject>`;
    const plain = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><description>a &amp; b</description></CustomObject>`;
    expect(canonicalizeXml(cdata, 'CustomObject').sha256).toBe(
      canonicalizeXml(plain, 'CustomObject').sha256,
    );
  });

  it('drops XML comments entirely — they never affect the hash', () => {
    const commented = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><!-- note --><label>X</label></CustomObject>`;
    const uncommented = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>X</label></CustomObject>`;
    expect(canonicalizeXml(commented, 'CustomObject').sha256).toBe(
      canonicalizeXml(uncommented, 'CustomObject').sha256,
    );
  });

  it('forces even a single-element collection to array shape (the classic fast-xml-parser single-vs-multi gotcha)', () => {
    const parsed = parseXml(
      `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><fields><fullName>Only__c</fullName></fields></CustomObject>`,
    );
    const co = parsed.CustomObject as Record<string, unknown>;
    expect(Array.isArray(co.fields)).toBe(true);
  });
});

describe('canonicalizeText', () => {
  it('normalizes CRLF to LF', () => {
    expect(canonicalizeText('a\r\nb\r\n').sha256).toBe(canonicalizeText('a\nb\n').sha256);
  });

  it('collapses multiple trailing newlines to exactly one', () => {
    expect(canonicalizeText('a\nb\n\n\n\n').sha256).toBe(canonicalizeText('a\nb\n').sha256);
  });

  it('does not touch internal whitespace/indentation — code formatting is treated as meaningful', () => {
    expect(canonicalizeText('if (x) {\n  y();\n}\n').sha256).not.toBe(
      canonicalizeText('if (x) {\ny();\n}\n').sha256,
    );
  });
});
