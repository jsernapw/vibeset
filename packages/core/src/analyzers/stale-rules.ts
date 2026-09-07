import type { Analyzer, AnalysisContext, Finding } from '../types/analyzer.js';
import { fileWithSuffix, parseComponentXml, textOf } from './component-utils.js';

/** How many major API-version numbers behind the org's current version counts as "far behind" enough to flag. Deliberately conservative (Salesforce ships 3 releases/year, so 5 versions is well over a year old) to avoid nagging on routine, harmless version gaps. */
const STALE_VERSION_GAP = 5;

const API_VERSION_BEHIND_ID = 'stale/api-version-far-behind';

const API_VERSIONED_TYPES = new Set([
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
]);

function parseMajorVersion(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export const apiVersionFarBehindAnalyzer: Analyzer = {
  id: API_VERSION_BEHIND_ID,
  title: "Component API version is far behind the org's current version",
  category: 'stale',
  defaultSeverity: 'info',
  appliesTo(ctx: AnalysisContext) {
    return (
      Boolean(ctx.target?.currentApiVersion) &&
      ctx.packageComponents.some((c) => API_VERSIONED_TYPES.has(c.key.type))
    );
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const currentVersion = parseMajorVersion(ctx.target?.currentApiVersion);
    if (currentVersion === undefined) return [];
    const findings: Finding[] = [];
    for (const component of ctx.packageComponents) {
      if (!API_VERSIONED_TYPES.has(component.key.type)) continue;
      const metaFile = fileWithSuffix(component, '-meta.xml');
      const root = metaFile
        ? parseComponentXml(metaFile.content)
        : parseComponentXml(component.content);
      const componentVersion = parseMajorVersion(textOf(root?.apiVersion));
      if (componentVersion === undefined) continue;
      const gap = currentVersion - componentVersion;
      if (gap < STALE_VERSION_GAP) continue;
      findings.push({
        analyzerId: API_VERSION_BEHIND_ID,
        severity: 'info',
        title: `"${component.key.fullName}" is compiled against API ${componentVersion}, ${gap} versions behind the org's ${currentVersion}`,
        detail:
          `The org's current API version is ${currentVersion}.0, but "${component.key.fullName}" is still ` +
          `compiled against ${componentVersion}.0 — ${gap} major releases old (roughly ${Math.floor(gap / 3)}+ ` +
          `years, at Salesforce's three-release-per-year cadence). Older API versions can carry different ` +
          `runtime behavior (sharing enforcement defaults, validation rule bypass rules, etc.) than what the ` +
          `same code would get on a current version.`,
        recommendation: `Recompile/re-save "${component.key.fullName}" against a current API version once its behavior has been verified — do not bump the version number alone without testing, since some behavior changes are intentionally version-gated.`,
        key: component.key,
      });
    }
    return findings;
  },
};

const INACTIVE_VALIDATION_RULE_ID = 'stale/inactive-validation-rule';

export const inactiveValidationRuleAnalyzer: Analyzer = {
  id: INACTIVE_VALIDATION_RULE_ID,
  title: 'Validation rule in the package is inactive',
  category: 'stale',
  defaultSeverity: 'info',
  appliesTo(ctx: AnalysisContext) {
    return ctx.packageComponents.some((c) => c.key.type === 'ValidationRule');
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const component of ctx.packageComponents) {
      if (component.key.type !== 'ValidationRule') continue;
      const root = parseComponentXml(component.content);
      if (!root) continue;
      if (textOf(root.active) !== 'false') continue;
      findings.push({
        analyzerId: INACTIVE_VALIDATION_RULE_ID,
        severity: 'info',
        title: `Validation rule "${component.key.fullName}" is inactive`,
        detail: `"${component.key.fullName}" has \`<active>false</active>\` — deploying it will not enforce anything until someone activates it. If the intent was to enforce this rule, the deployment as-is will silently not do that.`,
        recommendation: `Confirm the inactive state is intentional (e.g. a rule being staged for later) — if not, set \`<active>true</active>\` before deploying.`,
        key: component.key,
      });
    }
    return findings;
  },
};

const FLOW_VERSION_STATUS_ID = 'stale/flow-version-status';

export const flowVersionStatusAnalyzer: Analyzer = {
  id: FLOW_VERSION_STATUS_ID,
  title: 'Flow version being deployed is Obsolete or Draft',
  category: 'stale',
  defaultSeverity: 'info',
  appliesTo(ctx: AnalysisContext) {
    return ctx.packageComponents.some((c) => c.key.type === 'Flow');
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const component of ctx.packageComponents) {
      if (component.key.type !== 'Flow') continue;
      const root = parseComponentXml(component.content);
      if (!root) continue;
      const status = textOf(root.status);
      if (status === 'Obsolete') {
        findings.push({
          analyzerId: FLOW_VERSION_STATUS_ID,
          severity: 'warning',
          title: `Flow "${component.key.fullName}" being deployed is marked Obsolete`,
          detail: `"${component.key.fullName}" has \`<status>Obsolete</status>\`. Deploying an Obsolete Flow version has no runtime effect — Salesforce will never run it — so this deployment either does nothing useful for this component or is deploying the wrong version.`,
          recommendation: `Retrieve/select the Active (or latest Draft, if intentionally still in progress) version of "${component.key.fullName}" instead.`,
          key: component.key,
        });
      } else if (status === 'Draft') {
        findings.push({
          analyzerId: FLOW_VERSION_STATUS_ID,
          severity: 'info',
          title: `Flow "${component.key.fullName}" being deployed is a Draft version`,
          detail: `"${component.key.fullName}" has \`<status>Draft</status>\` — it will be deployed but will not run for any user until it (or a later version) is activated.`,
          recommendation: `If this Flow is meant to be live immediately after deploy, activate it (or deploy an already-Active version) rather than relying on a separate manual activation step.`,
          key: component.key,
        });
      }
    }
    return findings;
  },
};

const INACTIVE_WORKFLOW_RULE_ID = 'stale/inactive-workflow-rule';

export const inactiveWorkflowRuleAnalyzer: Analyzer = {
  id: INACTIVE_WORKFLOW_RULE_ID,
  title: 'Workflow rule in the package is inactive',
  category: 'stale',
  defaultSeverity: 'info',
  appliesTo(ctx: AnalysisContext) {
    return ctx.packageComponents.some((c) => c.key.type === 'WorkflowRule');
  },
  analyze(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const component of ctx.packageComponents) {
      if (component.key.type !== 'WorkflowRule') continue;
      const root = parseComponentXml(component.content);
      if (!root) continue;
      if (textOf(root.active) !== 'false') continue;
      findings.push({
        analyzerId: INACTIVE_WORKFLOW_RULE_ID,
        severity: 'info',
        title: `Workflow rule "${component.key.fullName}" is inactive`,
        detail: `"${component.key.fullName}" has \`<active>false</active>\` — none of its actions will run until it's activated.`,
        recommendation: `Confirm the inactive state is intentional; if the rule (and its Flow-based or Process Builder replacement, if any) should be live, activate it before or immediately after this deployment.`,
        key: component.key,
      });
    }
    return findings;
  },
};

export const STALE_ANALYZERS: readonly Analyzer[] = [
  apiVersionFarBehindAnalyzer,
  inactiveValidationRuleAnalyzer,
  flowVersionStatusAnalyzer,
  inactiveWorkflowRuleAnalyzer,
];
