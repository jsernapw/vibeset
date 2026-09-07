import type { Analyzer, AnalysisContext, Finding } from '../types/analyzer.js';
import type { ComponentKey } from '../types/metadata-source.js';
import { componentKeyString } from '../util/component-key.js';
import { arrayOf, parseComponentXml, textOf } from './component-utils.js';

const REFERENCED_DELETION_ID = 'destructive/deleting-referenced-component';

function groupByType(keys: readonly ComponentKey[]): Map<string, ComponentKey[]> {
  const byType = new Map<string, ComponentKey[]>();
  for (const k of keys) {
    const list = byType.get(k.type) ?? [];
    list.push(k);
    byType.set(k.type, list);
  }
  return byType;
}

function describeGroups(byType: Map<string, ComponentKey[]>): string {
  return [...byType.entries()]
    .map(
      ([type, keys]) =>
        `${keys.length} ${type}${keys.length === 1 ? '' : 's'} (${keys.map((k) => k.fullName).join(', ')})`,
    )
    .join(' and ');
}

/**
 * Uses the injected `DependencyGraph` (the seam shared with the parallel
 * dependency-intelligence workstream) to catch the general case: anything
 * still referencing a component this deployment deletes, regardless of
 * type — a Layout, a Report, an Apex class, a Flow. `dependentsOf`
 * returning an empty array means "indexed, and nothing references it" per
 * the interface's contract (unlike `existsInTarget`, there is no
 * "unknown" case to worry about here once the graph is present at all —
 * see `appliesTo`, which only runs this rule when a graph was supplied).
 */
export const deletingReferencedComponentAnalyzer: Analyzer = {
  id: REFERENCED_DELETION_ID,
  title: 'Destructive change deletes a component still referenced elsewhere',
  category: 'destructive',
  defaultSeverity: 'error',
  appliesTo(ctx: AnalysisContext) {
    return (ctx.destructiveComponents?.length ?? 0) > 0 && ctx.dependencyGraph !== undefined;
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const graph = ctx.dependencyGraph;
    if (!graph) return [];
    const deletedSet = new Set((ctx.destructiveComponents ?? []).map(componentKeyString));
    const findings: Finding[] = [];
    for (const deletedKey of ctx.destructiveComponents ?? []) {
      const dependents = graph
        .dependentsOf(deletedKey)
        .filter((d) => !deletedSet.has(componentKeyString(d)));
      if (dependents.length === 0) continue;
      const byType = groupByType(dependents);
      findings.push({
        analyzerId: REFERENCED_DELETION_ID,
        severity: 'error',
        title: `Deleting ${deletedKey.type} "${deletedKey.fullName}" will break ${dependents.length} component(s) still referencing it`,
        detail: `${describeGroups(byType)} still reference ${deletedKey.type} "${deletedKey.fullName}", which this deployment deletes via a destructive change. The delete will either fail deploy validation or silently break those components at runtime.`,
        recommendation: `Remove ${deletedKey.type} "${deletedKey.fullName}" from the destructive changes, or first update/remove the referencing components (${dependents
          .slice(0, 5)
          .map((k) => `${k.type} ${k.fullName}`)
          .join(', ')}${dependents.length > 5 ? ', ...' : ''}) in a prior deployment.`,
        key: deletedKey,
        relatedKeys: dependents,
      });
    }
    return findings;
  },
};

const INPACKAGE_LAYOUT_FIELD_ID = 'destructive/deleting-field-referenced-by-inpackage-layout';

/**
 * The subset of the same hazard that needs NO dependency graph at all —
 * checkable purely from what's already in this deployment package. Ships
 * useful today rather than waiting on the parallel dependency-intelligence
 * workstream, and stays complementary (not redundant) with
 * `deletingReferencedComponentAnalyzer` above once that graph exists: this
 * one only ever sees references inside the package being built, the graph
 * rule sees the whole org.
 */
export const deletingFieldReferencedByInPackageLayoutAnalyzer: Analyzer = {
  id: INPACKAGE_LAYOUT_FIELD_ID,
  title: 'Destructive change deletes a field a Layout in the same package still references',
  category: 'destructive',
  defaultSeverity: 'error',
  appliesTo(ctx: AnalysisContext) {
    return (
      (ctx.destructiveComponents?.some((k) => k.type === 'CustomField') ?? false) &&
      ctx.packageComponents.some((c) => c.key.type === 'Layout')
    );
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const deletedFields = new Set(
      (ctx.destructiveComponents ?? [])
        .filter((k) => k.type === 'CustomField')
        .map((k) => k.fullName),
    );
    if (deletedFields.size === 0) return [];
    const findings: Finding[] = [];
    for (const layout of ctx.packageComponents) {
      if (layout.key.type !== 'Layout') continue;
      const root = parseComponentXml(layout.content);
      if (!root) continue;
      const objectApiName = layout.key.fullName.split('-')[0]!;
      const referenced = new Set<string>();
      for (const section of arrayOf<Record<string, unknown>>(root.layoutSections)) {
        for (const column of arrayOf<Record<string, unknown>>(section?.layoutColumns)) {
          for (const item of arrayOf<Record<string, unknown>>(column?.layoutItems)) {
            const field = textOf(item?.field);
            if (!field) continue;
            const candidate = field.includes('.') ? field : `${objectApiName}.${field}`;
            if (deletedFields.has(candidate)) referenced.add(candidate);
          }
        }
      }
      for (const field of referenced) {
        findings.push({
          analyzerId: INPACKAGE_LAYOUT_FIELD_ID,
          severity: 'error',
          title: `Layout "${layout.key.fullName}" still shows field "${field}", which this deployment deletes`,
          detail: `The destructive changes delete CustomField "${field}", but Layout "${layout.key.fullName}" — in the same deployment package — still places it on the page. Deploying both together will fail (the Layout references a field that no longer exists) or, if order-dependent, deploy the Layout with a dangling field reference.`,
          recommendation: `Remove the layoutItems entry for "${field}" from "${layout.key.fullName}" in the same package as the field deletion.`,
          key: { type: 'CustomField', fullName: field },
          relatedKeys: [layout.key],
        });
      }
    }
    return findings;
  },
};

export const DESTRUCTIVE_ANALYZERS: readonly Analyzer[] = [
  deletingReferencedComponentAnalyzer,
  deletingFieldReferencedByInPackageLayoutAnalyzer,
];
