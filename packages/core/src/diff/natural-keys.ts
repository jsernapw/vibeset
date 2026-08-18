/**
 * Data-driven table of Salesforce's "natural keys" — the field that
 * identifies a member of a repeated XML collection, so the differ (and the
 * canonicalizer's sort pass) can match/order items by identity instead of
 * position. A reordered `<fields>` block must diff as no-change; this table
 * is what makes that possible.
 *
 * Why a table instead of hardcoding per-type logic: Salesforce's metadata
 * schema is large (100+ types in Phase 2) and each collection element uses
 * its own identity field name (`fullName`, `field`, `apexClass`, `tab`...).
 * There is no way to derive this from SDR's `RegistryAccess` — the registry
 * knows a type's directory/suffix/decomposition strategy, but not the
 * identity field of an in-file repeated element, because that's an XML
 * Schema (XSD) fact, not a `RegistryAccess` fact. So a small explicit table
 * is the correct approach here (the task brief anticipates this: "a small
 * explicit table of natural keys per collection element is legitimate and
 * expected"). Keep it data, not code, so Phase 2 additions are one-line
 * diffs.
 *
 * Lookup order (see `resolveCollectionKeyFields`):
 *   1. `NATURAL_KEYS[rootType][collectionTag]`     — type-specific override
 *   2. `NATURAL_KEYS['*'][collectionTag]`          — generic default
 *   3. `GENERIC_KEY_CANDIDATES` heuristic          — best-effort guess
 *   4. stable content hash of the item             — last-resort fallback
 *
 * Overrides are only needed when the *same tag name* means something
 * different depending on the parent type. The clearest example: `<fields>`
 * under `CustomObject` is a list of `CustomField`s keyed by `fullName`, but
 * `<fields>` under a Flow `<screens>` element is a list of screen fields
 * keyed by `name`. Both appear in this table.
 */

import { sha256Hex } from '../hash.js';

/** Key rule for one collection tag. Composite keys join resolved field values with `::`. */
export interface CollectionKeyRule {
  readonly keyFields: readonly string[];
}

function rule(...keyFields: string[]): CollectionKeyRule {
  return { keyFields };
}

/**
 * `'*'` is the generic bucket, consulted for any root type that doesn't
 * have its own override. Add a root-type-specific bucket only when a tag
 * name is ambiguous across types (see file header).
 */
export const NATURAL_KEYS: Record<string, Record<string, CollectionKeyRule>> = {
  '*': {
    // CustomObject decomposition
    fields: rule('fullName'),
    listViews: rule('fullName'),
    recordTypes: rule('fullName'),
    validationRules: rule('fullName'),
    webLinks: rule('fullName'),
    compactLayouts: rule('fullName'),
    fieldSets: rule('fullName'),
    businessProcesses: rule('fullName'),
    sharingReasons: rule('fullName'),
    namedFilters: rule('fullName'),
    actionOverrides: rule('actionName', 'formFactor'),

    // Picklist value sets (CustomField.valueSet.valueSetDefinition.value,
    // and standard-picklist restrictions) — the value's own API name.
    value: rule('fullName'),
    valueSettings: rule('valueName'),
    // RecordType's per-field picklist availability: one entry per field,
    // each with its own nested `values` collection (handled by the `value`
    // rule above since the nested tag is also literally `values`/`value`).
    picklistValues: rule('picklist'),

    // Layout
    layoutSections: rule('label'),
    layoutItems: rule('field'),
    relatedLists: rule('relatedList'),
    relatedContent: rule('fullName'),
    miniLayout: rule('fullName'),

    // Profile / PermissionSet grid — the #1 source of diff noise (see
    // profiles.ts for the absent-vs-removed handling built on top of this).
    fieldPermissions: rule('field'),
    objectPermissions: rule('object'),
    classAccesses: rule('apexClass'),
    pageAccesses: rule('apexPage'),
    recordTypeVisibilities: rule('recordType'),
    userPermissions: rule('name'),
    applicationVisibilities: rule('application'),
    customPermissions: rule('name'),
    customMetadataTypeAccesses: rule('name'),
    customSettingAccesses: rule('name'),
    externalDataSourceAccesses: rule('externalDataSource'),
    externalCredentialPrincipalAccesses: rule('externalCredentialPrincipal'),
    flowAccesses: rule('flow'),
    layoutAssignments: rule('layout', 'recordType'),
    categoryGroupVisibilities: rule('dataCategoryGroup'),
    loginIpRanges: rule('startAddress', 'endAddress'),
    tabVisibilities: rule('tab'), // Profile's tab-visibility wrapper
    tabSettings: rule('tab'), // PermissionSet's tab-visibility wrapper (different element name, same shape)

    // CustomLabels
    labels: rule('fullName'),

    // Translations
    customLabels: rule('name'),
    customApplications: rule('application'),
    customTabs: rule('name'),
    customPageWebLinks: rule('name'),
    reportTypes: rule('name'),
    quickActions: rule('name'),
    flowDefinitions: rule('fullName'),

    // Phase 2 additions below. Verified against the real Salesforce Metadata
    // API WSDL/XSD (salesforce_metadata_api_common.xsd, shipped with the
    // Salesforce Extension Pack for VS Code) rather than guessed from
    // memory — RegistryAccess doesn't expose element-level identity fields
    // (see file header), and getting one of these wrong silently degrades
    // to the safe content-hash fallback rather than mismatching, but a
    // right answer gives real item-level diffs instead of delete+add noise.

    // RecordType.picklistValues.values AND BusinessProcess.values — both
    // are `PicklistValue[]` (extends `GlobalPicklistValue` extends
    // `Metadata`), keyed by the inherited `fullName`. NOT the same as
    // CustomMetadata's own `values` tag, which is a different, unrelated
    // shape (`CustomMetadataValue`, keyed by `field`) — see the
    // `CustomMetadata`-specific override bucket below for that collision.
    values: rule('fullName'),

    // CustomObject.fieldSets — FieldSetItem, keyed by the field API name.
    displayedFields: rule('field'),
    availableFields: rule('field'),

    // CustomObject.listViews.filters — ListViewFilter's own field is
    // literally named `<filter>` (not `<field>`; verified against the XSD,
    // easy to get wrong from memory). Distinct from Flow's own `filters`
    // override below (CollectionProcessor filter, keyed by `field`) — same
    // tag name, different type-scoped meaning, which is exactly the
    // ambiguity this table is designed to disambiguate by root type.
    filters: rule('filter'),

    // WorkflowRule.criteriaItems — FilterItem, keyed by `field`.
    criteriaItems: rule('field'),
    // WorkflowRule.actions — WorkflowActionReference (the XSD types this
    // element as bare `xsd:string` at the choice-group level, but its own
    // `<xsd:appinfo>` documents the real runtime shape as
    // `WorkflowActionReference[]`, i.e. `{name, type}` pairs referencing an
    // action of a given kind). Composite key: two different action kinds
    // can legitimately share a `name` (e.g. a FieldUpdate and a Task both
    // named "Notify").
    actions: rule('name', 'type'),

    // GlobalValueSet.customValue / StandardValueSet.standardValue — both
    // `CustomValue`-shaped (`StandardValue extends CustomValue`), keyed by
    // the inherited `fullName`.
    customValue: rule('fullName'),
    standardValue: rule('fullName'),

    // NamedCredential.namedCredentialParameters (the newer External
    // Credential-based NamedCredential shape) — no single field is
    // documented as unique, so a composite of name+kind is used
    // defensively (e.g. two "Header" parameters could share a name in
    // theory; the pair should not).
    namedCredentialParameters: rule('parameterName', 'parameterType'),

    // ConnectedApp.ipRanges — ConnectedAppIpRange has no identity field of
    // its own; the (start, end) pair is what actually identifies a range.
    ipRanges: rule('start', 'end'),

    // Profile/PermissionSet Agentforce agent access grid — same
    // retrieve-pairing shape as the rest of the permission grid, but the
    // top-level ambiguity handling lives in profiles.ts's own
    // PERMISSION_COLLECTIONS table; this entry only matters if this
    // collection is ever reached through the generic differ instead (e.g.
    // a fixture diffing a bare fragment).
    agentAccesses: rule('agentName'),

    // QuickAction.fieldOverrides — FieldOverride, keyed by field. (Already
    // resolvable via GENERIC_KEY_CANDIDATES, which includes 'field'; kept
    // explicit here for discoverability since QuickAction is a Phase 2
    // priority type.)
    fieldOverrides: rule('field'),

    // Layout/CustomApplication PlatformActionList.platformActionListItems —
    // PlatformActionListItem has no single unique field; (actionName,
    // actionType) together identify one action's slot in the list.
    platformActionListItems: rule('actionName', 'actionType'),

    // Report — ReportAggregate keyed by its own developer name;
    // ReportAggregateFilter keyed by the aggregate it filters.
    // ReportColumn.field IS present (and 'field' happens to also be in
    // GENERIC_KEY_CANDIDATES), kept explicit for the same reason as above.
    // NOTE: ReportFilterItem (Report.filter.criteriaItems) and
    // ReportCrossFilter have no reliably unique field and are deliberately
    // left untabled — they degrade to the safe content-hash fallback
    // rather than risk a wrong guess.
    aggregates: rule('developerName'),
    aggregateFilters: rule('aggregate'),
    columns: rule('field'), // Report.columns (ReportColumn); ListView.columns is a plain string list and bypasses this (see computeItemKey's scalar short-circuit).
  },

  /**
   * CustomMetadata (`.md-meta.xml` records) reuses the `values` tag for a
   * completely different shape than RecordType/BusinessProcess's picklist
   * `values` (see the `'*'` bucket above): here each `<values>` element is a
   * `CustomMetadataValue` — one field/value pair per custom field on the
   * record — keyed by `field`, the field's own API name. This is the same
   * kind of same-tag-different-meaning collision Flow's `fields` override
   * exists to handle.
   */
  CustomMetadata: {
    values: rule('field'),
  },

  // Flow: element collections are keyed by `<name>`, not `<fullName>`, and
  // Flow re-uses several generic tag names (`fields`, `choices`) for
  // unrelated concepts (screen fields, not CustomFields).
  Flow: {
    fields: rule('name'), // Flow Screen fields — NOT CustomObject fields
    rules: rule('name'), // Decision/wait rules
    actionCalls: rule('name'),
    assignments: rule('name'),
    decisions: rule('name'),
    recordCreates: rule('name'),
    recordLookups: rule('name'),
    recordUpdates: rule('name'),
    recordDeletes: rule('name'),
    screens: rule('name'),
    loops: rule('name'),
    subflows: rule('name'),
    variables: rule('name'),
    constants: rule('name'),
    formulas: rule('name'),
    textTemplates: rule('name'),
    choices: rule('name'),
    dynamicChoiceSets: rule('name'),
    stages: rule('name'),
    waits: rule('name'),
    collectionProcessors: rule('name'),
    transforms: rule('name'),
    connectors: rule('targetReference'),
    inputParameters: rule('name'),
    outputParameters: rule('name'),
    inputAssignments: rule('field'),
    filters: rule('field'),
  },
};

/**
 * Fields tried, in order, when a collection tag has no table entry (neither
 * a root-type override nor a `'*'` default). Covers the vast majority of
 * Salesforce identity-field naming conventions. If none of these resolve on
 * a given item, `computeItemKey` falls back to a content hash — matching
 * degrades to "same content = same item" for that one untabled collection,
 * which is a safe (if less pretty) default. Extend the table above instead
 * of this list when you learn a new collection's real key field.
 */
export const GENERIC_KEY_CANDIDATES: readonly string[] = [
  'fullName',
  'name',
  'field',
  'object',
  'apexClass',
  'apexPage',
  'tab',
  'application',
  'flow',
  'recordType',
  'externalDataSource',
  'label',
  'layout',
];

/** Tag names known to be Salesforce natural-key collections, across every root type. Used to force array parsing even for single-element collections (see normalize.ts). */
export const KNOWN_COLLECTION_TAGS: ReadonlySet<string> = new Set(
  Object.values(NATURAL_KEYS).flatMap((bucket) => Object.keys(bucket)),
);

export function resolveCollectionKeyFields(
  rootType: string,
  collectionTag: string,
): readonly string[] | undefined {
  return (
    NATURAL_KEYS[rootType]?.[collectionTag]?.keyFields ??
    NATURAL_KEYS['*']?.[collectionTag]?.keyFields
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deterministic string form of any value, used only as a last-resort matching key. Object keys are sorted so key computation doesn't depend on parse order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `sortKey` is for internal matching/ordering only (namespaced by kind, so
 * a "hash:" fallback can never collide with a real "key:" value). `displayKey`
 * is the human-meaningful natural key — this is what callers should put in
 * `DiffEntry.key` / use to build a `path` segment.
 */
export interface ItemKey {
  readonly sortKey: string;
  readonly displayKey: string;
}

/**
 * Resolves the natural key for one item of a collection.
 * MUST be used identically by both the canonicalizer (for deterministic
 * sort order) and the differ (for left/right item matching) — if they ever
 * disagree, "equal hash" and "differ finds no changes" can disagree too,
 * silently breaking the hash short-circuit's correctness guarantee.
 */
export function computeItemKey(item: unknown, keyFields: readonly string[] | undefined): ItemKey {
  if (!isPlainObject(item)) {
    // Scalar collection member (e.g. repeated `<categories>Cat1</categories>`).
    const s = String(unwrapCdata(item));
    return { sortKey: `scalar:${s}`, displayKey: s };
  }

  const fieldsToTry = keyFields ?? GENERIC_KEY_CANDIDATES;
  for (const field of keyFields ? [keyFields] : fieldsToTry.map((f) => [f])) {
    const parts: string[] = [];
    let allResolved = true;
    for (const f of field) {
      const raw = item[f];
      const scalar = unwrapCdata(raw);
      if (scalar === undefined || (isPlainObject(scalar) && Object.keys(scalar).length === 0)) {
        // Optional composite-key segment (e.g. layoutAssignments without a recordType) resolves to empty, not a failure.
        parts.push('');
        continue;
      }
      if (isPlainObject(scalar) || Array.isArray(scalar)) {
        allResolved = false;
        break;
      }
      parts.push(String(scalar));
    }
    if (allResolved && parts.some((p) => p !== '')) {
      return {
        sortKey: `key:${parts.join('::')}`,
        displayKey: parts.filter((p) => p !== '').join('.'),
      };
    }
  }

  // Last resort: no identifiable key field. Match/sort by content instead —
  // degrades to "same content = same item" for this one untabled
  // collection, which is safe (never mismatches unrelated items) if less
  // legible. A short content hash keeps `displayKey` (and therefore
  // `DiffEntry.path`) from becoming an enormous stringified blob.
  const digest = sha256Hex(stableStringify(item)).slice(0, 12);
  return { sortKey: `hash:${digest}`, displayKey: `~${digest}` };
}

/** CDATA leaves parse to `{ __cdata: "text" }`; unwrap to the plain string for key/scalar comparison. See normalize.ts for why CDATA is preserved structurally elsewhere. */
export function unwrapCdata(value: unknown): unknown {
  if (isPlainObject(value) && Object.keys(value).length === 1 && '__cdata' in value) {
    return (value as Record<string, unknown>).__cdata;
  }
  return value;
}
