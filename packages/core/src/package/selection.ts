import type { ComponentKey } from '../types/metadata-source.js';
import type { DiffResult } from '../types/diff.js';
import { componentKeyString } from '../util/component-key.js';

export type SelectionState = 'unchecked' | 'checked' | 'indeterminate';

/**
 * One node of a selection tree: an addressable id (a `componentKeyString`,
 * or a synthetic grouping id like a metadata type name) plus its children.
 * Built by `buildSelectionTree` from a `ComparisonResult`'s `DiffResult[]`,
 * but deliberately generic — the tri-state propagation logic itself doesn't
 * know or care what an id represents, which keeps it independently testable
 * and reusable for whatever grouping shape the UI ultimately wants (type ->
 * component -> decomposed child, or something flatter).
 */
export interface SelectionTreeNode {
  readonly id: string;
  readonly children?: readonly SelectionTreeNode[];
}

/**
 * Selection state over a tree of components with tri-state parent/child
 * propagation — the model behind "select this CustomObject and all its
 * CustomFields come with it; deselect one field and the object shows
 * indeterminate". Framework-free (no React/Zustand dependency): the `web`
 * package's store wraps this, but the actual propagation logic — the part
 * worth getting right and testing thoroughly — lives here in `core`.
 *
 * Design: the single source of truth is an explicit checked/unchecked flag
 * per LEAF id only (default unchecked). Every non-leaf node's state is
 * ALWAYS derived on read by aggregating its leaf descendants — never stored
 * separately — so there is no possibility of a stale ancestor/descendant
 * state disagreeing with each other. `setChecked` on a non-leaf simply
 * writes that same flag to every leaf underneath it.
 */
export class TriStateSelection {
  private readonly leafState = new Map<string, boolean>();
  private readonly childrenById = new Map<string, string[]>();
  private readonly allIds: string[] = [];

  constructor(roots: readonly SelectionTreeNode[]) {
    const index = (node: SelectionTreeNode): void => {
      this.allIds.push(node.id);
      const kids = node.children ?? [];
      this.childrenById.set(node.id, kids.map((c) => c.id));
      for (const c of kids) index(c);
    };
    for (const r of roots) index(r);
  }

  private leavesUnder(id: string): string[] {
    const kids = this.childrenById.get(id);
    if (!kids || kids.length === 0) return [id];
    return kids.flatMap((k) => this.leavesUnder(k));
  }

  /** Checks/unchecks `id` and every descendant leaf underneath it (a no-op walk of one element if `id` is itself a leaf). */
  setChecked(id: string, checked: boolean): void {
    for (const leaf of this.leavesUnder(id)) this.leafState.set(leaf, checked);
  }

  /** Derived tri-state for any node in the tree (leaf or internal), computed from its leaf descendants. */
  stateOf(id: string): SelectionState {
    const leaves = this.leavesUnder(id);
    if (leaves.length === 0) return 'unchecked';
    const checkedCount = leaves.filter((l) => this.leafState.get(l) === true).length;
    if (checkedCount === 0) return 'unchecked';
    if (checkedCount === leaves.length) return 'checked';
    return 'indeterminate';
  }

  /** All leaf ids currently checked — the flat list a deployment package is actually built from. */
  selectedLeafIds(): string[] {
    return this.allIds.filter((id) => (this.childrenById.get(id)?.length ?? 0) === 0 && this.leafState.get(id) === true);
  }

  /** Clears every explicit checked flag. Node states all revert to `'unchecked'`. */
  reset(): void {
    this.leafState.clear();
  }
}

/**
 * Builds a selection tree from a `ComparisonResult`'s `DiffResult[]`,
 * grouping child components (identified by `ComponentKey.parentFullName`)
 * under their parent when the parent is also present in the same result
 * set — e.g. a `CustomObject` groups its own `CustomField` results as
 * children. Components whose parent isn't present in `results` (out of the
 * comparison's `TypeFilter` scope, or simply no parent) become top-level
 * nodes. `'identical'` components are excluded — there's nothing to select
 * for a component with no reportable change.
 */
export function buildSelectionTree(results: readonly DiffResult[]): SelectionTreeNode[] {
  const changed = results.filter((r) => r.status !== 'identical');
  const byId = new Map<string, SelectionTreeNode & { childIds: string[] }>();
  for (const r of changed) {
    byId.set(componentKeyString(r.key), { id: componentKeyString(r.key), childIds: [] });
  }

  const roots: string[] = [];
  for (const r of changed) {
    const id = componentKeyString(r.key);
    const parentFullName = r.key.parentFullName;
    const parentId = parentFullName ? findParentId(byId, r.key.type, parentFullName) : undefined;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.childIds.push(id);
    } else {
      roots.push(id);
    }
  }

  const toNode = (id: string): SelectionTreeNode => {
    const entry = byId.get(id)!;
    const children = entry.childIds.map(toNode);
    return children.length > 0 ? { id, children } : { id };
  };

  return roots.map(toNode);
}

/**
 * `ComponentKey.parentFullName` doesn't carry the parent's own type (a
 * `CustomField`'s parent is a `CustomObject`, but the key only says
 * `parentFullName: "Account"`). Every Phase 1 decomposed-child type's
 * parent is a `CustomObject`, so that's the only mapping needed here; this
 * is intentionally a small, documented table (matching the spirit of
 * `natural-keys.ts`) rather than a dependency on SDR's full child-type
 * graph, which would be overkill for Phase 1's narrow scope.
 */
const CHILD_TO_PARENT_TYPE: Readonly<Record<string, string>> = {
  CustomField: 'CustomObject',
  ValidationRule: 'CustomObject',
  RecordType: 'CustomObject',
  ListView: 'CustomObject',
  WebLink: 'CustomObject',
  BusinessProcess: 'CustomObject',
  CompactLayout: 'CustomObject',
  FieldSet: 'CustomObject',
};

function findParentId(
  byId: ReadonlyMap<string, SelectionTreeNode>,
  childType: string,
  parentFullName: string,
): string | undefined {
  const parentType = CHILD_TO_PARENT_TYPE[childType];
  if (!parentType) return undefined;
  return componentKeyString({ type: parentType, fullName: parentFullName });
}

/**
 * Resolves a `TriStateSelection`'s checked leaves back into `ComponentKey`s
 * for `DeploymentPackage.components`/`.destructiveComponents`, dispatching
 * on each leaf's `DiffResult.status`.
 *
 * Convention (see `compare/comparison-engine.ts` test suite for the
 * established semantics): `left` is the "before" comparison operand and
 * `right` is "after". For deployment-package purposes, present
 * `left = target org (current state)` and `right = desired/source state`
 * when starting the comparison — then `'new'`/`'changed'` (present or
 * different in the desired state) become the add/update set, and
 * `'deleted'` (present in target, absent from desired state) becomes the
 * destructive set.
 */
export function selectionToPackageComponents(
  selection: TriStateSelection,
  resultsByKeyString: ReadonlyMap<string, DiffResult>,
): { readonly components: ComponentKey[]; readonly destructiveComponents: ComponentKey[] } {
  const components: ComponentKey[] = [];
  const destructiveComponents: ComponentKey[] = [];

  for (const id of selection.selectedLeafIds()) {
    const result = resultsByKeyString.get(id);
    if (!result) continue;
    if (result.status === 'deleted') destructiveComponents.push(result.key);
    else if (result.status === 'new' || result.status === 'changed') components.push(result.key);
    // 'identical' components are never in the selection tree in the first place.
  }

  return { components, destructiveComponents };
}
