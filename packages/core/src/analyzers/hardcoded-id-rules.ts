import type {
  Analyzer,
  AnalysisContext,
  Component,
  Finding,
  FindingSeverity,
} from '../types/analyzer.js';
import { allFiles, parseComponentXml, textOf } from './component-utils.js';

/**
 * Hardcoded Salesforce record-Id detection — the classic cross-org
 * breakage: a literal Id copied from one org (a RecordTypeId, a Queue Id,
 * a hardcoded User/Profile Id) works by accident where it was authored
 * and silently does the wrong thing (or throws) everywhere else, because
 * Salesforce Ids are per-org and per-object, never portable metadata.
 *
 * Detection strategy, chosen to keep false positives low without an org
 * connection to validate against:
 *  - 18-character candidates are checksum-validated against Salesforce's
 *    own case-encoding algorithm (`isValidId18`) — this is a strong,
 *    almost-zero-false-positive signal; any 18-char alnum string that
 *    happens to pass it is astronomically unlikely to be anything else.
 *  - 15-character candidates have no checksum to validate, so they are
 *    only flagged when their 3-character key prefix matches a curated
 *    list of common standard-object prefixes — a plugin can't know an
 *    org's own custom-object prefixes without querying it, so this
 *    deliberately under-reports rather than guessing.
 */
const ID18_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export function isValidId18(candidate: string): boolean {
  if (!/^[a-zA-Z0-9]{18}$/.test(candidate)) return false;
  const base15 = candidate.slice(0, 15);
  const suffix = candidate.slice(15, 18);
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const ch = base15[chunk * 5 + i]!;
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << i;
    }
    if (ID18_ALPHABET[bits] !== suffix[chunk]) return false;
  }
  return true;
}

/** Common standard-object key prefixes, used only to qualify an unverifiable 15-char candidate. Not exhaustive by design — see file header. */
const KNOWN_15_CHAR_PREFIXES = new Set([
  '001', // Account
  '003', // Contact
  '005', // User
  '006', // Opportunity
  '00D', // Organization
  '00Q', // Lead
  '00G', // Group
  '500', // Case
  '701', // Campaign
  '01p', // ApexClass
  '01q', // ApexTrigger
  '0Rt', // Report
  '00e', // Profile
]);

function isValidId15(candidate: string): boolean {
  return /^[a-zA-Z0-9]{15}$/.test(candidate) && KNOWN_15_CHAR_PREFIXES.has(candidate.slice(0, 3));
}

/** Scans free text (an Apex body, a formula, an XML text value) for embedded Id-shaped literals, returning the distinct matches. */
export function findHardcodedIds(text: string): string[] {
  const candidates = text.match(/\b[a-zA-Z0-9]{15,18}\b/g) ?? [];
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.length === 18 && isValidId18(candidate)) found.add(candidate);
    else if (candidate.length === 15 && isValidId15(candidate)) found.add(candidate);
  }
  return [...found];
}

export interface HardcodedIdRuleConfig {
  readonly id: string;
  readonly title: string;
  readonly defaultSeverity: FindingSeverity;
  readonly sourceType: string;
  /** Extracts the text fragments to scan for embedded Id literals — e.g. the Apex body, or specific XML fields rather than the whole file (to keep `path` meaningful). */
  extractTextFragments(
    component: Component,
  ): readonly { readonly label: string; readonly text: string }[];
}

function makeHardcodedIdAnalyzer(config: HardcodedIdRuleConfig): Analyzer {
  return {
    id: config.id,
    title: config.title,
    category: 'hardcoded-id',
    defaultSeverity: config.defaultSeverity,
    appliesTo(ctx: AnalysisContext) {
      return ctx.packageComponents.some((c) => c.key.type === config.sourceType);
    },
    analyze(ctx: AnalysisContext): Finding[] {
      const findings: Finding[] = [];
      for (const component of ctx.packageComponents) {
        if (component.key.type !== config.sourceType) continue;
        for (const fragment of config.extractTextFragments(component)) {
          const ids = findHardcodedIds(fragment.text);
          for (const id of ids) {
            findings.push({
              analyzerId: config.id,
              severity: config.defaultSeverity,
              title: `Hardcoded Salesforce Id "${id}" in "${component.key.fullName}"`,
              detail:
                `"${component.key.fullName}" (${fragment.label}) contains what looks like a literal Salesforce ` +
                `record Id ("${id}"). Ids are per-org — this value will refer to a different record (or nothing) ` +
                `in every org other than the one it was copied from, including the target of this deployment.`,
              recommendation:
                `Replace the literal Id with a lookup by a stable key instead: a SOQL query by Name/developer ` +
                `name, a Custom Metadata Type record, a Custom Setting, or (for RecordType Ids specifically) ` +
                `\`Schema.SObjectType.<Object>.getRecordTypeInfosByDeveloperName()\`.`,
              key: component.key,
              path: fragment.label,
            });
          }
        }
      }
      return findings;
    },
  };
}

export const apexHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/apex-body',
  title: 'Apex body contains a hardcoded Salesforce Id',
  defaultSeverity: 'warning',
  sourceType: 'ApexClass',
  extractTextFragments(component) {
    return [{ label: 'class body', text: component.content }];
  },
});

export const apexTriggerHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/apex-trigger-body',
  title: 'Apex trigger body contains a hardcoded Salesforce Id',
  defaultSeverity: 'warning',
  sourceType: 'ApexTrigger',
  extractTextFragments(component) {
    return [{ label: 'trigger body', text: component.content }];
  },
});

export const validationRuleHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/validation-rule-formula',
  title: 'Validation rule formula contains a hardcoded Salesforce Id',
  defaultSeverity: 'warning',
  sourceType: 'ValidationRule',
  extractTextFragments(component) {
    const root = parseComponentXml(component.content);
    const formula = root ? textOf(root.errorConditionFormula) : undefined;
    return formula ? [{ label: 'errorConditionFormula', text: formula }] : [];
  },
});

export const formulaFieldHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/formula-field',
  title: 'Formula field contains a hardcoded Salesforce Id',
  defaultSeverity: 'warning',
  sourceType: 'CustomField',
  extractTextFragments(component) {
    const root = parseComponentXml(component.content);
    const formula = root ? textOf(root.formula) : undefined;
    return formula ? [{ label: 'formula', text: formula }] : [];
  },
});

/** Recursively collects every scalar text leaf under a parsed Flow XML object — Flow literal values (`stringValue`, `elementReference`, default values) can appear at many different nesting depths depending on element type, so this walks the whole tree rather than a fixed set of tag names. */
function collectFlowTextLeaves(
  node: unknown,
  path: string,
  out: { label: string; text: string }[],
): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectFlowTextLeaves(child, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith('@_')) continue;
      collectFlowTextLeaves(v, path ? `${path}.${k}` : k, out);
    }
    return;
  }
  const text = textOf(node);
  if (text) out.push({ label: path, text });
}

export const flowHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/flow-literal-value',
  title: 'Flow contains a hardcoded Salesforce Id literal',
  defaultSeverity: 'warning',
  sourceType: 'Flow',
  extractTextFragments(component) {
    const root = parseComponentXml(component.content);
    if (!root) return [];
    const out: { label: string; text: string }[] = [];
    collectFlowTextLeaves(root, '', out);
    return out;
  },
});

/** `-meta.xml` sidecars (LWC/Aura target configs, custom metadata) can also carry literal Ids; scanning every materialized file (not just the primary) mirrors how `allFiles` is used elsewhere for multi-file components. Kept as a narrowly-scoped rule (LightningComponentBundle only) rather than a blanket "scan everything" to avoid false positives on binary/generated content. */
export const lwcConfigHardcodedIdAnalyzer = makeHardcodedIdAnalyzer({
  id: 'hardcoded-id/lwc-config',
  title: 'Lightning web component config contains a hardcoded Salesforce Id',
  defaultSeverity: 'warning',
  sourceType: 'LightningComponentBundle',
  extractTextFragments(component) {
    return allFiles(component)
      .filter((f) => f.path.endsWith('.js-meta.xml') || f.path.endsWith('.js'))
      .map((f) => ({ label: f.path, text: f.content }));
  },
});

export const HARDCODED_ID_ANALYZERS: readonly Analyzer[] = [
  apexHardcodedIdAnalyzer,
  apexTriggerHardcodedIdAnalyzer,
  validationRuleHardcodedIdAnalyzer,
  formulaFieldHardcodedIdAnalyzer,
  flowHardcodedIdAnalyzer,
  lwcConfigHardcodedIdAnalyzer,
];
