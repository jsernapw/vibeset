import { ComponentSet, DestructiveChangesType, RegistryAccess, SourceComponent } from '@salesforce/source-deploy-retrieve';
import type { ComponentKey } from '../types/metadata-source.js';

export type DestructiveMode = 'pre' | 'post';

export interface GeneratePackageXmlParams {
  readonly components: readonly ComponentKey[];
  readonly destructiveComponents: readonly ComponentKey[];
  readonly destructiveMode?: DestructiveMode;
  readonly apiVersion?: string;
  readonly registry?: RegistryAccess;
}

export interface GeneratedPackageXml {
  /** `package.xml` for `components` — the add/update manifest. */
  readonly packageXml: string;
  /**
   * `destructiveChangesPre.xml` or `destructiveChangesPost.xml` (per
   * `destructiveMode`, default `'post'`) for `destructiveComponents`.
   * `undefined` when there are no destructive components — an empty
   * destructive manifest is meaningless and SDR's `getPackageXml` would
   * otherwise emit a valid-but-empty `<Package>` element for it.
   */
  readonly destructiveChangesXml: string | undefined;
  readonly destructiveMode: DestructiveMode;
}

function destructiveChangesTypeOf(mode: DestructiveMode): DestructiveChangesType {
  return mode === 'pre' ? DestructiveChangesType.PRE : DestructiveChangesType.POST;
}

/**
 * Builds a file-less, identity-only `SourceComponent` for manifest/
 * destructive-changes generation — see the module doc for why this (not a
 * plain `{fullName, type}` literal) is required for `ComponentSet` to build
 * correct manifests once destructive members are involved. Exported
 * (additive) so `deploy/executor.ts` can use the exact same construction
 * for the destructive members it adds to a live deploy `ComponentSet` —
 * the same SDR quirk applies there for the same reason.
 */
export function virtualComponent(key: ComponentKey, registry: RegistryAccess): SourceComponent {
  return SourceComponent.createVirtualComponent({ name: key.fullName, type: registry.getTypeByName(key.type) });
}

/**
 * Generates `package.xml` and (optionally) `destructiveChangesPre.xml` /
 * `destructiveChangesPost.xml` via SDR's `ComponentSet.getPackageXml()` —
 * per the task brief, hand-rolling this XML is explicitly out of bounds.
 * Both manifests are built from ONE `ComponentSet` (regular members added
 * plain, destructive members added with a `DestructiveChangesType`), which
 * is the API SDR itself expects — `getPackageXml(indentation,
 * destructiveType)` reads from the same set's `destructiveChangesPre`/
 * `destructiveChangesPost` maps rather than a second, separate set.
 *
 * Members are added as real (virtual, file-less) `SourceComponent`
 * instances via `SourceComponent.createVirtualComponent`, not plain
 * `{fullName, type}` identity literals. This matters: `ComponentSet`'s
 * internal manifest-building (`add()`/`getObject()`) only populates its
 * `manifestComponents`/`destructiveComponents` maps correctly for real
 * `SourceComponent` instances — a plain identity object added without a
 * `SourceComponent` silently gets skipped for those maps once ANY
 * destructive member is present in the same set, which would leak
 * destructive members into the regular `package.xml` (or vice versa).
 * `createVirtualComponent` needs no real files for this — package.xml
 * generation only needs correct type/fullName identity, not content.
 */
export async function generatePackageXml(params: GeneratePackageXmlParams): Promise<GeneratedPackageXml> {
  const registry = params.registry ?? new RegistryAccess();
  const destructiveMode = params.destructiveMode ?? 'post';

  const cs = new ComponentSet([], registry);
  if (params.apiVersion) cs.apiVersion = params.apiVersion;

  for (const key of params.components) {
    cs.add(virtualComponent(key, registry));
  }
  for (const key of params.destructiveComponents) {
    cs.add(virtualComponent(key, registry), destructiveChangesTypeOf(destructiveMode));
  }

  const packageXml = await cs.getPackageXml(4);
  const destructiveChangesXml =
    params.destructiveComponents.length > 0 ? await cs.getPackageXml(4, destructiveChangesTypeOf(destructiveMode)) : undefined;

  return { packageXml, destructiveChangesXml, destructiveMode };
}
