import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalizeXml } from '../../src/diff/normalize.js';

/**
 * Property-based tests for the canonicalizer: for a given semantic
 * document, arbitrary element reordering and whitespace/declaration/
 * line-ending perturbation must never change the resulting hash. This is
 * the invariant the whole hash short-circuit depends on — a counterexample
 * here means a real component pair somewhere would be silently
 * mis-reported as changed (or, worse, as identical).
 */

const FIELD_NAMES = [
  'Alpha__c',
  'Beta__c',
  'Gamma__c',
  'Delta__c',
  'Epsilon__c',
  'Zeta__c',
  'Eta__c',
  'Theta__c',
];

interface FieldDef {
  readonly name: string;
  readonly required: boolean;
}

interface RenderOptions {
  readonly indent: string;
  readonly crlf: boolean;
  readonly declaration: boolean;
  readonly selfCloseEmpty: boolean;
}

function renderField(f: FieldDef, ind: string, selfCloseEmpty: boolean): string {
  const desc = selfCloseEmpty
    ? `${ind}${ind}<description/>\n`
    : `${ind}${ind}<description></description>\n`;
  return (
    `${ind}<fields>\n` +
    `${ind}${ind}<fullName>${f.name}</fullName>\n` +
    `${ind}${ind}<type>Text</type>\n` +
    `${ind}${ind}<required>${f.required}</required>\n` +
    desc +
    `${ind}</fields>`
  );
}

function renderCustomObject(fields: readonly FieldDef[], opts: RenderOptions): string {
  const body = fields.map((f) => renderField(f, opts.indent, opts.selfCloseEmpty)).join('\n');
  let xml =
    (opts.declaration ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') +
    `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n${opts.indent}<label>Prop Test</label>\n${body}\n</CustomObject>\n`;
  if (opts.crlf) xml = xml.replace(/\n/g, '\r\n');
  return xml;
}

const fieldArb = fc.record({ name: fc.constantFrom(...FIELD_NAMES), required: fc.boolean() });
const fieldsArb = fc.uniqueArray(fieldArb, {
  selector: (f) => f.name,
  minLength: 0,
  maxLength: FIELD_NAMES.length,
});
const renderOptionsArb: fc.Arbitrary<RenderOptions> = fc.record({
  indent: fc.constantFrom('  ', '    ', '\t'),
  crlf: fc.boolean(),
  declaration: fc.boolean(),
  selfCloseEmpty: fc.boolean(),
});

describe('canonicalizeXml — property-based invariants', () => {
  it('is invariant under arbitrary field reordering and whitespace/declaration/line-ending perturbation', () => {
    fc.assert(
      fc.property(fieldsArb, renderOptionsArb, renderOptionsArb, (fields, leftOpts, rightOpts) => {
        const leftXml = renderCustomObject(fields, leftOpts);
        // Right side: same semantic fields, arbitrary order, arbitrary rendering.
        const shuffled = [...fields].sort(() => Math.random() - 0.5);
        const rightXml = renderCustomObject(shuffled, rightOpts);

        const left = canonicalizeXml(leftXml, 'CustomObject');
        const right = canonicalizeXml(rightXml, 'CustomObject');
        expect(right.sha256).toBe(left.sha256);
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic: canonicalizing the same input twice yields the same hash', () => {
    fc.assert(
      fc.property(fieldsArb, renderOptionsArb, (fields, opts) => {
        const xml = renderCustomObject(fields, opts);
        const a = canonicalizeXml(xml, 'CustomObject');
        const b = canonicalizeXml(xml, 'CustomObject');
        expect(a.sha256).toBe(b.sha256);
        expect(a.canonicalXml).toBe(b.canonicalXml);
      }),
      { numRuns: 100 },
    );
  });

  it('detects a real change: flipping one field attribute changes the hash', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.nat(),
        renderOptionsArb,
        renderOptionsArb,
        (fields, seed, leftOpts, rightOpts) => {
          fc.pre(fields.length > 0);
          const idx = seed % fields.length;
          const mutated = fields.map((f, i) => (i === idx ? { ...f, required: !f.required } : f));

          const left = canonicalizeXml(renderCustomObject(fields, leftOpts), 'CustomObject');
          const right = canonicalizeXml(renderCustomObject(mutated, rightOpts), 'CustomObject');
          expect(right.sha256).not.toBe(left.sha256);
        },
      ),
      { numRuns: 200 },
    );
  });
});
