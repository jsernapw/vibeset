import type {
  Analyzer,
  AnalysisContext,
  Finding,
  FindingSeverity,
  Mutation,
} from '../types/analyzer.js';
import type { ComponentKey } from '../types/metadata-source.js';
import { componentKeyString } from '../util/component-key.js';
import { arrayOf, parseComponentXml, textOf } from './component-utils.js';

/**
 * Generic "missing dependency" rule engine. Every rule in this file is one
 * `MissingReferenceRuleConfig` fed through this — the highest-value
 * autofix class per the task brief ("add the missing component to the
 * package"), and the shape every one of these hazards actually shares:
 * component A references component B; B is neither in this package nor
 * confirmed present in the target; deploying A as-is will fail (a
 * dangling reference) or silently do nothing useful.
 *
 * Consulting `dependencyGraph.existsInTarget` and treating `undefined` the
 * same as `true` (i.e. NOT a hazard) is deliberate, not an oversight: a
 * missing index entry is not evidence the target org lacks the component —
 * exactly the absent-vs-not-retrieved discipline `diff/profiles.ts`
 * established for Profile comparisons. Only a CONFIRMED absence (`false`)
 * is reported.
 */
export interface ExtractedReference {
  readonly key: ComponentKey;
  /** Where in the XML this reference was found, for the finding's `path`. */
  readonly path?: string;
}

export interface MissingReferenceRuleConfig {
  readonly id: string;
  readonly title: string;
  readonly defaultSeverity: FindingSeverity;
  /** Metadata type this rule scans. */
  readonly sourceType: string;
  /** Human label for the kind of reference, e.g. `'field reference'`, used in finding text. */
  readonly referenceKindLabel: string;
  /** Extracts every reference this component's parsed XML root makes, given its own key. */
  extractReferences(
    root: Record<string, unknown>,
    key: ComponentKey,
  ): readonly ExtractedReference[];
}

function makeMissingReferenceAnalyzer(config: MissingReferenceRuleConfig): Analyzer {
  return {
    id: config.id,
    title: config.title,
    category: 'dependencies',
    defaultSeverity: config.defaultSeverity,
    appliesTo(ctx) {
      return ctx.packageComponents.some((c) => c.key.type === config.sourceType);
    },
    analyze(ctx: AnalysisContext): Finding[] {
      const packageKeys = new Set(ctx.packageComponents.map((c) => componentKeyString(c.key)));
      const findings: Finding[] = [];
      for (const component of ctx.packageComponents) {
        if (component.key.type !== config.sourceType) continue;
        const root = parseComponentXml(component.content);
        if (!root) continue;
        for (const ref of config.extractReferences(root, component.key)) {
          if (packageKeys.has(componentKeyString(ref.key))) continue;
          const exists = ctx.dependencyGraph?.existsInTarget(ref.key);
          if (exists !== false) continue; // unknown or confirmed present: not a hazard
          findings.push({
            analyzerId: config.id,
            severity: config.defaultSeverity,
            title: `${component.key.type} "${component.key.fullName}" references ${ref.key.type} "${ref.key.fullName}", which is missing`,
            detail:
              `${component.key.type} "${component.key.fullName}" has a ${config.referenceKindLabel} to ` +
              `${ref.key.type} "${ref.key.fullName}", but that component is neither part of this deployment ` +
              `package nor present in the target org (confirmed absent). Deploying "${component.key.fullName}" ` +
              `as-is will fail metadata validation with a dangling reference.`,
            recommendation: `Add ${ref.key.type} "${ref.key.fullName}" to the deployment package, or remove the ${config.referenceKindLabel} from "${component.key.fullName}" if it's stale.`,
            key: component.key,
            relatedKeys: [ref.key],
            path: ref.path,
          });
        }
      }
      return findings;
    },
    autofix(_ctx: AnalysisContext, finding: Finding): readonly Mutation[] {
      if (finding.analyzerId !== config.id || !finding.key || !finding.relatedKeys?.length)
        return [];
      return [
        {
          key: finding.key,
          description: `Add ${finding.relatedKeys.map((k) => `${k.type} "${k.fullName}"`).join(', ')} to the deployment package.`,
          addToPackage: finding.relatedKeys,
        },
      ];
    },
  };
}

/** Custom fields only (`__c` suffix) — standard fields are never separately deployable components, so they can never be "missing" in this sense. */
function isCustomFieldApiName(name: string): boolean {
  return name.endsWith('__c');
}

/** A Layout's `fullName` is `<ObjectApiName>-<Layout Label>` (e.g. `Account-Account Layout`). */
function layoutObjectApiName(layoutFullName: string): string {
  return layoutFullName.split('-')[0]!;
}

function fieldKey(objectApiName: string, fieldApiName: string): ComponentKey {
  return {
    type: 'CustomField',
    fullName: `${objectApiName}.${fieldApiName}`,
    parentFullName: objectApiName,
  };
}

function recordTypeKey(objectApiName: string, recordTypeApiName: string): ComponentKey {
  return {
    type: 'RecordType',
    fullName: `${objectApiName}.${recordTypeApiName}`,
    parentFullName: objectApiName,
  };
}

/** Real shape: `Layout.layoutSections[].layoutColumns[].layoutItems[].field`. See `test/fixtures/layout-item-behavior-changed` for the verified real element names/nesting. */
export const layoutMissingFieldAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/layout-missing-field',
  title: 'Layout references a custom field that does not exist',
  defaultSeverity: 'error',
  sourceType: 'Layout',
  referenceKindLabel: 'layout item field reference',
  extractReferences(root, key) {
    const objectApiName = layoutObjectApiName(key.fullName);
    const refs: ExtractedReference[] = [];
    for (const section of arrayOf<Record<string, unknown>>(root.layoutSections)) {
      for (const column of arrayOf<Record<string, unknown>>(section?.layoutColumns)) {
        for (const item of arrayOf<Record<string, unknown>>(column?.layoutItems)) {
          const field = textOf(item?.field);
          if (field && isCustomFieldApiName(field)) {
            refs.push({
              key: fieldKey(objectApiName, field),
              path: `layoutSections.layoutColumns.layoutItems.${field}`,
            });
          }
        }
      }
    }
    return refs;
  },
});

/** Real shape: `Layout.layoutAssignments[].{layout, recordType}` (`recordType` is `Object.RecordTypeName`, already dotted). */
export const layoutMissingRecordTypeAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/layout-missing-recordtype',
  title: 'Layout assignment references a record type that does not exist',
  defaultSeverity: 'warning',
  sourceType: 'Layout',
  referenceKindLabel: 'layout assignment record-type reference',
  extractReferences(root) {
    const refs: ExtractedReference[] = [];
    for (const assignment of arrayOf<Record<string, unknown>>(root.layoutAssignments)) {
      const recordType = textOf(assignment?.recordType);
      if (!recordType || !recordType.includes('.')) continue;
      const [objectApiName, rtName] = recordType.split('.') as [string, string];
      refs.push({
        key: recordTypeKey(objectApiName, rtName),
        path: 'layoutAssignments.recordType',
      });
    }
    return refs;
  },
});

/** Bare custom-field-API-name tokens inside a formula/condition text — same-object references only (cross-object relationship traversals like `Owner.Custom__c` are intentionally not resolved here: the leading segment isn't reliably an object API name without a schema lookup this rule doesn't have). */
function extractSameObjectFieldTokens(formula: string | undefined): string[] {
  if (!formula) return [];
  const tokens = formula.match(/\b[A-Za-z_][A-Za-z0-9_]*__c\b/g) ?? [];
  return [...new Set(tokens)].filter((t) => !formula.includes(`.${t}`)); // drop tokens that are actually the tail of a dotted relationship reference
}

/** Real shape: `CustomObject.validationRules[].{fullName, errorConditionFormula}` — `fullName` is `Object.RuleName`. See `test/fixtures/validation-rule-changed`. */
export const validationRuleMissingFieldAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/validation-rule-missing-field',
  title: 'Validation rule formula references a field that does not exist',
  defaultSeverity: 'error',
  sourceType: 'ValidationRule',
  referenceKindLabel: 'formula field reference',
  extractReferences(root, key) {
    const objectApiName = key.fullName.split('.')[0]!;
    const formula = textOf(root.errorConditionFormula);
    return extractSameObjectFieldTokens(formula).map((field) => ({
      key: fieldKey(objectApiName, field),
      path: 'errorConditionFormula',
    }));
  },
});

/** Real shape: `CustomField.formula` (present only on formula-type fields). `key.parentFullName` is the owning object (see `ComponentKey.parentFullName` doc). */
export const formulaFieldMissingFieldAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/formula-field-missing-field',
  title: 'Formula field references a field that does not exist',
  defaultSeverity: 'error',
  sourceType: 'CustomField',
  referenceKindLabel: 'formula field reference',
  extractReferences(root, key) {
    const objectApiName = key.parentFullName ?? key.fullName.split('.')[0]!;
    const formula = textOf(root.formula);
    return extractSameObjectFieldTokens(formula)
      .filter((field) => `${objectApiName}.${field}` !== key.fullName) // a formula referencing itself isn't a missing-dependency hazard
      .map((field) => ({ key: fieldKey(objectApiName, field), path: 'formula' }));
  },
});

/** Real Flow action-call shape: `Flow.actionCalls[].{name, actionName, actionType}` — an invocable Apex action names the class via `actionName` when `actionType` is `apex`. */
export const flowMissingApexActionAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/flow-missing-apex-action',
  title: 'Flow calls an Apex invocable action that does not exist',
  defaultSeverity: 'error',
  sourceType: 'Flow',
  referenceKindLabel: 'Apex action-call reference',
  extractReferences(root) {
    const refs: ExtractedReference[] = [];
    for (const call of arrayOf<Record<string, unknown>>(root.actionCalls)) {
      const actionType = textOf(call?.actionType);
      const actionName = textOf(call?.actionName);
      if (actionType === 'apex' && actionName) {
        refs.push({
          key: { type: 'ApexClass', fullName: actionName },
          path: 'actionCalls.actionName',
        });
      }
    }
    return refs;
  },
});

/** Real shape: `QuickAction.fieldOverrides[].field` (see `test/fixtures/quickaction-fieldoverrides-reordered-identical`). */
export const quickActionMissingFieldAnalyzer = makeMissingReferenceAnalyzer({
  id: 'dependencies/quickaction-missing-field',
  title: 'Quick action field override references a field that does not exist',
  defaultSeverity: 'error',
  sourceType: 'QuickAction',
  referenceKindLabel: 'field-override reference',
  extractReferences(root) {
    const targetObject = textOf(root.targetObject);
    if (!targetObject) return [];
    const refs: ExtractedReference[] = [];
    for (const override of arrayOf<Record<string, unknown>>(root.fieldOverrides)) {
      const field = textOf(override?.field);
      if (field && isCustomFieldApiName(field)) {
        refs.push({ key: fieldKey(targetObject, field), path: `fieldOverrides.${field}` });
      }
    }
    return refs;
  },
});

export const DEPENDENCY_ANALYZERS: readonly Analyzer[] = [
  layoutMissingFieldAnalyzer,
  layoutMissingRecordTypeAnalyzer,
  validationRuleMissingFieldAnalyzer,
  formulaFieldMissingFieldAnalyzer,
  flowMissingApexActionAnalyzer,
  quickActionMissingFieldAnalyzer,
];

// Re-exported so `permission-rules.ts` (a different analyzer category, but
// the same "missing target dependency" mechanics) can build on the exact
// same engine and helpers rather than a second, possibly-drifted copy.
export { makeMissingReferenceAnalyzer, fieldKey, recordTypeKey, isCustomFieldApiName };
