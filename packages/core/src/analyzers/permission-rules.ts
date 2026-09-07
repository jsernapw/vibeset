import type { Analyzer, AnalysisContext, Finding } from '../types/analyzer.js';
import type { ComponentKey } from '../types/metadata-source.js';
import { PERMISSION_COLLECTIONS } from '../diff/profiles.js';
import { componentKeyString } from '../util/component-key.js';
import { arrayOf, parseComponentXml, textOf } from './component-utils.js';
import { fieldKey, recordTypeKey } from './dependency-rules.js';

/**
 * Profile/PermissionSet hazard: a permission GRANT (not a revoke — see
 * `grantsAccess` below) referencing a component that does not exist in the
 * package and is CONFIRMED absent from the target org.
 *
 * This reuses `diff/profiles.ts`'s `PERMISSION_COLLECTIONS` table (the
 * same tag/identity-field mapping the differ already trusts) rather than
 * re-deriving it, and applies the exact same "unknown is not evidence of
 * absence" discipline that file's own header describes for the retrieve-
 * pairing problem: a Profile retrieved alone looks like it grants access
 * to almost nothing, and a naive "flag every reference this file doesn't
 * also contain" rule would misfire on every real-world Profile deploy.
 * Here the discipline is enforced by only trusting the dependency graph's
 * `existsInTarget(key) === false` (confirmed absent) — `undefined`
 * ("not indexed yet") is treated as "say nothing", not "assume absent".
 */
const ID = 'permissions/grants-nonexistent-target';

const RELEVANT_TAGS = new Set([
  'fieldPermissions',
  'objectPermissions',
  'classAccesses',
  'pageAccesses',
  'recordTypeVisibilities',
  'tabVisibilities',
  'tabSettings',
  'applicationVisibilities',
  'flowAccesses',
]);

/** True when this entry actually GRANTS access rather than explicitly denying/hiding it — an out-of-package reference on a deny entry is a no-op, not a hazard. Field names/values verified against the real Metadata API shapes already exercised by `test/fixtures/profile-*`/`permissionset-*`. */
function grantsAccess(tag: string, entry: Record<string, unknown>): boolean {
  switch (tag) {
    case 'classAccesses':
    case 'pageAccesses':
    case 'flowAccesses':
      return textOf(entry.enabled) === 'true';
    case 'fieldPermissions':
      return textOf(entry.readable) === 'true' || textOf(entry.editable) === 'true';
    case 'objectPermissions':
      return [
        'allowRead',
        'allowCreate',
        'allowEdit',
        'allowDelete',
        'viewAllRecords',
        'modifyAllRecords',
      ].some((f) => textOf(entry[f]) === 'true');
    case 'recordTypeVisibilities':
      return textOf(entry.visible) === 'true';
    case 'tabVisibilities': {
      const v = textOf(entry.visibility);
      return v !== undefined && v !== 'Hidden';
    }
    case 'tabSettings': {
      const v = textOf(entry.visibility);
      return v === 'Visible' || v === 'Available';
    }
    case 'applicationVisibilities':
      return textOf(entry.visible) === 'true';
    default:
      return true;
  }
}

function refToComponentKey(refType: string, ref: string): ComponentKey {
  if (refType === 'CustomField' || refType === 'RecordType') {
    const [objectApiName, member] = ref.split('.') as [string, string | undefined];
    if (member === undefined) return { type: refType, fullName: ref };
    return refType === 'CustomField'
      ? fieldKey(objectApiName, member)
      : recordTypeKey(objectApiName, member);
  }
  return { type: refType, fullName: ref };
}

export const permissionGrantsNonexistentTargetAnalyzer: Analyzer = {
  id: ID,
  title: 'Profile/PermissionSet grants access to a component confirmed absent from the target org',
  category: 'permissions',
  defaultSeverity: 'warning',
  appliesTo(ctx: AnalysisContext) {
    return ctx.packageComponents.some(
      (c) => c.key.type === 'Profile' || c.key.type === 'PermissionSet',
    );
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const graph = ctx.dependencyGraph;
    if (!graph) return [];
    const packageKeys = new Set(ctx.packageComponents.map((c) => componentKeyString(c.key)));
    const findings: Finding[] = [];

    for (const component of ctx.packageComponents) {
      if (component.key.type !== 'Profile' && component.key.type !== 'PermissionSet') continue;
      const root = parseComponentXml(component.content);
      if (!root) continue;

      for (const spec of PERMISSION_COLLECTIONS) {
        if (!RELEVANT_TAGS.has(spec.tag)) continue;
        for (const raw of arrayOf<Record<string, unknown>>(root[spec.tag])) {
          if (typeof raw !== 'object' || raw === null) continue;
          if (!grantsAccess(spec.tag, raw)) continue;
          const ref = textOf(raw[spec.identityField]);
          if (!ref) continue;

          const refKey = refToComponentKey(spec.refType, ref);
          if (packageKeys.has(componentKeyString(refKey))) continue;
          if (graph.existsInTarget(refKey) !== false) continue; // unknown or confirmed present: not a hazard

          findings.push({
            analyzerId: ID,
            severity: 'warning',
            title: `${component.key.type} "${component.key.fullName}" grants access to ${spec.refType} "${ref}", which is missing`,
            detail:
              `The ${spec.tag} entry for "${ref}" on ${component.key.type} "${component.key.fullName}" grants ` +
              `access, but ${spec.refType} "${ref}" is neither part of this deployment package nor present in ` +
              `the target org (confirmed absent) — deploying this ${component.key.type} as-is will either fail ` +
              `metadata validation or grant access to a component that doesn't exist.`,
            recommendation: `Add ${spec.refType} "${ref}" to the deployment package if it should exist in the target, or remove the ${spec.tag} entry for it from "${component.key.fullName}" if the grant is stale.`,
            key: component.key,
            relatedKeys: [refKey],
            path: spec.tag,
          });
        }
      }
    }
    return findings;
  },
};

export const PERMISSION_ANALYZERS: readonly Analyzer[] = [
  permissionGrantsNonexistentTargetAnalyzer,
];
