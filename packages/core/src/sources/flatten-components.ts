import type { SourceComponent } from '@salesforce/source-deploy-retrieve';

/** Depth-first flatten of resolved components and their decomposed children (e.g. CustomObject -> CustomField). Shared by `SfdxProjectSource` and `GitRefSource`, both of which resolve via SDR's `MetadataResolver`. */
export function flattenComponents(components: SourceComponent[]): SourceComponent[] {
  const out: SourceComponent[] = [];
  for (const component of components) {
    out.push(component);
    const children = component.getChildren();
    if (children.length > 0) out.push(...flattenComponents(children));
  }
  return out;
}

/** Every file belonging to a component: its metadata XML plus all content files (not including children's — callers that want the full subtree should flatten first and call this per component). */
export function componentFiles(component: SourceComponent): string[] {
  const files: string[] = [];
  if (component.xml) files.push(component.xml);
  files.push(...component.walkContent());
  return files;
}
